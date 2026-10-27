import { homedir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { onSnapshot } from "firebase/firestore";
import { z } from "zod";
import { KIT_DIR, loadConfig } from "./config.js";
import { lang, LANGUAGE_NAME, t } from "./i18n.js";
import { checkMachine } from "./preflight.js";
import { checkRepo, commitPushAndOpenPr, describeWarning, fetchBranches, findConflicts, findDeployTargets, findExpoApp, mergeBaseIntoBranch, pushBranch, remoteHead, remoteSha, syncLocalBase, commitsAhead, createWorktree, pruneOldWorktrees, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook, protectedMatcher } from "./guard.js";
import { installIfNeeded, logLocalSync, otaMissing, runAction, type Action, type ActionResult } from "./actions.js";
import { materializeAttachments } from "./attachments.js";
import { bitbucketHost, githubHost, type PrHost } from "./hosts.js";
import { refreshKnowledge } from "./knowledge.js";
import { readQuota } from "./quota.js";
import { buildFollowUpPrompt, buildSystemAppend, buildUserPrompt } from "./prompt.js";
import { connect, FEATURE_LEASE_MS, Store, type Feature, type FeatureResult } from "./store.js";

const cfg = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[backcode] ${(err as Error).message}`);
    process.exit(1);
  }
})();
let store: Store;
const isProtected = protectedMatcher(cfg.protectedPaths);

// Entorno mínimo para Claude y sus comandos: sin credenciales de Firebase, GitHub ni cloud.
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
function agentEnv(): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: "backcode-runner" };
  for (const key of ENV_ALLOWLIST) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

// Directorios sensibles que los comandos sandboxeados no pueden leer.
const home = homedir();
const DENY_READ = [
  KIT_DIR, // contiene el .env con tu runner key
  ...[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".config/gh", ".config/gcloud", ".claude.json", "Library/Keychains"].map((p) => join(home, p)),
];

let current: { id: string; abort: AbortController } | null = null;
let refreshQuota: () => Promise<void> = async () => undefined;
/** GitHub o Bitbucket según el repo; sin él solo se sube la rama. Se decide al arrancar (checkRepo). */
let prHost: PrHost | undefined;
let pending: string[] = [];
let busy = false;
let stopping = false;

type RunOutcome = { status: "done" | "failed" | "waiting"; result: FeatureResult; sessionId?: string };

async function runFeature(id: string, feature: Feature): Promise<RunOutcome> {
  const acceptanceError = await store.verifyAcceptance(id, feature);
  if (acceptanceError) return { status: "failed", result: { error: acceptanceError } };

  const project = await store.projectInfo();
  // Con sesión previa, es una conversación: se continúa la misma sesión en el mismo worktree y rama.
  const resuming = !!feature.sessionId;
  const wt = await createWorktree({ repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir, remote: cfg.remote, baseBranch: cfg.baseBranch, featureId: id, branch: feature.branch!, resume: resuming });
  await store.event(id, "start", resuming ? t("run.resume", { branch: wt.branch }) : t("run.worktree", { branch: wt.branch, base: `${cfg.remote}/${cfg.baseBranch}` }));
  // Al retomar, la rama se pone al día con la base: sin conflictos se sube ya (el PR se actualiza); con conflictos,
  // Claude los resuelve en esta vuelta y el commit de open_pull_request cierra el merge.
  let conflicts: string[] = [];
  if (resuming) {
    const sync = await mergeBaseIntoBranch(wt.path, cfg.remote, cfg.baseBranch).catch((err: Error) => {
      void store.event(id, "say", t("run.syncFail", { base: cfg.baseBranch, error: err.message }));
      return null;
    });
    if (sync?.status === "merged") {
      await pushBranch(wt.path, cfg.remote, wt.branch).catch(() => undefined);
      await store.event(id, "start", t("run.synced", { base: `${cfg.remote}/${cfg.baseBranch}` }));
      await store.setConflicts(id, []).catch(() => undefined);
    } else if (sync?.status === "uptodate") {
      // Ya contiene la base: si quedaba una marca de conflictos de antes, sobra.
      if (feature.conflicts?.length) await store.setConflicts(id, []).catch(() => undefined);
    } else if (sync?.status === "conflicts") {
      conflicts = sync.files;
      await store.event(id, "start", t("run.conflicts", { base: `${cfg.remote}/${cfg.baseBranch}`, files: conflicts.join(", ") }));
    }
  }
  const attachments = await materializeAttachments(store, cfg.projectId, wt.path, feature.attachments ?? []);
  if (attachments.length && !resuming) await store.event(id, "start", t("run.attachments", { n: attachments.length }));

  const previousPr = feature.result?.prUrl;
  let prUrl: string | undefined; // PR abierto o actualizado en esta vuelta
  let question: string | undefined; // pregunta de Claude (ask_user)
  const prServer = createSdkMcpServer({
    name: "backcode",
    version: "1.0.0",
    tools: [
      tool(
        "open_pull_request",
        "Commit all changes in the worktree to the feature branch, push it and open a draft pull request. Call exactly once when the work is complete.",
        { title: z.string().min(5).max(120), body: z.string().min(20).max(20_000) },
        async ({ title, body }) => {
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
          if (prUrl) return fail(t("pr.already", { url: prUrl }));

          const files = await stageAll(wt.path);
          if (files.length === 0 && (await commitsAhead(wt.path, cfg.remote, cfg.baseBranch)) === 0) {
            return fail(t("pr.empty"));
          }
          const blocked = files.filter(isProtected);
          if (blocked.length) return fail(t("pr.protected", { files: blocked.join(", ") }));
          const secrets = await scanStagedForSecrets(wt.path);
          if (secrets.length) return fail(t("pr.secrets", { list: secrets.join("; ") }));

          const footer = `\n\n---\n${t("pr.footer", { id, n: files.length, branch: wt.branch })}\n\n${t("pr.generated")}`;
          try {
            prUrl = await commitPushAndOpenPr({ worktree: wt.path, remote: cfg.remote, baseBranch: cfg.baseBranch, branch: wt.branch, title, body: body + footer, featureId: id, host: prHost });
            // Si la rama tenía conflictos con la base, ya están resueltos y subidos: se quita la marca (y el botón de
            // mergear vuelve a aparecer) sin esperar a la comprobación periódica.
            if (conflicts.length || feature.conflicts?.length) await store.setConflicts(id, []).catch(() => undefined);
          } catch (err) {
            await store.event(id, "error", `open_pull_request: ${String(err)}`);
            return fail(t("pr.failed", { error: String(err).slice(0, 500) }));
          }
          await store.event(id, "pr", prUrl);
          const what = t(cfg.pullRequest === "push-only" ? "pr.pushOnly" : "pr.draft");
          return { content: [{ type: "text" as const, text: `${what}: ${prUrl}` }] };
        },
      ),
      tool(
        "ask_user",
        "Ask the person who accepted this task a blocking clarification question. They answer in the app and this same session continues with their reply. After calling it, end your turn without further changes.",
        { question: z.string().min(5).max(2000) },
        async ({ question: q }) => {
          if (question) return { content: [{ type: "text" as const, text: t("ask.pending") }], isError: true };
          question = q;
          await store.postMessage(id, "question", q);
          await store.event(id, "question", q.slice(0, 300));
          return { content: [{ type: "text" as const, text: t("ask.sent") }] };
        },
      ),
    ],
  });

  const abort = new AbortController();
  current = { id, abort };
  const timeout = setTimeout(() => abort.abort(), cfg.timeoutMinutes * 60_000);
  const lease = setInterval(() => store.extendLease(id).catch(() => undefined), FEATURE_LEASE_MS / 3);

  let result: FeatureResult = { branch: wt.branch, prUrl: previousPr };
  let sessionId = feature.sessionId;
  try {
    const prompt = resuming
      ? buildFollowUpPrompt(await store.thread(id).then((t) => t.slice(t.map((m) => m.author).lastIndexOf("claude") + 1).filter((m) => m.author === "user")), !!previousPr, { base: cfg.baseBranch, files: conflicts })
      : buildUserPrompt(id, feature, attachments);
    const model = modelFor(feature, cfg.model);
    if (model) await store.event(id, "say", t("run.model", { model }));
    const messages = query({
      prompt,
      options: {
        resume: feature.sessionId,
        cwd: wt.path,
        model,
        abortController: abort,
        env: agentEnv(),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildSystemAppend({ projectName: project.name, projectContext: project.context, worktree: wt.path, branch: wt.branch, baseBranch: cfg.baseBranch, remote: cfg.remote, language: LANGUAGE_NAME[lang()] }),
        },
        // No cargamos settings de usuario ni del repo: permisos y hooks los define solo este runner.
        settingSources: [],
        // dontAsk: todo lo que no esté en allowedTools se deniega sin preguntar.
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "TodoWrite", "mcp__backcode__open_pull_request", "mcp__backcode__ask_user"],
        disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task"],
        hooks: { PreToolUse: [{ hooks: [createGuardHook(wt.path, isProtected)] }] },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: cfg.allowedDomains, strictAllowlist: true },
          filesystem: { denyRead: DENY_READ, allowWrite: [wt.path] },
        },
        mcpServers: { backcode: prServer },
        maxTurns: cfg.maxTurns,
        maxBudgetUsd: cfg.maxBudgetUsd,
      },
    });

    for await (const msg of messages) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            // Lo que Claude va contando ("Voy a…"): da contexto a la actividad.
            await store.event(id, "say", block.text.trim().replace(/\n{3,}/g, "\n\n").slice(0, 1000));
          } else if (block.type === "tool_use") {
            await store.event(id, "tool", describeTool(block.name, block.input as Record<string, unknown>, wt.path));
          }
        }
      } else if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
      } else if (msg.type === "result") {
        sessionId = msg.session_id;
        const models = Object.values(msg.modelUsage ?? {});
        result = {
          ...result,
          model,
          models: Object.fromEntries(
            Object.entries(msg.modelUsage ?? {}).map(([name, m]) => [name, { costUsd: m.costUSD, tokens: m.inputTokens + m.outputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens }]),
          ),
          costUsd: msg.total_cost_usd,
          turns: msg.num_turns,
          tokens: {
            input: models.reduce((n, m) => n + m.inputTokens, 0),
            output: models.reduce((n, m) => n + m.outputTokens, 0),
            cache: models.reduce((n, m) => n + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0),
          },
          summary: msg.subtype === "success" ? msg.result.slice(0, 4000) : undefined,
          error: msg.subtype === "success" ? undefined : `${msg.subtype}: ${msg.errors.join("; ").slice(0, 2000)}`,
        };
      }
    }
  } catch (err) {
    result.error = abort.signal.aborted ? (stopping ? t("run.stopped") : t("run.timeout", { min: cfg.timeoutMinutes })) : String(err);
  } finally {
    clearTimeout(timeout);
    clearInterval(lease);
    current = null;
    // El worktree se conserva: la conversación puede continuar (se limpia tras días sin uso).
  }

  // El resumen de cada vuelta queda en el hilo; si preguntó, la pregunta ya está publicada.
  if (!question && result.summary) await store.postMessage(id, "summary", result.summary).catch(() => undefined);
  if (question && !result.error) return { status: "waiting", result: { ...result, error: undefined }, sessionId };
  if (prUrl) return { status: "done", result: { ...result, prUrl, error: undefined }, sessionId };
  // Continuación sin cambios nuevos (p. ej. solo respondió una duda): sigue con el PR que ya había.
  if (resuming && previousPr && !result.error) return { status: "done", result: { ...result, prUrl: previousPr }, sessionId };
  return { status: "failed", result: { ...result, error: result.error ?? t("run.noPr") }, sessionId };
}

/** Una línea legible por herramienta para la actividad de la app: "Edit: src/x.ts", "Bash: npm test"… */
function describeTool(name: string, input: Record<string, unknown>, root: string): string {
  const rel = (p: unknown) => String(p ?? "").replace(`${root}/`, "").replace(root, ".");
  // Hasta ~900 caracteres (la app lo muestra plegado y se expande al tocarlo); se conservan los saltos de línea.
  const short = (s: unknown, n = 900) => String(s ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `${name}: ${rel(input.file_path ?? input.notebook_path)}`;
    case "Bash":
      return `Bash: ${input.description ? `${short(input.description, 200)} — ${short(input.command, 700)}` : short(input.command)}`;
    case "Grep":
      return `Grep: ${short(input.pattern, 80)}${input.path ? ` ${t("run.in")} ${rel(input.path)}` : ""}${input.glob ? ` (${short(input.glob, 40)})` : ""}`;
    case "Glob":
      return `Glob: ${short(input.pattern, 100)}`;
    case "TodoWrite": {
      const todos = (input.todos as { content?: string; status?: string }[] | undefined) ?? [];
      const doing = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
      const done = todos.filter((t) => t.status === "completed").length;
      return `Plan: ${done}/${todos.length}${doing?.content ? ` — ${short(doing.content, 120)}` : ""}`;
    }
    default:
      return `${name.replace(/^mcp__backcode__/, "")}${input.title ? `: ${short(input.title)}` : ""}`;
  }
}

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (!stopping && pending.length > 0) {
      const id = pending.shift()!;
      const feature = await store.claim(id);
      if (!feature) continue;
      console.log(`[run] ${id} · ${feature.title}`);
      try {
        const { status, result, sessionId } = await runFeature(id, feature);
        if (stopping && !result.prUrl && status !== "waiting") {
          await store.requeue(id);
        } else {
          await store.finish(id, status, result, sessionId);
          await store.event(id, status, result.prUrl ?? result.error ?? "");
        }
        console.log(`[${status}] ${id} ${result.prUrl ?? result.error ?? ""}`);
        void refreshQuota();
      } catch (err) {
        console.error(`[error] ${id}`, err);
        await store.finish(id, "failed", { error: String(err).slice(0, 2000) });
      }
    }
  } finally {
    busy = false;
  }
}

/** Mensaje claro en la terminal al conectar: qué está pasando y qué hacer ahora. */
function printConnected(projectName: string): void {
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.log(`
${green("✓")} ${bold(t("conn.title", { name: projectName }))}
  ${t("conn.listening")}

  ${bold(t("conn.now"))}
  ${t("conn.step1")}
  ${t("conn.step2")}
  ${t("conn.step3")}

  ${dim(t("conn.footer", { repo: cfg.repoPath, base: `${cfg.remote}/${cfg.baseBranch}` }))}
`);
}

/**
 * Modelo de una tarea: el elegido en la app, o "auto" (Por defecto) = BACKCODE_MODEL o, si está vacío, el modelo por
 * defecto de la Claude Code de quien la ejecuta (con Max, Opus). La sugerencia de la IA solo es una recomendación.
 */
const MODEL_IDS: Record<string, string> = { fable: "claude-fable-5-1" };
function modelFor(feature: Feature, fallback?: string): string | undefined {
  if (feature.model && feature.model !== "auto") return MODEL_IDS[feature.model] ?? feature.model;
  return fallback;
}

async function main(): Promise<void> {
  // Sin el Claude Code del SDK no se puede ejecutar nada; Node antiguo, tampoco.
  if (!(await checkMachine({ verbose: false }))) process.exit(1);
  const { db, storage, uid } = await connect(cfg);
  store = new Store(db, storage, cfg, uid);
  // Desde aquí, el idioma del perfil del usuario en la app (y en vivo si lo cambia).
  const stopLang = await store.watchLang();
  console.log(`[backcode] ${t("main.user", { uid, project: cfg.projectId, repo: cfg.repoPath, base: `${cfg.remote}/${cfg.baseBranch}`, runner: cfg.runnerId })}`);
  // Ajusta rama base y modo de PR al repo real; los avisos se ven en la terminal y en la app.
  const repo = await checkRepo(cfg.repoPath, cfg.remote, cfg.baseBranch, cfg.pullRequest, !!cfg.bitbucket);
  cfg.baseBranch = repo.baseBranch;
  cfg.pullRequest = repo.pullRequest;
  prHost = repo.pullRequest === "github" ? githubHost(cfg.repoPath) : repo.pullRequest === "bitbucket" ? bitbucketHost(repo.remoteUrl, cfg.bitbucket!.email, cfg.bitbucket!.token) : undefined;
  store.warnings = repo.warnings;
  const head = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const expoApp = await findExpoApp(cfg.repoPath, head).catch(() => null);
  // Despliegues que el repo declara (scripts backcode:deploy:*): web, api, scripts… cada uno con su botón en la app.
  const deploys = (await findDeployTargets(cfg.repoPath, head).catch(() => [])).map(({ id, name, dir }) => ({ id, name, dir }));
  store.capabilities = {
    pr: prHost?.kind ?? null,
    expo: !!expoApp,
    deploys,
    ota: expoApp?.ota ? { channels: expoApp.channels, via: expoApp.ota } : null,
    // Builds locales para testers: con perfil `production` en eas.json; iOS solo si el runner corre en un Mac.
    build: expoApp?.buildProfiles.includes("production") ? { platforms: process.platform === "darwin" ? ["ios", "android"] : ["android"] } : null,
  };
  if (expoApp && !expoApp.ota) console.warn(`\x1b[33m⚠ ${t("main.otaOff", { reason: otaMissing() })}\x1b[0m`);
  for (const w of repo.warnings) console.warn(`\x1b[33m⚠ ${describeWarning(w)}\x1b[0m`);
  const releaseLock = await store.acquireLock();
  await store.recoverOrphans();
  await pruneOldWorktrees(cfg.repoPath, cfg.worktreesDir, 14).catch(() => undefined);
  // Al arrancar, tu copia local de la rama base se pone al día si es seguro (p. ej. tras merges hechos por otros).
  const local = await syncLocalBase(cfg.repoPath, cfg.remote, cfg.baseBranch).catch((e: Error) => ({ status: "skipped" as const, reason: e.message, changed: [] as string[] }));
  logLocalSync(cfg, local);
  if (local.status === "updated") await installIfNeeded(cfg.repoPath, local.changed ?? []);

  const project = await store.projectInfo();
  printConnected(project.name);

  // Mapa del repo para la IA que prepara los encargos: al arrancar y cada 6 h, sin bloquear la cola.
  const knowledgeAbort = new AbortController();
  const learn = () =>
    refreshKnowledge(cfg, store, agentEnv(), knowledgeAbort.signal).catch((err) => console.warn(`[knowledge] ${(err as Error).message}`));
  void learn();
  const knowledgeTimer = setInterval(learn, 6 * 60 * 60_000);

  // PR abiertos, cada 5 min: si ya se mergearon fuera de la app se marcan como mergeados; si no, se mira si chocan con
  // la rama base (solo cuando cambia alguna de las dos) y se marca en la tarea, para verlo antes de mergear.
  const checked = new Map<string, string>();
  const checkConflicts = async () => {
    for (const f of await store.myOpenPrs().catch(() => [])) {
      if (current?.id === f.id) continue; // se está ejecutando
      // ¿Se mergeó a mano en GitHub/Bitbucket? Se marca como mergeada (y la próxima OTA la marcará desplegada).
      if (prHost && f.prUrl?.startsWith("https://")) {
        const pr = await prHost.prState(f.prUrl).catch(() => null);
        if (pr?.state === "merged") {
          await store.markMerged(f.id, pr.sha).catch((err) => console.warn(`[merge] ${(err as Error).message}`));
          await store.setConflicts(f.id, []).catch(() => undefined);
          console.log(`[backcode] ${t("main.mergedOutside", { id: f.id })}`);
          continue;
        }
        if (pr?.state === "closed") continue; // cerrado sin mergear: nada que vigilar
      }
      if (!(await fetchBranches(cfg.repoPath, cfg.remote, cfg.baseBranch, f.branch).then(() => true, () => false))) continue;
      const key = `${await remoteSha(cfg.repoPath, cfg.remote, cfg.baseBranch)}:${await remoteSha(cfg.repoPath, cfg.remote, f.branch)}`;
      if (checked.get(f.id) === key) continue;
      const files = await findConflicts(cfg.repoPath, cfg.worktreesDir, cfg.remote, cfg.baseBranch, f.branch).catch(() => null);
      if (files === null) continue;
      checked.set(f.id, key);
      if (files.join("\n") !== f.conflicts.join("\n")) {
        await store.setConflicts(f.id, files).catch(() => undefined);
        if (files.length) console.warn(`\x1b[33m⚠ ${t("main.clash", { id: f.id, base: cfg.baseBranch, files: files.join(", ") })}\x1b[0m`);
      }
    }
  };
  void checkConflicts();
  const conflictsTimer = setInterval(() => void checkConflicts(), 5 * 60_000);

  // Cuota del plan para el panel "Uso del equipo": al arrancar, tras cada tarea, cada 5 min y cuando alguien pulsa ↻
  // en la app. Leerla no llama al modelo ni consume. Nunca dos lecturas a la vez ni más de una cada 15 s.
  let quotaBusy = false;
  let quotaAt = 0;
  refreshQuota = async () => {
    if (quotaBusy || Date.now() - quotaAt < 15_000) return;
    quotaBusy = true;
    try {
      const quota = await readQuota(agentEnv());
      quotaAt = Date.now();
      if (quota) await store.saveQuota(quota).catch((err) => console.warn(`[quota] ${(err as Error).message}`));
    } finally {
      quotaBusy = false;
    }
  };
  void refreshQuota();
  const quotaTimer = setInterval(() => void refreshQuota(), 5 * 60_000);
  const stopQuotaRequests = await store.watchQuotaRequests(() => void refreshQuota()).catch(() => () => undefined);

  // Solo las tareas que este usuario aceptó en este proyecto, por prioridad y orden de aceptación.
  const unsubscribe = onSnapshot(
    store.myQueue(),
    (snap) => {
      pending = snap.docs
        .map((d) => ({ id: d.id, priority: (d.get("priority") as number) ?? 0, at: d.get("acceptedAt")?.toMillis?.() ?? 0 }))
        .sort((a, b) => a.priority - b.priority || a.at - b.at)
        .map((d) => d.id);
      if (pending.length) console.log(`[queue] ${t("main.queue", { n: pending.length })}`);
      void drain();
    },
    (err) => {
      console.error("[snapshot] error:", err.message);
      process.exit(1);
    },
  );

  // Acciones pedidas desde la app por este usuario (mergear PR, publicar OTA), de una en una.
  let actionsBusy = false;
  let pendingActions: string[] = [];
  const drainActions = async () => {
    if (actionsBusy) return;
    actionsBusy = true;
    try {
      while (!stopping && pendingActions.length) {
        const id = pendingActions.shift()!;
        const action = await store.claimAction(id);
        if (!action) continue;
        console.log(`[action] ${String(action.type)} ${String(action.featureId ?? action.channel ?? action.target ?? (Array.isArray(action.platforms) ? `${action.platforms.join("+")} ${String(action.version)}` : ""))}`);
        const { ok, result } = await runAction(cfg, store, prHost, action as unknown as Action).catch((err): { ok: boolean; result: ActionResult } => ({ ok: false, result: { error: String((err as Error).message ?? err).slice(0, 1500) } }));
        await store.finishAction(id, ok, result as Record<string, unknown>);
        console.log(`[action] ${t(ok ? "main.actionDone" : "main.actionFailed")}: ${result.url ?? result.error ?? ""}`);
      }
    } finally {
      actionsBusy = false;
    }
  };
  const unsubscribeActions = onSnapshot(store.myActions(), (snap) => {
    pendingActions = snap.docs.map((d) => d.id);
    void drainActions();
  });

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[backcode] ${t("main.stopping")}`);
    unsubscribe();
    stopLang();
    unsubscribeActions();
    clearInterval(knowledgeTimer);
    clearInterval(quotaTimer);
    clearInterval(conflictsTimer);
    stopQuotaRequests();
    knowledgeAbort.abort();
    current?.abort.abort();
    while (busy) await new Promise((r) => setTimeout(r, 200));
    await releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[backcode] ${t("main.fatal")}`, err.message ?? err);
  if (/runner key/i.test(String(err.message ?? err)) && cfg.emulators) {
    console.error(t("main.emu1"));
    console.error(t("main.emu2"));
  } else if (/runner key/i.test(String(err.message ?? err))) {
    console.error(t("main.key1"));
    console.error(t("main.key2"));
  }
  process.exit(1);
});
