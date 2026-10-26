import { homedir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { onSnapshot } from "firebase/firestore";
import { z } from "zod";
import { KIT_DIR, loadConfig } from "./config.js";
import { checkRepo, commitPushAndOpenPr, describeWarning, commitsAhead, createWorktree, pruneOldWorktrees, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook, protectedMatcher } from "./guard.js";
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
  await store.event(id, "start", resuming ? `Continuando la conversación en ${wt.branch}` : `Worktree ${wt.branch} creado desde ${cfg.remote}/${cfg.baseBranch}`);
  const attachments = await materializeAttachments(store, cfg.projectId, wt.path, feature.attachments ?? []);
  if (attachments.length && !resuming) await store.event(id, "start", `${attachments.length} adjunto(s) disponibles para Claude`);

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
          if (prUrl) return fail(`Ya publicaste los cambios en esta vuelta: ${prUrl}`);

          const files = await stageAll(wt.path);
          if (files.length === 0 && (await commitsAhead(wt.path, cfg.remote, cfg.baseBranch)) === 0) {
            return fail("No hay cambios en el worktree; no se puede abrir un PR vacío.");
          }
          const blocked = files.filter(isProtected);
          if (blocked.length) return fail(`Cambios en rutas protegidas, revértelos antes de abrir el PR: ${blocked.join(", ")}`);
          const secrets = await scanStagedForSecrets(wt.path);
          if (secrets.length) return fail(`Posibles secretos en el diff, elimínalos: ${secrets.join("; ")}`);

          const footer = `\n\n---\nBackcode feature \`${id}\` · ${files.length} fichero(s) · rama \`${wt.branch}\`\n\n🤖 Generado por Backcode runner con [Claude Code](https://claude.com/claude-code)`;
          try {
            prUrl = await commitPushAndOpenPr({ worktree: wt.path, remote: cfg.remote, baseBranch: cfg.baseBranch, branch: wt.branch, title, body: body + footer, featureId: id, host: prHost });
          } catch (err) {
            await store.event(id, "error", `open_pull_request: ${String(err)}`);
            return fail(`No se pudo publicar la rama o abrir el PR: ${String(err).slice(0, 500)}`);
          }
          await store.event(id, "pr", prUrl);
          const what = cfg.pullRequest === "push-only" ? "Rama publicada (este runner está configurado para no abrir PR: es lo esperado, la persona lo abrirá)" : "PR en borrador abierto";
          return { content: [{ type: "text" as const, text: `${what}: ${prUrl}` }] };
        },
      ),
      tool(
        "ask_user",
        "Ask the person who accepted this task a blocking clarification question. They answer in the app and this same session continues with their reply. After calling it, end your turn without further changes.",
        { question: z.string().min(5).max(2000) },
        async ({ question: q }) => {
          if (question) return { content: [{ type: "text" as const, text: "Ya hay una pregunta pendiente; termina tu turno." }], isError: true };
          question = q;
          await store.postMessage(id, "question", q);
          await store.event(id, "question", q.slice(0, 300));
          return { content: [{ type: "text" as const, text: "Pregunta enviada. Termina tu turno ahora sin hacer más cambios; continuarás con la respuesta." }] };
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
      ? buildFollowUpPrompt(await store.thread(id).then((t) => t.slice(t.map((m) => m.author).lastIndexOf("claude") + 1).filter((m) => m.author === "user")), !!previousPr)
      : buildUserPrompt(id, feature, attachments);
    const messages = query({
      prompt,
      options: {
        resume: feature.sessionId,
        cwd: wt.path,
        model: cfg.model,
        abortController: abort,
        env: agentEnv(),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildSystemAppend({ projectName: project.name, projectContext: project.context, worktree: wt.path, branch: wt.branch, baseBranch: cfg.baseBranch, remote: cfg.remote }),
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
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            const detail = String(input.description ?? input.file_path ?? input.pattern ?? input.title ?? "");
            await store.event(id, "tool", `${block.name}${detail ? `: ${detail}` : ""}`);
          }
        }
      } else if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
      } else if (msg.type === "result") {
        sessionId = msg.session_id;
        const models = Object.values(msg.modelUsage ?? {});
        result = {
          ...result,
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
    result.error = abort.signal.aborted ? (stopping ? "runner detenido" : `Timeout de ${cfg.timeoutMinutes} min`) : String(err);
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
  return { status: "failed", result: { ...result, error: result.error ?? "Claude terminó sin abrir un PR (ver resumen)" }, sessionId };
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
${green("✓")} ${bold(`Conectado a Backcode · proyecto «${projectName}»`)}
  Escuchando las tareas que aceptes en la app. En la app ya verás "Conectado".

  ${bold("Y ahora:")}
  1. Propón una idea o acepta una tarea del backlog desde la app.
  2. Aquí verás a Claude trabajar; en la app, el progreso en vivo y el PR al acabar.
  3. Si Claude tiene una duda, te llegará la pregunta a la app.

  ${dim(`Repo: ${cfg.repoPath} · base ${cfg.remote}/${cfg.baseBranch} · Ctrl+C para parar (las tareas en curso vuelven a la cola)`)}
`);
}

async function main(): Promise<void> {
  const { db, storage, uid } = await connect(cfg);
  store = new Store(db, storage, cfg, uid);
  console.log(`[backcode] usuario ${uid} · proyecto ${cfg.projectId} · repo ${cfg.repoPath} · base ${cfg.remote}/${cfg.baseBranch} · runner ${cfg.runnerId}`);
  // Ajusta rama base y modo de PR al repo real; los avisos se ven en la terminal y en la app.
  const repo = await checkRepo(cfg.repoPath, cfg.remote, cfg.baseBranch, cfg.pullRequest, !!cfg.bitbucket);
  cfg.baseBranch = repo.baseBranch;
  cfg.pullRequest = repo.pullRequest;
  prHost = repo.pullRequest === "github" ? githubHost(cfg.repoPath) : repo.pullRequest === "bitbucket" ? bitbucketHost(repo.remoteUrl, cfg.bitbucket!.email, cfg.bitbucket!.token) : undefined;
  store.warnings = repo.warnings;
  for (const w of repo.warnings) console.warn(`\x1b[33m⚠ ${describeWarning(w)}\x1b[0m`);
  const releaseLock = await store.acquireLock();
  await store.recoverOrphans();
  await pruneOldWorktrees(cfg.repoPath, cfg.worktreesDir, 14).catch(() => undefined);

  const project = await store.projectInfo();
  printConnected(project.name);

  // Mapa del repo para la IA que prepara los encargos: al arrancar y cada 6 h, sin bloquear la cola.
  const knowledgeAbort = new AbortController();
  const learn = () =>
    refreshKnowledge(cfg, store, agentEnv(), knowledgeAbort.signal).catch((err) => console.warn(`[knowledge] ${(err as Error).message}`));
  void learn();
  const knowledgeTimer = setInterval(learn, 6 * 60 * 60_000);

  // Cuota del plan para el panel "Uso del equipo": al arrancar, tras cada tarea y cada 30 min.
  refreshQuota = async () => {
    const quota = await readQuota(agentEnv());
    if (quota) await store.saveQuota(quota).catch((err) => console.warn(`[quota] ${(err as Error).message}`));
  };
  void refreshQuota();
  const quotaTimer = setInterval(() => void refreshQuota(), 30 * 60_000);

  // Solo las tareas que este usuario aceptó en este proyecto, por prioridad y orden de aceptación.
  const unsubscribe = onSnapshot(
    store.myQueue(),
    (snap) => {
      pending = snap.docs
        .map((d) => ({ id: d.id, priority: (d.get("priority") as number) ?? 0, at: d.get("acceptedAt")?.toMillis?.() ?? 0 }))
        .sort((a, b) => a.priority - b.priority || a.at - b.at)
        .map((d) => d.id);
      if (pending.length) console.log(`[queue] ${pending.length} pendiente(s)`);
      void drain();
    },
    (err) => {
      console.error("[snapshot] error:", err.message);
      process.exit(1);
    },
  );

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[backcode] parando…");
    unsubscribe();
    clearInterval(knowledgeTimer);
    clearInterval(quotaTimer);
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
  console.error("[backcode] error fatal:", err.message ?? err);
  process.exit(1);
});
