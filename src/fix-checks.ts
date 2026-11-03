import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActionResult } from "./actions.js";
import { failingLog } from "./check-logs.js";
import { CI_TOOLS, ciGuard, type CiHost, isCiTask } from "./ci-task.js";
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

/**
 * Línea final con la que Claude dice, en un PR de CI, que el fichero de CI está bien y lo que falla es el código de la app
 * (o sus tests): fuera del alcance de la tarea de CI. Con ella y sin cambios, fixChecks devuelve `blocked: "ciAppCode"` y la
 * app ofrece una tarea normal para arreglar el código (en vez de devolverlo a Claude Code en bucle).
 */
export const CI_APP_CODE_MARKER = "CI_FILE_OK: failure is in app code";

/** ¿Ha concluido Claude que el fallo está en el código de la app? Devuelve también su explicación sin la línea marcador. */
export function parseCiAppCode(summary: string): { appCode: boolean; explanation: string } {
  const lines = summary.split("\n");
  const marker = (l: string) => l.trim().replace(/^[`*_\s]+|[`*_.\s]+$/g, "") === CI_APP_CODE_MARKER;
  const appCode = lines.some(marker);
  return { appCode, explanation: lines.filter((l) => !marker(l)).join("\n").trim() };
}

/** Resultado de fixChecks cuando, en un PR de CI, el fallo está en el código de la app (no en el fichero de CI). */
export function ciAppCodeResult(prUrl: string, checks: string[], explanation: string): ActionResult {
  return { error: t("checksFix.ciAppCode"), url: prUrl, checks, blocked: "ciAppCode", ...(explanation ? { log: explanation.slice(0, 2000) } : {}) };
}

export function fixChecksPrompt(failing: string[], log: string, language: string, ciHost?: CiHost): string {
  const header = `The CI checks of this pull request are failing, so it can't be merged:
${failing.map((c) => `- ${c}`).join("\n")}
${log ? `\nEnd of the failing jobs' log:\n<ci_log>\n${log}\n</ci_log>\n` : ""}`;
  const done = `- When you are done, reply with two or three sentences in ${language} saying what was failing and how you fixed it.`;
  if (ciHost) {
    // PR de una tarea de CI: el fallo suele estar en el propio workflow. Mismo alcance que la tarea original.
    const file = ciHost === "github" ? "`.github/workflows/*.yml`" : "`bitbucket-pipelines.yml`";
    return `${header}
This is a Backcode CI pull request: it creates or changes the repository's CI, and the failure is often in the CI file itself. Fix it:
- Find the cause in the log. You may modify ONLY ${file} and, if useful, documentation (\`docs/**/*.md\` or a root \`*.md\`); every other path is blocked by the runner, and so are Bash, reading .env files, credentials and keys.
- Fix the CI so it runs the repository's real commands correctly (wrong install command, runtime version, working directory, missing step…). Never remove, skip, disable or weaken a check to make it pass: no deleting jobs or steps, no \`continue-on-error\`, \`|| true\`, \`allow_failure\`, conditions that skip it, or dropping test/lint/typecheck commands. If the failure is in the application code or tests (not the CI), don't touch them and don't change the CI file either: explain in your reply which checks fail and why, and end your reply with this exact line on its own: \`${CI_APP_CODE_MARKER}\`. Use that line only when the CI file is fine and the project's own code fails its checks; never together with a CI change.
- Reference secrets only by name; never read, print or hardcode a secret value.
- Keep the change minimal. This PR is never merged automatically: a person reviews it and merges it by hand.
${done}`;
  }
  return `${header}
Fix the code so these checks pass:
- Find the cause in the log (and in the CI workflow, which you can read but not change) and fix it in the code or the tests. Don't skip, disable or weaken tests or checks to make them pass.
- Run the same commands locally (tests, linter, type checker) and make sure they pass before finishing. If a check needs something unavailable here (secrets, network), say so instead of guessing.
- Keep the change minimal: don't refactor or touch anything unrelated.
${done}`;
}

/**
 * Alcance del arreglo: como una tarea normal (guard de siempre, con Bash) o, si el PR es de una tarea de CI, con las mismas
 * restricciones que la tarea de CI original (solo el fichero de CI del host y docs, sin Bash ni leer secretos).
 */
