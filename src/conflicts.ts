import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActionResult } from "./actions.js";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, git, mergeBaseIntoBranch, removeWorktree, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook } from "./guard.js";
import type { PrHost } from "./hosts.js";
import { LANGUAGE_NAME, lang, t } from "./i18n.js";
import { claudeExecutable } from "./preflight.js";
import type { Store } from "./store.js";

// «Arreglar con Claude» (acción fixConflicts): la rama del PR de una tarea choca con la principal y no hay una sesión
// que retomar (o quien la pide no es quien la ejecuta). Tu runner mezcla la base en una copia aparte de la rama, Claude
// solo edita los ficheros en conflicto (sin Bash ni red) y el runner comprueba que no quedan marcas, commitea y sube.

/** Marcas de conflicto de git que no pueden quedar en ningún fichero. */
const MARKERS = /^(<{7}|>{7})( |$)|^={7}$|^\|{7}( |$)/m;

export const hasMarkers = (text: string) => MARKERS.test(text);

export function fixPrompt(files: string[], base: string, language: string): string {
  return `The branch of this pull request was just merged with the latest ${base} and git left merge conflicts (<<<<<<< / ======= / >>>>>>> markers) in these files:
${files.map((f) => `- ${f}`).join("\n")}

Resolve them:
- Keep BOTH sides: the change of this branch and what arrived from ${base}. Combine them so the result reads as if both changes had been made one after the other. Only drop a side when the other one clearly replaces it.
- Read each file whole before editing it, and remove every conflict marker.
- Edit only these files. Don't refactor, reformat or change anything else.
- When you are done, reply with two or three sentences in ${language} saying how you combined each file.`;
}

export async function fixConflicts(cfg: RunnerConfig, store: Store, host: PrHost | undefined, env: Record<string, string>, signal: AbortSignal, featureId: string): Promise<{ ok: boolean; result: ActionResult }> {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  const { prUrl, branch } = await store.prOf(featureId);
  if (!prUrl?.startsWith("https://") || !branch) return { ok: false, result: { error: t("act.noPr") } };
  const pr = await host.prState(prUrl).catch(() => null);
  if (pr && pr.state !== "open") return { ok: false, result: { error: t("fix.notOpen"), url: prUrl } };

  const { remote, baseBranch } = cfg;
  await git(cfg.repoPath, ["fetch", "--quiet", remote, baseBranch, `+${branch}:refs/remotes/${remote}/${branch}`]);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, `_fix-${featureId}`, `${remote}/${branch}`);
  try {
    const sync = await mergeBaseIntoBranch(path, remote, baseBranch);
    let summary = "";
    if (sync.status === "conflicts") {
      const abort = new AbortController();
      signal.addEventListener("abort", () => abort.abort(), { once: true });
      for await (const msg of query({
        prompt: fixPrompt(sync.files, `${remote}/${baseBranch}`, LANGUAGE_NAME[lang()]),
        options: {
          pathToClaudeCodeExecutable: claudeExecutable(),
          cwd: path,
          model: cfg.model,
          abortController: abort,
          // Solo leer y editar ficheros del worktree: sin Bash ni red. El commit y el push los hace el runner.
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
      if (signal.aborted) throw new Error(t("fix.aborted"));
      const left = sync.files.filter((f) => !existsSync(join(path, f)) || hasMarkers(readFileSync(join(path, f), "utf8")));
      if (left.length) return { ok: false, result: { error: t("fix.unresolved", { files: left.join(", ") }), url: prUrl } };
      await stageAll(path);
      const secrets = await scanStagedForSecrets(path);
      if (secrets.length) return { ok: false, result: { error: t("fix.secrets", { list: secrets.join(", ") }), url: prUrl } };
      await git(path, ["commit", "--no-edit", "--no-verify"]);
    }
    if (sync.status !== "uptodate") {
      // Sin forzar: si alguien subió a la rama mientras tanto, falla y no se pisa nada.
      await git(path, ["push", "--no-verify", remote, `HEAD:refs/heads/${branch}`]);
      await followLocalWorktree(cfg, featureId, branch);
    }
    await store.setConflicts(featureId, []).catch(() => undefined);
    const text = sync.status === "conflicts" ? t("fix.done", { files: sync.files.join(", ") }) : sync.status === "merged" ? t("fix.merged", { base: `${remote}/${baseBranch}` }) : t("fix.uptodate");
    await store.event(featureId, "start", summary ? `${text}\n${summary}`.slice(0, 1000) : text);
    return { ok: true, result: { url: prUrl, log: summary || text } };
  } finally {
    await removeWorktree(cfg.repoPath, path);
  }
}

/**
 * Si este ordenador tiene el worktree de la tarea en esa rama y sin cambios, se pone al día con lo que se acaba de subir:
 * así, al retomarla, no parte de la rama de antes (y su push no choca con el merge).
 */
export async function followLocalWorktree(cfg: RunnerConfig, featureId: string, branch: string): Promise<void> {
  const wt = join(cfg.worktreesDir, featureId);
  if (!existsSync(wt)) return;
  const current = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (current !== branch || (await git(wt, ["status", "--porcelain"]).catch(() => "x"))) return;
  await git(wt, ["fetch", "--quiet", cfg.remote, `+${branch}:refs/remotes/${cfg.remote}/${branch}`]).catch(() => undefined);
  await git(wt, ["merge", "--ff-only", "--quiet", `${cfg.remote}/${branch}`]).catch(() => undefined);
}
