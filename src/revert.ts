import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActionResult } from "./actions.js";
import type { RunnerConfig } from "./config.js";
import { hasMarkers } from "./conflicts.js";
import { taskBase } from "./environments.js";
import { createDetachedWorktree, git, isAncestor, removeWorktree, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook } from "./guard.js";
import type { PrHost } from "./hosts.js";
import { LANGUAGE_NAME, lang, t } from "./i18n.js";
import { claudeExecutable } from "./preflight.js";
import type { RevertInfo, Store } from "./store.js";

// «Reverteix» (acciones revertCheck y revert): deshacer el PR de una tarea ya mergeada con un PR normal. Tu runner crea
// una rama nueva desde la base, hace `git revert` del commit del merge/squash, la sube (nunca a la base ni forzando) y
// abre el PR de revert, que sigue la revisión habitual. Si choca con cambios posteriores, Claude resuelve los conflictos
// (solo edita ficheros, sin Bash ni red) conservando esos cambios; si no puede, el revert queda fallido con el motivo.

type Outcome = { ok: boolean; result: ActionResult };

/** Como mucho, cuántos ficheros se miran y cuántos PRs posteriores se avisan. */
const MAX_FILES = 500;
const MAX_LATER = 20;

/** Número del PR en el asunto de un commit de la base: squash de GitHub «Título (#12)» o merge «Merge pull request #12». */
export function prNumberOfSubject(subject: string): number | undefined {
  const m = /\(#(\d+)\)\s*$/.exec(subject) ?? /^Merge pull request #(\d+)/.exec(subject) ?? /^Merged in .*\(pull request #(\d+)\)/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

/** Número de un PR por su URL (GitHub /pull/12, Bitbucket /pull-requests/12). */
export function prNumberOfUrl(url?: string): number | undefined {
  const m = /\/pull(?:-requests)?\/(\d+)/.exec(url ?? "");
  return m ? Number(m[1]) : undefined;
}

/** Rama del PR de revert: backcode/revert/<tarea>, con sufijo si ya existe en el remoto (p. ej. de un intento anterior). */
export function revertBranch(featureId: string, taken: boolean, now = Date.now()): string {
  return `backcode/revert/${featureId}${taken ? `-${now.toString(36)}` : ""}`;
}

export function revertTitle(title: string): string {
  return `Revert: ${title}`.slice(0, 250);
}

export function revertBody(info: Pick<RevertInfo, "title" | "prUrl" | "deployed">, sha: string, language: string): string {
  const pr = prNumberOfUrl(info.prUrl);
  const ref = info.prUrl ? `${pr ? `#${pr}` : info.prUrl} (${info.prUrl})` : sha.slice(0, 12);
  const lines = {
    Spanish: [`Revierte ${ref}: «${info.title}».`, `Commit revertido: ${sha}.`, info.deployed ? "La tarea estaba desplegada: el cambio desaparecerá de producción en el próximo despliegue/OTA." : ""],
    Catalan: [`Reverteix ${ref}: «${info.title}».`, `Commit revertit: ${sha}.`, info.deployed ? "La tasca estava desplegada: el canvi desapareixerà de producció al següent desplegament/OTA." : ""],
    English: [`Reverts ${ref}: "${info.title}".`, `Reverted commit: ${sha}.`, info.deployed ? "The task was deployed: the change will disappear from production on the next deploy/OTA." : ""],
  }[language] ?? [];
  return [...lines.filter(Boolean), "", "_Backcode · «Reverteix»_"].join("\n\n").trim();
}

export function revertPrompt(files: string[], sha: string, base: string, language: string): string {
  return `We are reverting commit ${sha} (the merge of an earlier pull request) on top of the latest ${base}. Later commits changed the same lines, so git left revert conflicts (<<<<<<< / ======= / >>>>>>> markers) in these files:
${files.map((f) => `- ${f}`).join("\n")}

Resolve them:
- Undo ONLY what commit ${sha} introduced (run nothing: read it from the conflict sides). Keep every later change that arrived in ${base} after it, even where it touches the same code.
- If a later change builds on the reverted code and cannot be kept without it, keep the later change and leave that part of the reverted code in place.
- Read each file whole before editing it, and remove every conflict marker.
- Edit only these files. Don't refactor, reformat or change anything else.
- When you are done, reply with two or three sentences in ${language} saying how you resolved each file.`;
}

/** El commit del merge/squash del PR de la tarea: el apuntado al mergear o, si no consta, el que da el alojamiento. */
async function mergeSha(info: RevertInfo, host: PrHost | undefined): Promise<string | undefined> {
  if (info.sha && /^[0-9a-f]{7,40}$/.test(info.sha)) return info.sha;
  if (!host || !info.prUrl?.startsWith("https://")) return undefined;
  const pr = await host.prState(info.prUrl).catch(() => null);
  return pr?.state === "merged" && pr.sha && /^[0-9a-f]{7,40}$/.test(pr.sha) ? pr.sha : undefined;
}

/** Ficheros que cambió el commit (respecto a su primer padre: vale para merges y squashes). */
async function changedFiles(repo: string, sha: string): Promise<string[]> {
  return (await git(repo, ["diff", "--name-only", "-z", `${sha}^1`, sha])).split("\0").filter(Boolean);
}

/** Commits de la base posteriores a `sha` que tocan esos ficheros (por la primera línea: uno por PR mergeado). */
export async function laterCommits(repo: string, sha: string, base: string, files: string[]): Promise<{ sha: string; subject: string }[]> {
  if (!files.length) return [];
  const out = await git(repo, ["log", "--first-parent", `--max-count=${MAX_LATER}`, "--format=%H%x09%s", `${sha}..${base}`, "--", ...files.slice(0, MAX_FILES)]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [h, ...rest] = l.split("\t");
      return { sha: h, subject: rest.join("\t") };
    });
}

/** Comprobaciones comunes: hay alojamiento de PRs, la tarea está mergeada y su commit está en la base. */
async function prepare(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string): Promise<{ info: RevertInfo; sha: string; base: string } | { error: string }> {
  if (!host) return { error: t("act.noHostMerge") };
  const info = await store.revertInfo(featureId);
  if (info.status !== "done" || !info.merged) return { error: t("revert.notMerged") };
  const sha = await mergeSha(info, host);
  if (!sha) return { error: t("revert.noSha") };
  const branch = taskBase(cfg.baseBranch);
  await git(cfg.repoPath, ["fetch", "--quiet", cfg.remote, branch]);
  const base = `${cfg.remote}/${branch}`;
  if (!(await isAncestor(cfg.repoPath, sha, base))) return { error: t("revert.notInBase", { sha: sha.slice(0, 12), base }) };
  return { info, sha, base };
}

/** revertCheck: PRs mergeados después que tocan los mismos ficheros (el aviso antes de confirmar). Solo lee. */
export async function revertCheck(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string): Promise<Outcome> {
  const ready = await prepare(cfg, store, host, featureId);
  if ("error" in ready) return { ok: false, result: { error: ready.error } };
  const files = await changedFiles(cfg.repoPath, ready.sha);
  const commits = await laterCommits(cfg.repoPath, ready.sha, ready.base, files);
  const tasks = new Map((await store.mergedFeatures()).map((f) => [f.sha, f.title]));
  const later = commits.map((c) => {
    const number = prNumberOfSubject(c.subject);
    return { sha: c.sha, title: (tasks.get(c.sha) ?? c.subject).slice(0, 200), ...(number ? { number } : {}) };
  });
  return { ok: true, result: { sha: ready.sha, later } };
}

/** revert: rama nueva desde la base, `git revert` del commit del PR, push sin forzar y PR de revert. */
export async function revertPr(cfg: RunnerConfig, store: Store, host: PrHost | undefined, env: Record<string, string>, signal: AbortSignal, featureId: string, actionId: string): Promise<Outcome> {
  const ready = await prepare(cfg, store, host, featureId);
  if ("error" in ready) return { ok: false, result: { error: ready.error } };
  if (!(await store.startRevert(featureId, actionId))) return { ok: false, result: { error: t("revert.already") } };
  try {
    const done = await doRevert(cfg, host!, env, signal, featureId, ready);
    await store.setRevert(featureId, { state: "open", actionId, prUrl: done.prUrl, branch: done.branch });
    const text = done.files.length ? t("revert.doneConflicts", { url: done.prUrl, files: done.files.join(", ") }) : t("revert.done", { url: done.prUrl });
    await store.event(featureId, "start", done.summary ? `${text}\n${done.summary}` : text).catch(() => undefined);
    return { ok: true, result: { url: done.prUrl, log: done.summary || text } };
  } catch (err) {
    const error = String((err as Error).message ?? err).slice(0, 1500);
    await store.setRevert(featureId, { state: "failed", actionId, error }).catch(() => undefined);
    return { ok: false, result: { error } };
  }
}

async function doRevert(
  cfg: RunnerConfig,
  host: PrHost,
  env: Record<string, string>,
  signal: AbortSignal,
  featureId: string,
  { info, sha, base }: { info: RevertInfo; sha: string; base: string },
): Promise<{ prUrl: string; branch: string; files: string[]; summary: string }> {
  const taken = !!(await git(cfg.repoPath, ["ls-remote", "--heads", cfg.remote, revertBranch(featureId, false)]).catch(() => ""));
  const branch = revertBranch(featureId, taken);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, `_revert-${featureId}`, base);
  try {
    const parents = (await git(path, ["rev-list", "--parents", "-n", "1", sha])).split(" ").length - 1;
    const ok = await git(path, ["revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), sha]).then(
      () => true,
      () => false,
    );
    let files: string[] = [];
    let summary = "";
    if (!ok) {
      files = (await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
      if (!files.length) throw new Error(t("revert.gitFail", { sha: sha.slice(0, 12) }));
      summary = await resolveWithClaude(cfg, env, signal, path, files, sha, base);
      const left = files.filter((f) => existsSync(join(path, f)) && hasMarkers(readFileSync(join(path, f), "utf8")));
      if (left.length) throw new Error(t("revert.unresolved", { files: left.join(", ") }));
      await stageAll(path);
      const secrets = await scanStagedForSecrets(path);
      if (secrets.length) throw new Error(t("fix.secrets", { list: secrets.join(", ") }));
      await git(path, ["commit", "--no-edit", "--no-verify"]);
    }
    // Rama nueva y sin forzar: nunca se escribe en la base ni se pisa nada.
    await git(path, ["push", "--no-verify", cfg.remote, `HEAD:refs/heads/${branch}`]);
    const prUrl = await host.openOrUpdatePr({ cwd: path, branch, base: base.slice(cfg.remote.length + 1), title: revertTitle(info.title), body: revertBody(info, sha, LANGUAGE_NAME[lang()]) });
    return { prUrl, branch, files, summary };
  } finally {
    await removeWorktree(cfg.repoPath, path);
  }
}

async function resolveWithClaude(cfg: RunnerConfig, env: Record<string, string>, signal: AbortSignal, path: string, files: string[], sha: string, base: string): Promise<string> {
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  let summary = "";
  for await (const msg of query({
    prompt: revertPrompt(files, sha, base, LANGUAGE_NAME[lang()]),
    options: {
      pathToClaudeCodeExecutable: claudeExecutable(),
      cwd: path,
      model: cfg.model,
      abortController: abort,
      // Como «Arreglar con Claude»: solo leer y editar ficheros del worktree. El commit y el push los hace el runner.
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write"],
      disallowedTools: ["Bash", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"],
      hooks: { PreToolUse: [{ hooks: [createGuardHook(path, () => false)] }] },
      settingSources: [],
      maxTurns: 60,
      maxBudgetUsd: cfg.maxBudgetUsd,
      env,
    },
  })) {
    if (msg.type === "result" && msg.subtype === "success") summary = msg.result.trim();
  }
  if (signal.aborted) throw new Error(t("revert.aborted"));
  return summary;
}