export function fixChecksScope(kind: string | undefined, host: CiHost, isProtected: (rel: string) => boolean) {
  if (!isCiTask({ kind })) {
    return { ciHost: undefined, isProtected, denyRead: undefined, allowedTools: ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "Bash", "TodoWrite"], disallowedTools: ["NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"] };
  }
  const ci = ciGuard(host, isProtected);
  return { ciHost: host, isProtected: ci.isProtected, denyRead: ci.denyRead, allowedTools: [...CI_TOOLS], disallowedTools: ["Bash", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"] };
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
  const { prUrl, branch, kind } = await store.prOf(featureId);
  if (!prUrl?.startsWith("https://") || !branch) return { ok: false, result: { error: t("act.noPr") } };
  const pr = await host.prState(prUrl).catch(() => null);
  if (pr && pr.state !== "open") return { ok: false, result: { error: t("checksFix.notOpen"), url: prUrl } };
  const checks = await host.prChecks(prUrl);
  if (checks.state !== "failing") return { ok: false, result: { error: t(checks.state === "pending" ? "checksFix.pending" : "checksFix.notFailing"), url: prUrl } };
  const log = await failingLog(host, prUrl);
  const scope = fixChecksScope(kind, host.kind, agent.isProtected);

  const { remote } = cfg;
  await git(cfg.repoPath, ["fetch", "--quiet", remote, `+${branch}:refs/remotes/${remote}/${branch}`]);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, `_checks-${featureId}`, `${remote}/${branch}`);
  try {
    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    let summary = "";
    for await (const msg of query({
      prompt: fixChecksPrompt(checks.pending, log, LANGUAGE_NAME[lang()], scope.ciHost),
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
        cwd: path,
        model: cfg.model,
        abortController: abort,
        env: agent.env,
        // Como en una tarea: editar y ejecutar comandos en el sandbox (para correr los tests), con el mismo guard (la CI
        // del repo, entre otros, está protegida). Sin abrir PR: el commit y el push los hace el runner. En un PR de una
        // tarea de CI, el alcance de esa tarea: solo su fichero de CI y docs, sin Bash ni leer secretos.
        settingSources: [],
        permissionMode: "dontAsk",
        allowedTools: scope.allowedTools,
        disallowedTools: scope.disallowedTools,
        hooks: { PreToolUse: [{ hooks: [createGuardHook(path, scope.isProtected, scope.denyRead ? { denyRead: scope.denyRead } : {})] }] },
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
      // PR de CI sin cambios y Claude dice que el fichero de CI está bien: falla el código de la app, que la tarea de CI no
      // puede (ni debe) tocar. Motivo propio para que la app ofrezca una tarea normal con los checks y la explicación.
      const ci = scope.ciHost ? parseCiAppCode(summary) : null;
      if (ci?.appCode) return { ok: false, result: ciAppCodeResult(prUrl, checks.pending, ci.explanation) };
      return { ok: false, result: { error: t("checksFix.noChanges"), url: prUrl, ...(summary ? { log: summary } : {}) } };
    }
    // PR de CI: como en open_pull_request de la tarea de CI, nada fuera de su alcance llega a subirse.
    if (scope.ciHost) {
      const changed = (await git(path, ["diff", "--name-only", `${remote}/${branch}`, "HEAD"])).split("\n").filter(Boolean);
      const blocked = changed.filter(scope.isProtected);
      if (blocked.length) return { ok: false, result: { error: t("checksFix.protected", { files: blocked.join(", ") }), url: prUrl } };
    }
    // Sin forzar: si alguien subió a la rama mientras tanto, falla y no se pisa nada.
    await git(path, ["push", "--no-verify", remote, `HEAD:refs/heads/${branch}`]);
    await followLocalWorktree(cfg, featureId, branch);
    const text = t("checksFix.done");
    await store.event(featureId, "start", summary ? `${text}\n${summary}` : text);
    return { ok: true, result: { url: prUrl, log: summary || text } };
  } finally {
    await removeWorktree(cfg.repoPath, path);
  }
}
