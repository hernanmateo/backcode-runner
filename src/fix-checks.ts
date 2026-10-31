import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActionResult } from "./actions.js";
import { failingLog } from "./check-logs.js";
import { followLocalWorktree } from "./conflicts.js";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, git, removeWorktree, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook } from "./guard.js";
import type { PrHost } from "./hosts.js";
import { LANGUAGE_NAME, lang, t } from "./i18n.js";
import { claudeExecutable } from "./preflight.js";
import type { Store } from "./store.js";

// «Devolver a Claude Code» un PR con los checks en rojo (acción fixChecks), cuando no hay una sesión que retomar (tareas
// hechas en la terminal, o quien lo pide no es quien la ejecuta). Tu runner saca la rama del PR en una copia aparte y
// Claude, con el log de los checks que fallan, lo arregla y ejecuta los tests en el sandbox, como en una tarea. El commit y
// el push (sin forzar) los hace el runner.

export function fixChecksPrompt(failing: string[], log: string, language: string): string {
  return `The CI checks of this pull request are failing, so it can't be merged:
${failing.map((c) => `- ${c}`).join("\n")}
${log ? `\nEnd of the failing jobs' log:\n<ci_log>\n${log}\n</ci_log>\n` : ""}
Fix the code so these checks pass:
- Find the cause in the log (and in the CI workflow, which you can read but not change) and fix it in the code or the tests. Don't skip, disable or weaken tests or checks to make them pass.
- Run the same commands locally (tests, linter, type checker) and make sure they pass before finishing. If a check needs something unavailable here (secrets, network), say so instead of guessing.
- Keep the change minimal: don't refactor or touch anything unrelated.
- When you are done, reply with two or three sentences in ${language} saying what was failing and how you fixed it.`;
}

export async function fixChecks(
  cfg: RunnerConfig,
  store: Store,
  host: PrHost | undefined,
  agent: { env: Record<string, string>; isProtected: (path: string) => boolean; denyRead: string[] },
  signal: AbortSignal,
  featureId: string,
): Promise<{ ok: boolean; result: ActionResult }> {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  const { prUrl, branch } = await store.prOf(featureId);
  if (!prUrl?.startsWith("https://") || !branch) return { ok: false, result: { error: t("act.noPr") } };
  const pr = await host.prState(prUrl).catch(() => null);
  if (pr && pr.state !== "open") return { ok: false, result: { error: t("checksFix.notOpen"), url: prUrl } };
  const checks = await host.prChecks(prUrl);
  if (checks.state !== "failing") return { ok: false, result: { error: t(checks.state === "pending" ? "checksFix.pending" : "checksFix.notFailing"), url: prUrl } };
  const log = await failingLog(host, prUrl);

  const { remote } = cfg;
  await git(cfg.repoPath, ["fetch", "--quiet", remote, `+${branch}:refs/remotes/${remote}/${branch}`]);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, `_checks-${featureId}`, `${remote}/${branch}`);
  try {
    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    let summary = "";
    for await (const msg of query({
      prompt: fixChecksPrompt(checks.pending, log, LANGUAGE_NAME[lang()]),
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
        cwd: path,
        model: cfg.model,
        abortController: abort,
        env: agent.env,
        // Como en una tarea: editar y ejecutar comandos en el sandbox (para correr los tests), con el mismo guard (la CI
        // del repo, entre otros, está protegida). Sin abrir PR: el commit y el push los hace el runner.
        settingSources: [],
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "Bash", "TodoWrite"],
        disallowedTools: ["NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"],
        hooks: { PreToolUse: [{ hooks: [createGuardHook(path, agent.isProtected)] }] },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: cfg.allowedDomains, strictAllowlist: true },
          filesystem: { denyRead: agent.denyRead, allowWrite: [path] },
        },
        maxTurns: cfg.maxTurns,
        maxBudgetUsd: cfg.maxBudgetUsd,
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") summary = msg.result.trim();
    }
    if (signal.aborted) throw new Error(t("checksFix.aborted"));
    // Lo que Claude haya commiteado por su cuenta también cuenta; lo que dejó sin commitear lo commitea el runner.
    await stageAll(path);
    const secrets = await scanStagedForSecrets(path);
    if (secrets.length) return { ok: false, result: { error: t("fix.secrets", { list: secrets.join(", ") }), url: prUrl } };
    if (await git(path, ["status", "--porcelain"])) await git(path, ["commit", "--quiet", "--no-verify", "-m", t("checksFix.commit")]);
    if ((await git(path, ["rev-list", "--count", `${remote}/${branch}..HEAD`])) === "0") {
      return { ok: false, result: { error: t("checksFix.noChanges"), url: prUrl, ...(summary ? { log: summary } : {}) } };
    }
    // Sin forzar: si alguien subió a la rama mientras tanto, falla y no se pisa nada.
    await git(path, ["push", "--no-verify", remote, `HEAD:refs/heads/${branch}`]);
    await followLocalWorktree(cfg, featureId, branch);
    const text = t("checksFix.done");
    await store.event(featureId, "start", summary ? `${text}\n${summary}`.slice(0, 1000) : text);
    return { ok: true, result: { url: prUrl, log: summary || text } };
  } finally {
    await removeWorktree(cfg.repoPath, path);
  }
}
