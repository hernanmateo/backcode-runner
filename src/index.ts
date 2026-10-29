import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { exitSupervised, RESTART_CODE, SUPERVISED, UPDATE_EVERY_MS, updateIfAvailable } from "./autoupdate.js";
import { join } from "node:path";
import { createSdkMcpServer, query, tool, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { onSnapshot } from "firebase/firestore";
import { z } from "zod";
import { KIT_DIR, loadConfig } from "./config.js";
import { CONFIG_DIR, LOGS_DIR, ownArgs, readState, updateState } from "./paths.js";
import { lang, LANGUAGE_NAME, t } from "./i18n.js";
import { checkMachine, claudeExecutable, installedClaude } from "./preflight.js";
import { followTranscript, startRemoteControl, type RemoteSession } from "./remote.js";
import { checkRepo, commitPushAndOpenPr, publicRepoUrl, describeWarning, fetchBranches, findConflicts, findDeployTargets, findExpoApp, mergeBaseIntoBranch, pushBranch, remoteHead, remoteSha, syncLocalBase, commitsAhead, createWorktree, pruneOldWorktrees, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook, protectedMatcher } from "./guard.js";
import { installIfNeeded, logLocalSync, otaMissing, runAction, type Action, type ActionResult } from "./actions.js";
import { materializeAttachments } from "./attachments.js";
import { bitbucketHost, githubHost, type PrHost } from "./hosts.js";
import { devInstalls, stopDevServer } from "./dev-server.js";
import { installPlatforms, listDevices } from "./devices.js";
import { refreshKnowledge } from "./knowledge.js";
import { readQuota } from "./quota.js";
import { refineIdea } from "./refine.js";
import { machineInfo } from "./machine.js";
import { parseScaffold, runScaffold } from "./scaffold.js";
import { KeepAwake } from "./awake.js";
import { buildAfterRemotePrompt, buildApprovedPlanPrompt, buildFollowUpPrompt, buildLiveMessage, buildPlanFollowUpPrompt, buildPlanPrompt, buildSystemAppend, buildUserPrompt } from "./prompt.js";
import { connect, FEATURE_LEASE_MS, Store, type Feature, type FeatureResult, type LiveControl, type ThreadMessage } from "./store.js";
import { useGhForGit } from "./github.js";
import { loadSavedApiKey } from "./anthropic.js";

// Con `npm start` / `npm run connect` (sin pasar por cli.ts): git con la sesión de GitHub CLI.
useGhForGit();
loadSavedApiKey();

const cfg = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[backcode] ${(err as Error).message}`);
    process.exit(1);
  }
})();
let store: Store;
const awake = new KeepAwake(cfg.keepAwake);
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
  KIT_DIR, // el propio runner
  CONFIG_DIR, // la configuración de cada proyecto, con tu runner key y tokens
  LOGS_DIR,
  ...[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".config/gh", ".config/gcloud", ".claude.json", "Library/Keychains"].map((p) => join(home, p)),
];

let current: { id: string; abort: AbortController } | null = null;
/** Remote Control necesita `script` para darle un terminal a Claude Code. */
const REMOTE_PLATFORMS: NodeJS.Platform[] = ["darwin", "linux"];
let refreshQuota: () => Promise<void> = async () => undefined;
/** GitHub o Bitbucket según el repo; sin él solo se sube la rama. Se decide al arrancar (checkRepo). */
let prHost: PrHost | undefined;
let pending: string[] = [];
let busy = false;
/** Hay versión nueva: se termina lo que esté en marcha, no se coge nada más y se reinicia. */
let restarting = false;
let stopping = false;

type RunOutcome = { status: "done" | "failed" | "waiting" | "execute"; result: FeatureResult; sessionId?: string };

async function runFeature(id: string, feature: Feature): Promise<RunOutcome> {
  const acceptanceError = await store.verifyAcceptance(id, feature);
  if (acceptanceError) return { status: "failed", result: { error: acceptanceError } };

  const project = await store.projectInfo();
  // Con sesión previa, es una conversación: se continúa la misma sesión en el mismo worktree y rama.
  const resuming = !!feature.sessionId;
  // Modo plan: hasta que quien la ejecuta aprueba el plan, Claude solo lee el repo y propone (o rehace) el plan.
  const planning = !!feature.planFirst && !feature.planApproved;
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
  let afterMerge: FeatureResult["afterMerge"]; // pasos tras mergear que declara Claude al abrir el PR
  // Destinos de despliegue del repo (scripts backcode:deploy:*): Claude los puede citar en los pasos tras mergear.
  const deployNames = [...new Set((await findDeployTargets(wt.path, "HEAD").catch(() => [])).map((d) => d.name))];
  let question: string | undefined; // pregunta de Claude (ask_user)
  let planned = false; // modo plan: ya propuso el plan en esta vuelta
  const prServer = createSdkMcpServer({
    name: "backcode",
    version: "1.0.0",
    tools: [
      tool(
        "propose_plan",
        "Plan mode only: send your implementation plan (Markdown) to the person who accepted this task. They review it in the app, ask for changes or approve it; once approved, this same session continues and implements it. Call it once per turn with the complete plan, then end your turn.",
        { plan: z.string().min(50).max(20_000) },
        async ({ plan }) => {
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
          if (!planning) return fail(t("plan.notPlanning"));
          if (planned) return fail(t("plan.already"));
          planned = true;
          await store.postMessage(id, "plan", plan);
          await store.event(id, "plan", plan.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 300) ?? "");
          return { content: [{ type: "text" as const, text: t("plan.sent") }] };
        },
      ),
      tool(
        "open_pull_request",
        `Commit all changes in the worktree to the feature branch, push it and open a draft pull request. Call exactly once when the work is complete. If someone must do something by hand after merging (deploy security rules or cloud functions, run a migration, set an env var…), list it in afterMerge: one step each, with why and the exact shell command; never run those yourself.${deployNames.length ? ` This repo can run these deploy targets from the app (set deployTarget to the matching one instead of, or as well as, the command): ${deployNames.join(", ")}.` : ""}`,
        {
          title: z.string().min(5).max(120),
          body: z.string().min(20).max(20_000),
          afterMerge: z
            .array(
              z.object({
                why: z.string().min(3).max(300),
                command: z.string().min(1).max(500).optional(),
                deployTarget: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
              }),
            )
            .max(10)
            .optional(),
        },
        async ({ title, body, afterMerge: steps }) => {
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
          // Solo se guardan destinos que el repo declara de verdad (la app no ejecuta nada que el repo no ofrezca).
          afterMerge = steps?.map((s) => ({ why: s.why, ...(s.command ? { command: s.command } : {}), ...(s.deployTarget && deployNames.includes(s.deployTarget) ? { deployTarget: s.deployTarget } : {}) }));
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
  // El tiempo máximo cuenta solo mientras trabaja el runner (no mientras la persona está en Remote Control).
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => abort.abort(), cfg.timeoutMinutes * 60_000);
  };
  armTimeout();
  const lease = setInterval(() => store.extendLease(id).catch(() => undefined), FEATURE_LEASE_MS / 3);

  let result: FeatureResult = { branch: wt.branch, prUrl: previousPr };
  let sessionId = feature.sessionId;
  const model = modelFor(feature, cfg.model);

  // --- Conversación en directo: lo que la persona escribe en el hilo mientras Claude trabaja le llega en su siguiente
  // paso. Cada mensaje va con un uuid; cuando Claude lo incorpora (user_message_uuids) se marca como leído.
  let userMessages: ThreadMessage[] = [];
  const handled = new Set<string>(); // ids de mensajes ya entregados (o incluidos en el prompt)
  const outstanding = new Map<string, string>(); // uuid enviado -> id del mensaje, pendiente de que Claude lo lea
  let liveQuery: Query | null = null;
  // Coste y tokens de las fases anteriores (con Remote Control de por medio hay varias): se suman.
  let spent = { costUsd: 0, turns: 0, input: 0, output: 0, cache: 0 };
  let inputQueue: SDKUserMessage[] = [];
  let inputOpen = false;
  let wake: (() => void) | null = null;
  const flushLive = () => {
    if (!inputOpen) return;
    for (const m of userMessages) {
      if (!m.id || m.read || handled.has(m.id) || m.kind !== "message") continue;
      handled.add(m.id);
      const uuid = randomUUID();
      outstanding.set(uuid, m.id);
      inputQueue.push({ type: "user", message: { role: "user", content: buildLiveMessage(m.text) }, parent_tool_use_id: null, uuid, priority: "next" });
    }
    wake?.();
  };
  const closeInput = () => {
    inputOpen = false;
    wake?.();
  };
  async function* input(first: string): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: first }, parent_tool_use_id: null };
    for (;;) {
      while (inputQueue.length) yield inputQueue.shift()!;
      if (!inputOpen) return;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  }

  // --- Lo que pide la app sobre la tarea en curso: parar o abrir/cerrar Remote Control.
  const control = await store.control(id).catch(() => ({}) as LiveControl);
  const stopAt = control.stopRequest?.toMillis() ?? 0;
  let stopRequested = false;
  let remoteWanted = control.remote?.state === "requested";
  // Marca de una vuelta anterior que no terminó bien (el runner se cerró con Remote Control abierto).
  if (control.remote && !remoteWanted && control.remote.state !== "failed") await store.setRemote(id, null).catch(() => undefined);
  let remoteSession: RemoteSession | null = null;
  const unwatchFeature = store.watchControl(id, (f) => {
    if (!stopRequested && (f.stopRequest?.toMillis() ?? 0) > stopAt) {
      stopRequested = true;
      void store.event(id, "say", t("run.stopRequested"));
      remoteSession?.stop();
      void liveQuery?.interrupt().catch(() => undefined);
    }
    if (f.remote?.state === "requested" && !remoteWanted && !remoteSession) {
      remoteWanted = true;
      void liveQuery?.interrupt().catch(() => undefined);
    }
    if (f.remote?.state === "return") remoteSession?.stop();
  });
  const unwatchMessages = store.watchUserMessages(id, (list) => {
    userMessages = list;
    flushLive();
  });

  /** Una fase con el SDK: el prompt y, después, lo que la persona vaya escribiendo, hasta que Claude termina. */
  async function runPhase(prompt: string): Promise<void> {
    // Parada antes de empezar (p. ej. mientras se preparaba el worktree): no se arranca.
    if (stopRequested) return;
    inputQueue = [];
    inputOpen = true;
    flushLive();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const messages = query({
      prompt: input(prompt),
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
        resume: sessionId,
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
        // Planificando solo puede leer el repo y proponer el plan (o preguntar); sin editar ni ejecutar comandos.
        allowedTools: planning
          ? ["Read", "Glob", "Grep", "TodoWrite", "mcp__backcode__propose_plan", "mcp__backcode__ask_user"]
          : ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "TodoWrite", "mcp__backcode__open_pull_request", "mcp__backcode__ask_user"],
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
    liveQuery = messages;
    try {
      for await (const msg of messages) {
        clearTimeout(quiet);
        if (msg.type === "assistant") {
          // Mensajes de la persona que Claude acaba de incorporar.
          const read = (msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : [])).filter((u) => outstanding.has(u));
          if (read.length) {
            void store.markRead(id, read.map((u) => outstanding.get(u)!));
            read.forEach((u) => outstanding.delete(u));
            // Ha respondido (o pedido cambios) en esta misma vuelta: la pregunta o el plan anteriores ya no esperan.
            question = undefined;
            planned = false;
          }
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              // Lo que Claude va contando ("Voy a…"): da contexto a la actividad.
              await store.event(id, "say", block.text.trim().replace(/\n{3,}/g, "\n\n").slice(0, 1000));
            } else if (block.type === "tool_use") {
              await store.event(id, "tool", describeTool(block.name, block.input as Record<string, unknown>, wt.path));
            }
          }
        } else if (msg.type === "system" && msg.subtype === "init") {
          if (msg.session_id && msg.session_id !== sessionId) await store.setSession(id, msg.session_id);
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
            costUsd: msg.total_cost_usd + spent.costUsd,
            turns: msg.num_turns + spent.turns,
            tokens: {
              input: models.reduce((n, m) => n + m.inputTokens, 0) + spent.input,
              output: models.reduce((n, m) => n + m.outputTokens, 0) + spent.output,
              cache: models.reduce((n, m) => n + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0) + spent.cache,
            },
            summary: msg.subtype === "success" ? msg.result.slice(0, 4000) : undefined,
            error: msg.subtype === "success" ? undefined : `${msg.subtype}: ${msg.errors.join("; ").slice(0, 2000)}`,
          };
          // Termina si no queda nada que Claude no haya leído; si lo hay, sigue con ello. Si en unos segundos no
          // empieza (un Claude Code que no confirma los mensajes), se cierra igual y la tarea vuelve a la cola con ellos.
          if (outstanding.size === 0 || stopRequested || remoteWanted) closeInput();
          else quiet = setTimeout(closeInput, 15_000);
        }
      }
    } finally {
      clearTimeout(quiet);
      closeInput();
      liveQuery = null;
      // Lo enviado y no leído vuelve a estar pendiente (se entrega en la siguiente fase o vuelta).
      for (const mid of outstanding.values()) handled.delete(mid);
      outstanding.clear();
      spent = {
        costUsd: result.costUsd ?? 0,
        turns: result.turns ?? 0,
        input: result.tokens?.input ?? 0,
        output: result.tokens?.output ?? 0,
        cache: result.tokens?.cache ?? 0,
      };
    }
  }
  /** Remote Control: Claude Code interactivo sobre la misma sesión, hasta que la persona sale o vuelve a Backcode. */
  async function runRemote(): Promise<boolean> {
    remoteWanted = false;
    const bin = installedClaude();
    if (!bin || !sessionId || !REMOTE_PLATFORMS.includes(process.platform)) {
      await store.setRemote(id, { state: "failed", error: t("remote.unavailable") }).catch(() => undefined);
      await store.event(id, "error", t("remote.unavailable"));
      return false;
    }
    clearTimeout(timeout);
    await store.event(id, "start", t("remote.opening"));
    try {
      remoteSession = await startRemoteControl({ bin, cwd: wt.path, sessionId, name: `${project.name} · ${feature.title}`.slice(0, 80) });
    } catch (err) {
      remoteSession = null;
      const error = t("remote.failed", { error: (err as Error).message.slice(0, 400) });
      await store.setRemote(id, { state: "failed", error }).catch(() => undefined);
      await store.event(id, "error", error);
      armTimeout();
      return false;
    }
    const session = remoteSession;
    const onAbort = () => session.stop();
    abort.signal.addEventListener("abort", onAbort);
    await store.setRemote(id, { state: "open", url: session.url });
    await store.event(id, "start", t("remote.open"));
    // Lo que hace Claude allí también se ve en la actividad de la tarea.
    const unfollow = followTranscript(wt.path, sessionId, (entry) => {
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (entry.type !== "assistant" || !Array.isArray(message?.content)) return;
      for (const block of message.content as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (block.type === "text" && block.text?.trim()) void store.event(id, "say", block.text.trim().replace(/\n{3,}/g, "\n\n").slice(0, 1000));
        else if (block.type === "tool_use" && block.name) void store.event(id, "tool", describeTool(block.name, block.input ?? {}, wt.path));
      }
    });
    await session.exited;
    unfollow();
    abort.signal.removeEventListener("abort", onAbort);
    remoteSession = null;
    await store.setRemote(id, null).catch(() => undefined);
    await store.event(id, "start", t("remote.back"));
    armTimeout();
    return true;
  }

  try {
    const thread = resuming ? await store.thread(id) : [];
    // Lo que escribió quien la ejecuta y Claude aún no ha recibido. Las tareas de antes de los mensajes en directo no
    // tienen marcas de leído: ahí cuenta lo escrito desde el último mensaje de Claude, y lo anterior se da por leído.
    const fromUser = thread.filter((m) => m.author === "user");
    const lastClaude = thread.map((m) => m.author).lastIndexOf("claude");
    const legacy = !fromUser.some((m) => m.read);
    const replies = legacy ? thread.slice(lastClaude + 1).filter((m) => m.author === "user") : fromUser.filter((m) => !m.read);
    const seen = legacy ? fromUser.filter((m) => !replies.includes(m)) : [];
    // Todo lo ya existente cuenta como entregado: lo de antes ya lo recibió en vueltas anteriores y lo nuevo va en el prompt.
    for (const m of [...replies, ...seen]) if (m.id) handled.add(m.id);
    const delivered = [...replies, ...seen].map((m) => m.id).filter((m): m is string => !!m);
    if (delivered.length) void store.markRead(id, delivered);
    // Recién aprobado: el último mensaje de Claude es un plan y aún no hay PR.
    const justApproved = !!feature.planApproved && !previousPr && thread.filter((m) => m.author === "claude").pop()?.kind === "plan";
    const prompt = planning
      ? resuming
        ? buildPlanFollowUpPrompt(replies)
        : buildPlanPrompt(id, feature, attachments)
      : justApproved
        ? buildApprovedPlanPrompt(replies)
        : resuming
          ? buildFollowUpPrompt(replies, !!previousPr, { base: cfg.baseBranch, files: conflicts })
          : buildUserPrompt(id, feature, attachments);
    if (model) await store.event(id, "say", t("run.model", { model }));
    // Pedida desde la app con la tarea parada: primero Remote Control, y al volver sigue el runner.
    if (remoteWanted && resuming && (await runRemote())) {
      if (!stopRequested) await runPhase(buildAfterRemotePrompt({ planning, hasPr: !!previousPr }));
    } else {
      if (planning) await store.event(id, "start", t(resuming ? "run.replanning" : "run.planning"));
      else if (justApproved) await store.event(id, "start", t("run.planApproved"));
      await runPhase(prompt);
    }
    // Pedida mientras trabajaba: se interrumpe su turno, se abre Remote Control y al volver sigue la misma sesión.
    while (remoteWanted && !stopRequested && !abort.signal.aborted) {
      if (!(await runRemote())) break;
      if (stopRequested) break;
      await runPhase(buildAfterRemotePrompt({ planning, hasPr: !!(prUrl ?? previousPr) }));
    }
  } catch (err) {
    result.error = abort.signal.aborted ? (stopping ? t("run.stopped") : t("run.timeout", { min: cfg.timeoutMinutes })) : String(err);
  } finally {
    clearTimeout(timeout);
    clearInterval(lease);
    unwatchFeature();
    unwatchMessages();
    // Se asigna dentro de runRemote: TypeScript no lo ve desde aquí.
    const leftOpen = remoteSession as RemoteSession | null;
    leftOpen?.stop();
    if (leftOpen) await store.setRemote(id, null).catch(() => undefined);
    current = null;
    // El worktree se conserva: la conversación puede continuar (se limpia tras días sin uso).
  }

  // Parada desde la app: queda esperando a que la persona escriba (con el PR que hubiera).
  if (stopRequested && !stopping) {
    const pr = prUrl ?? previousPr;
    return { status: pr ? "done" : "waiting", result: { ...result, prUrl: pr, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId };
  }
  // El resumen de cada vuelta queda en el hilo; si preguntó o propuso un plan, eso ya está publicado.
  if (!question && !planned && result.summary) await store.postMessage(id, "summary", result.summary).catch(() => undefined);
  // Mensajes que llegaron al final y Claude no llegó a leer: vuelve a la cola y la siguiente vuelta empieza por ellos.
  const unread = userMessages.some((m) => m.kind === "message" && !m.read && !handled.has(m.id ?? ""));
  if (unread && !result.error && !stopping) {
    return { status: "execute", result: { ...result, prUrl: prUrl ?? previousPr, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId };
  }
  if (question && !result.error) return { status: "waiting", result: { ...result, error: undefined }, sessionId };
  // Plan propuesto: espera a que lo aprueben o pidan cambios (como una pregunta).
  if (planned && !result.error) return { status: "waiting", result: { ...result, planReady: true, error: undefined }, sessionId };
  if (planning) return { status: "failed", result: { ...result, error: result.error ?? t("run.noPlan") }, sessionId };
  if (prUrl) return { status: "done", result: { ...result, prUrl, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId };
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
    while (!stopping && !restarting && pending.length > 0) {
      const id = pending.shift()!;
      const feature = await store.claim(id);
      if (!feature) continue;
      console.log(`[run] ${id} · ${feature.title}`);
      const release = awake.hold();
      try {
        const { status, result, sessionId } = await runFeature(id, feature);
        if (stopping && !result.prUrl && status !== "waiting" && status !== "execute") {
          await store.requeue(id);
        } else {
          // Volver a la cola con mensajes sin leer necesita las reglas nuevas: sin ellas, queda esperando (no fallida).
          const fallback = result.prUrl ? "done" : "waiting";
          await store.finish(id, status, result, sessionId).catch((err) => (status === "execute" ? store.finish(id, fallback, result, sessionId) : Promise.reject(err)));
          await store.event(id, status, result.prUrl ?? result.error ?? "");
        }
        console.log(`[${status}] ${id} ${result.prUrl ?? result.error ?? ""}`);
        void refreshQuota();
      } catch (err) {
        console.error(`[error] ${id}`, err);
        await store.finish(id, "failed", { error: String(err).slice(0, 2000) });
      } finally {
        release();
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
  const repoUrl = publicRepoUrl(repo.remoteUrl);
  if (repoUrl) await store.saveRepoUrl(repoUrl).catch(() => undefined);
  prHost = repo.pullRequest === "github" ? githubHost(cfg.repoPath) : repo.pullRequest === "bitbucket" ? bitbucketHost(repo.remoteUrl, cfg.bitbucket!.email, cfg.bitbucket!.token) : undefined;
  store.warnings = repo.warnings;
  const head = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const expoApp = await findExpoApp(cfg.repoPath, head).catch(() => null);
  // Despliegues que el repo declara (scripts backcode:deploy:*): web, api, scripts… cada uno con su botón en la app.
  const deploys = (await findDeployTargets(cfg.repoPath, head).catch(() => [])).map(({ id, name, dir, env }) => ({ id, name, dir, ...(env ? { env } : {}) }));
  store.capabilities = {
    pr: prHost?.kind ?? null,
    expo: !!expoApp,
    deploys,
    ota: expoApp?.ota ? { channels: expoApp.channels, via: expoApp.ota } : null,
    // Builds locales para testers: con perfil `production` en eas.json; iOS solo si el runner corre en un Mac.
    build: expoApp?.buildProfiles.includes("production") ? { platforms: process.platform === "darwin" ? ["ios", "android"] : ["android"] } : null,
    // «Instalar en mi móvil»: app Expo y, en este ordenador, Xcode (iOS) o adb (Android).
    install: expoApp ? { platforms: await installPlatforms().catch(() => []) } : null,

    refine: true,
    live: true,
    remoteControl: REMOTE_PLATFORMS.includes(process.platform) && !!installedClaude(),
  };
  if (expoApp && !expoApp.ota) console.warn(`\x1b[33m⚠ ${t("main.otaOff", { reason: otaMissing() })}\x1b[0m`);
  for (const w of repo.warnings) console.warn(`\x1b[33m⚠ ${describeWarning(w)}\x1b[0m`);
  const releaseLock = await store.acquireLock();
  // Móviles listos para «Instalar en mi móvil»: se miran cada 45 s y se guardan solo si cambian.
  let devicesKey = "";
  const watchDevices = async () => {
    const installs = devInstalls()[cfg.projectId] ?? {};
    const devices = (await listDevices().catch(() => null))?.map((d) => ({ ...d, devInstalled: installs[d.id] === true })) ?? null;
    const key = JSON.stringify(devices);
    if (!devices || key === devicesKey) return;
    await store.saveDevices(devices).then(() => (devicesKey = key), () => undefined);
  };
  const devicesTimer = store.capabilities.install?.platforms.length ? setInterval(() => void watchDevices(), 45_000) : undefined;
  if (devicesTimer) void watchDevices();
  await store.recoverOrphans();
  await store.recoverActions().catch(() => undefined);
  await pruneOldWorktrees(cfg.repoPath, cfg.worktreesDir, 14).catch(() => undefined);
  // Al arrancar, tu copia local de la rama base se pone al día si es seguro (p. ej. tras merges hechos por otros).
  const local = await syncLocalBase(cfg.repoPath, cfg.remote, cfg.baseBranch).catch((e: Error) => ({ status: "skipped" as const, reason: e.message, changed: [] as string[] }));
  logLocalSync(cfg, local);
  if (local.status === "updated") await installIfNeeded(cfg.repoPath, local.changed ?? []);

  const project = await store.projectInfo();
  printConnected(project.name);
  // Para que el panel muestre el nombre del proyecto (las configuraciones antiguas no lo traen).
  if (project.name && readState().names?.[cfg.projectId] !== project.name) updateState({ names: { ...readState().names, [cfg.projectId]: project.name } });
  if (cfg.keepAwake === "always") console.log(`[backcode] ${t("awake.always")}`);

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
      while (!stopping && !restarting && pendingActions.length) {
        const id = pendingActions.shift()!;
        const action = await store.claimAction(id);
        if (!action) continue;
        console.log(`[action] ${String(action.type)} ${String(action.featureId ?? action.channel ?? action.target ?? action.deviceName ?? action.deviceId ?? (Array.isArray(action.platforms) ? `${action.platforms.join("+")} ${String(action.version)}` : ""))}`);
        const actionLease = setInterval(() => void store.extendActionLease(id).catch(() => undefined), 60_000);
        const release = awake.hold();
        const { ok, result } = await runAction(cfg, store, prHost, action as unknown as Action)
          .catch((err): { ok: boolean; result: ActionResult } => ({ ok: false, result: { error: String((err as Error).message ?? err).slice(0, 1500) } }))
          .finally(() => {
            clearInterval(actionLease);
            release();
          });
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

  // Ideas que pido refinar con mi Claude Code (opción del perfil): de una en una y en paralelo a las tareas, así una
  // tarea larga no deja esperando a quien escribe una idea. Si tarda, el servidor la refina con OpenAI.
  let refineBusy = false;
  let pendingRefines: string[] = [];
  const refineAbort = new AbortController();
  const drainRefines = async () => {
    if (refineBusy) return;
    refineBusy = true;
    try {
      while (!stopping && !restarting && pendingRefines.length) {
        const id = pendingRefines.shift()!;
        const job = await store.claimRefine(id).catch(() => null);
        if (!job) continue;
        const release = awake.hold();
        await refineIdea(cfg, store, agentEnv(), id, job, refineAbort.signal).finally(release);
      }
    } finally {
      refineBusy = false;
    }
  };
  const unsubscribeRefines = onSnapshot(
    store.myRefineJobs(),
    (snap) => {
      pendingRefines = snap.docs.map((d) => d.id);
      void drainRefines();
    },
    (err) => console.warn(`[refine] ${err.message}`),
  );

  // Lo que este ordenador ofrece para crear proyectos (carpeta, cuentas de GitHub y Bitbucket): al arrancar, cada hora y
  // cuando cambian los ajustes en la app. Con varios proyectos conectados lo publican todos (es lo mismo); si falla, da igual.
  let workspaceDir: string | undefined;
  const reportMachine = () =>
    void machineInfo(workspaceDir, cfg.bitbucket)
      .then((info) => store.saveMachine(info))
      .catch((err) => console.warn(`[machine] ${(err as Error).message}`));
  const stopWorkspace = store.watchWorkspace((w) => {
    workspaceDir = w.projectsDir;
    reportMachine();
  });
  const machineTimer = setInterval(reportMachine, 60 * 60_000);

  // Proyectos nuevos que pido desde la app: los escuchan todos mis runners y lo crea el que lo reclama primero.
  await store.recoverScaffolds().catch(() => undefined);
  let scaffoldBusy = false;
  let pendingScaffolds: string[] = [];
  const drainScaffolds = async () => {
    if (scaffoldBusy) return;
    scaffoldBusy = true;
    try {
      while (!stopping && !restarting && pendingScaffolds.length) {
        const id = pendingScaffolds.shift()!;
        const raw = await store.claimScaffold(id).catch(() => null);
        if (!raw) continue;
        const job = parseScaffold(raw);
        if ("error" in job) {
          await store.finishScaffold(id, false, { error: job.error }).catch(() => undefined);
          continue;
        }
        console.log(`[scaffold] ${job.host} ${job.owner}/${job.repoName}`);
        const lease = setInterval(() => void store.extendScaffoldLease(id).catch(() => undefined), 60_000);
        const release = awake.hold();
        const { ok, result } = await runScaffold(cfg, store, job, (text) => {
          console.log(`[scaffold] ${text}`);
          void store.scaffoldActivity(id, text);
        })
          .catch((err): Awaited<ReturnType<typeof runScaffold>> => ({ ok: false, result: { error: String((err as Error).message ?? err).slice(0, 1500) } }))
          .finally(() => {
            clearInterval(lease);
            release();
          });
        await store.finishScaffold(id, ok, result).catch((err) => console.warn(`[scaffold] ${(err as Error).message}`));
        console.log(`[scaffold] ${ok ? t("scaffold.done", { path: result.repoPath ?? "" }) : result.error}`);
      }
    } finally {
      scaffoldBusy = false;
    }
  };
  const unsubscribeScaffolds = onSnapshot(
    store.myScaffolds(),
    (snap) => {
      pendingScaffolds = snap.docs.map((d) => d.id);
      void drainScaffolds();
    },
    (err) => console.warn(`[scaffold] ${err.message}`),
  );

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[backcode] ${t("main.stopping")}`);
    unsubscribe();
    stopLang();
    unsubscribeActions();
    unsubscribeRefines();
    unsubscribeScaffolds();
    stopWorkspace();
    clearInterval(machineTimer);
    refineAbort.abort();
    clearInterval(knowledgeTimer);
    clearInterval(devicesTimer);
    stopDevServer();
    clearInterval(quotaTimer);
    clearInterval(conflictsTimer);
    stopQuotaRequests();
    knowledgeAbort.abort();
    current?.abort.abort();
    while (busy) await new Promise((r) => setTimeout(r, 200));
    await releaseLock();
    awake.stop();
    exitSupervised(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Actualización automática: con versión nueva lista se espera a estar libre (sin tarea ni acción en marcha; no se
  // interrumpe nada) y se reinicia. Con `npm run all` lo comprueba él una sola vez y avisa con SIGUSR2; solo, este runner.
  const restartWhenIdle = async () => {
    if (restarting || stopping) return;
    restarting = true;
    console.log(`[backcode] ${t("update.waiting")}`);
    while (busy || actionsBusy || refineBusy || scaffoldBusy) await new Promise((r) => setTimeout(r, 1000));
    stopping = true;
    unsubscribe();
    stopLang();
    unsubscribeActions();
    unsubscribeRefines();
    unsubscribeScaffolds();
    stopWorkspace();
    clearInterval(machineTimer);
    clearInterval(knowledgeTimer);
    clearInterval(devicesTimer);
    stopDevServer();
    clearInterval(quotaTimer);
    clearInterval(conflictsTimer);
    clearInterval(updateTimer);
    stopQuotaRequests();
    knowledgeAbort.abort();
    await releaseLock();
    awake.stop();
    console.log(`[backcode] ${t("update.restarting")}`);
    if (SUPERVISED) exitSupervised(RESTART_CODE);
    relaunch();
  };
  process.on("SIGUSR2", () => void restartWhenIdle());
  const checkUpdate = () => {
    if (SUPERVISED || restarting || stopping) return;
    void updateIfAvailable()
      .then((ready) => {
        if (ready) void restartWhenIdle();
      })
      .catch(() => undefined);
  };
  const updateTimer = setInterval(checkUpdate, UPDATE_EVERY_MS);
  setTimeout(checkUpdate, 15_000);
}

/** Vuelve a arrancar este mismo runner (mismos argumentos, mismo terminal) con el código nuevo. */
function relaunch(): never {
  const execve = (process as unknown as { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
  if (execve) execve(process.execPath, [process.execPath, ...ownArgs()], process.env);
  const child = spawn(process.execPath, ownArgs(), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  // Este proceso solo espera al nuevo (Node antiguo sin process.execve).
  return undefined as never;
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
