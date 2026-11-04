import { explainRemoteError } from "./remote-retry.js";
import { remoteTexts } from "./i18n.js";
import { findMergedOutside, MERGED_POLL_MS } from "./merged-watch.js";
import { homedir } from "node:os";
import { lastCliPublish, markCliPublished } from "./ota-watch.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { exitSupervised, RESTART_CODE, SUPERVISED, UPDATE_EVERY_MS, updateIfAvailable } from "./autoupdate.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, query, tool, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { onSnapshot, type QueryDocumentSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { z } from "zod";
import { KIT_DIR, loadConfig } from "./config.js";
import { CONFIG_DIR, HOME_DIR, LOGS_DIR, ownArgs, readState, updateState } from "./paths.js";
import { brakeReason, measure, metricsDoc, MONITOR_EVERY_MS, quickCheck, rememberSessionRam, takeMonitorTurn } from "./monitor.js";
import { clampLimit, effectiveProjectLimit, MAX_MACHINE_LIMIT, MAX_PROJECT_LIMIT, nextTask, type QueuedTask, type QueueReason } from "./scheduler.js";
import { takeSlot } from "./slots.js";
import { lang, LANGUAGE_NAME, t } from "./i18n.js";
import { previewBranch, setPreviewBranch, taskBase, validPreviewBranch } from "./environments.js";
import { checkMachine, claudeExecutable, installedClaude } from "./preflight.js";
import { reportUpdates, UPDATE_NOTICE_EVERY_MS } from "./update-notice.js";
import { adoptTranscript, followTranscript, hasTranscript, isSessionGoneError, retentionDays, startRemoteControl, type RemoteSession } from "./remote.js";
import { checkRepo, commitPushAndOpenPr, publicRepoUrl, describeWarning, deployCapabilities, fetchBranches, findConflicts, findDeployTargets, findExpoApp, mergeBaseIntoBranch, git, pushBranch, remoteHead, remoteSha, syncLocalBase, commitsAhead, createWorktree, pruneOldWorktrees, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook, protectedMatcher } from "./guard.js";
import { asWorkflow, writeGuard } from "./workflow-guard.js";
import { stopWaitingForChecks } from "./wait-checks.js";
import { localChecksAt } from "./local-checks.js";
import { githubActions } from "./github-actions.js";
import { installIfNeeded, logLocalSync, merge as mergeTask, otaMissing, runAction, setChecksMode, setDeployRetry, setGithubActions, setRequireChecks, type Action, type ActionResult } from "./actions.js";
import { autoMerge, clampRetries, TURN_LEASE_MS } from "./auto-merge.js";
import { clampRetryMax, decideRetry } from "./auto-retry.js";
import { materializeAttachments } from "./attachments.js";
import { bitbucketHost, githubHost, type PrHost } from "./hosts.js";
import { devInstalls, resumeDevServer, stopDevServer } from "./dev-server.js";
import { installPlatforms, listDevices } from "./devices.js";
import { refreshKnowledge } from "./knowledge.js";
import { fixConflicts } from "./conflicts.js";
import { prepareTaskDependencies } from "./task-deps.js";
import { appliesTo, checkPermissionRequest, isEmpty, loadPermissionContext, REQUEST_PERMISSION_INPUT, sessionPermissions, threadGrants } from "./permissions.js";
import { fixChecks } from "./fix-checks.js";
import { majorOf, reviewComment, reviewFixPrompt, runReview, type ReviewLevel, type ReviewSpend, type ReviewState } from "./code-review.js";
import { computePlan } from "./pending.js";
import { flushDeployQueue, hasQueuedDeploys } from "./deploy-log.js";
import { gcloudToken, rulesPublished } from "./rules-check.js";
import { readQuota } from "./quota.js";
import { planLimitFromEvent, planLimitFromText, quotaAvailable, quotaBlockedUntil, waitUntil, type PlanLimitHit } from "./plan-limit.js";
import { parkForQuota, QuotaWaits, resumeDue, type QuotaWaitStore } from "./quota-waits.js";
import { refineIdea } from "./refine.js";
import { promptMessage, runChat, VIDEO_WAIT_MS, videosPending, type ChatTaskInput, type ChatTaskMessage } from "./chat.js";
import { detectCi } from "./ci.js";
import { machineInfo, resolveProjectsDir } from "./machine.js";
import { linkProject, machineId, machineStatus, MACHINE_BEAT_MS, parseLinkRequest } from "./machines.js";
import { panelCall } from "./panel-client.js";
import { parseScaffold, runScaffold } from "./scaffold.js";
import { KeepAwake } from "./awake.js";
import { buildCiPrompt, ciFileFor, ciGuard, ciSystemAppend, CI_TOOLS, isCiTask } from "./ci-task.js";
import { buildAfterRemotePrompt, buildApprovedPlanPrompt, buildFollowUpPrompt, buildHandoffPrompt, buildLiveContent, buildPlanFollowUpPrompt, buildPlanPrompt, buildSystemAppend, buildUserPrompt } from "./prompt.js";
import { dropProgress, restoreProgress, saveProgress } from "./handoff.js";
import { buildReport, notOurs, report, type DeploySource, type SanitizeContext } from "./diagnostics.js";
import { connect, FEATURE_LEASE_MS, Store, type Feature, type FeatureResult, type LiveControl, type RunnerChat, type ThreadMessage } from "./store.js";
import { useGhForGit } from "./github.js";
import { loadSavedApiKey } from "./anthropic.js";
import { cleanModelId, LiveUsage, throttled, usageFromResult } from "./live-usage.js";

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
/** Lo que diagnostics.ts quita de los informes (el repo, sus worktrees y su remoto). */
const diagCtx: SanitizeContext = { repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir };
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

/** Tareas en marcha en este proceso (varias a la vez según los límites; scheduler.ts) y cómo cancelarlas. */
const running = new Map<string, QueuedTask>();
const aborts = new Map<string, AbortController>();
/** Límite personal de este proyecto y total de este ordenador (users/{uid}/machineSettings); null = sin tope. */
const limits = { project: null as number | null, machine: null as number | null };
const SLOTS_DIR = join(HOME_DIR, "slots");
const WORKTREES_ROOT = join(HOME_DIR, "worktrees");
/** Operaciones git sobre el repo principal (fetch, worktree add): de una en una aunque arranquen varias tareas. */
let repoGitChain: Promise<unknown> = Promise.resolve();
function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = repoGitChain.then(fn, fn);
  repoGitChain = next.catch(() => undefined);
  return next;
}
/** Remote Control necesita `script` para darle un terminal a Claude Code. */
const REMOTE_PLATFORMS: NodeJS.Platform[] = ["darwin", "linux"];
let refreshQuota: () => Promise<void> = async () => undefined;
/** GitHub o Bitbucket según el repo; sin él solo se sube la rama. Se decide al arrancar (checkRepo). */
let prHost: PrHost | undefined;
let pending: QueuedTask[] = [];
/** drain() decidiendo qué arrancar (las tareas corren aparte, en `running`). */
let busy = false;
let drainRetry: NodeJS.Timeout | undefined;
/** Último motivo de espera publicado en runners/{uid}.queue (para no escribir si no cambia). */
let queueKey = "";
let monitorTimer: NodeJS.Timeout | undefined;
/** Hay versión nueva: se termina lo que esté en marcha, no se coge nada más y se reinicia. */
let restarting = false;
let stopping = false;
/**
 * Límite del plan de Claude Code (plan-limit.ts): las tareas en espera del límite de este runner (hasta cuándo, intentos
 * y cómo quedaron), también en un fichero local que sobrevive a los reinicios (quota-waits.ts). Mientras alguna espera,
 * no se arranca ninguna tarea nueva (fallarían igual), salvo las que alguien pidió reanudar ya desde la app.
 */
let quotaWaits = new QuotaWaits();
let quotaChecking = false;

// «Modo auto» del proyecto (auto-merge.ts): las tareas que este runner termina con PR se mergean solas, de una en una
// (y con el turno del proyecto, entre runners). Nunca se despliega ni se publica nada.
const autoMergeSettings = { on: false, retries: clampRetries(undefined) };
const autoMergeAbort = new AbortController();
const autoMergeQueue: string[] = [];
let autoMergeBusy = false;
function queueAutoMerge(featureId: string): void {
  if (!autoMergeSettings.on || !prHost || autoMergeQueue.includes(featureId)) return;
  autoMergeQueue.push(featureId);
  void drainAutoMerge();
}
async function drainAutoMerge(): Promise<void> {
  if (autoMergeBusy) return;
  autoMergeBusy = true;
  try {
    while (!stopping && !restarting && autoMergeQueue.length) {
      const featureId = autoMergeQueue.shift()!;
      if (!autoMergeSettings.on) continue;
      const release = awake.hold();
      const signal = autoMergeAbort.signal;
      const final = await autoMerge({
        featureId,
        base: taskBase(cfg.baseBranch),
        retries: autoMergeSettings.retries,
        hasCi: store.capabilities.ci,
        merge: () => mergeTask(cfg, store, prHost, featureId, { auto: true }),
        fixChecks: () => fixChecks(cfg, store, prHost, { env: agentEnv(), isProtected, denyRead: DENY_READ }, signal, featureId),
        fixConflicts: () => fixConflicts(cfg, store, prHost, agentEnv(), signal, featureId),
        setState: (state) => store.setAutoMerge(featureId, state),
        takeTurn: () => store.takeMergeTurn(TURN_LEASE_MS),
        releaseTurn: () => store.releaseMergeTurn(),
        log: (text) => console.log(`[auto] ${featureId} ${text}`),
        // Con el code review automático del proyecto: no se mergea con fallos graves pendientes ni si el review falló.
        beforeMerge: async () => {
          const review = await store.reviewStateOf(featureId);
          if (review.state === "findings" && review.majors) return { ok: false, reason: t("auto.reviewBlocked", { n: review.majors }) };
          if (review.state === "error" || review.state === "reviewing") return { ok: false, reason: t("auto.reviewFailed") };
          return { ok: true };
        },
        shouldStop: () => stopping || restarting || signal.aborted,
      })
        .catch((err: Error) => ({ state: "error", reason: err.message }))
        .finally(release);
      console.log(`[auto] ${featureId} ${final.state}${final.reason ? `: ${final.reason}` : ""}`);
    }
  } finally {
    autoMergeBusy = false;
  }
}

// «Reintenta las tareas fallidas por errores temporales» (auto-retry.ts): con la opción del proyecto activa, una tarea que
// falla por la red, una API caída o una parada del runner vuelve sola a la cola tras una espera, como mucho `max` veces y
// sin pasar del tope de coste. Sin tope propio, el de una ejecución (BACKCODE_MAX_BUDGET_USD).
const autoRetrySettings = { on: false, max: clampRetryMax(undefined), maxCostUsd: undefined as number | undefined };
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRetry(id: string, at: number): void {
  clearTimeout(retryTimers.get(id));
  retryTimers.set(
    id,
    setTimeout(() => {
      retryTimers.delete(id);
      if (stopping || restarting) return;
      void store
        .fireAutoRetry(id)
        .then((fired) => fired && console.log(`[retry] ${id}`))
        .catch((err) => console.warn(`[retry] ${id} ${(err as Error).message}`));
    }, Math.max(0, at - Date.now())),
  );
}

/** Tras fallar: decide si se reintenta y lo deja escrito en la tarea (la app lo enseña). */
async function afterFailure(id: string, feature: Feature, result: FeatureResult, cancelled: boolean): Promise<void> {
  const prev = feature.autoRetry ? { ...feature.autoRetry, nextAt: undefined } : undefined;
  const settings = { on: autoRetrySettings.on, max: autoRetrySettings.max, maxCostUsd: autoRetrySettings.maxCostUsd ?? cfg.maxBudgetUsd };
  const next = decideRetry(prev, { error: result.error, errorCode: result.errorCode, cancelled, costUsd: result.costUsd }, settings, Date.now());
  if (!next) return;
  await store.setAutoRetry(id, next);
  if (next.state === "scheduled" && next.nextAt) {
    await store.event(id, "say", t("retry.scheduled", { n: next.count, max: next.max, min: Math.round((next.nextAt - Date.now()) / 60_000) }));
    scheduleRetry(id, next.nextAt);
  }
}

// "released": la movieron a mano (ya no está en marcha) y el runner la suelta sin escribir su estado.
// cancelled: quien la dirige pidió pararla (no se reintenta nunca sola).
// planLimit: se paró por el límite del plan de Claude Code (queda en espera del límite, no fallida).
type RunOutcome = { status: "done" | "failed" | "waiting" | "execute" | "released"; result: FeatureResult; sessionId?: string; cancelled?: boolean; planLimit?: PlanLimitHit };

/**
 * Informe para Backcode de una acción fallida (diagnostics.ts decide si es de Backcode y lo limpia). En un despliegue
 * importa de dónde salió el comando: detectado o de backcode.toml lo eligió Backcode; un script, el proyecto.
 */
function diagnosticFor(action: Action, result: ActionResult, thrown: Error | undefined) {
  const failedStep = action.type === "deployAll" ? result.steps?.find((s) => !s.ok) : undefined;
  const target = action.type === "deploy" ? action.target : failedStep?.id.startsWith("deploy:") ? failedStep.id.slice("deploy:".length) : undefined;
  const deploy = target ? store.capabilities.deploys.find((d) => d.id === target) : undefined;
  const source: DeploySource | undefined = deploy ? (deploy.config ? "config" : deploy.detected ? "detected" : "script") : undefined;
  const error = thrown ? String(thrown) : String(failedStep?.error ?? result.error ?? "");
  return buildReport({ action: action.type, error, log: thrown?.stack ?? result.log, provider: deploy?.provider, source, thrown: !!thrown }, diagCtx);
}

/**
 * Publica si la sesión de Claude Code de la tarea sigue en este ordenador, para que la app avise en vez de ofrecer
 * «Abrir en la app de Claude» o retomarla. El worktree borrado tras días sin uso no cuenta: se recrea en la misma ruta.
 */
async function publishSession(id: string, sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return true;
  const available = hasTranscript(join(cfg.worktreesDir, id), sessionId);
  await store.setSessionState(id, available, retentionDays()).catch(() => undefined);
  return available;
}

async function runFeature(id: string, feature: Feature): Promise<RunOutcome> {
  // Hecha fuera de Backcode: el runner no tiene su sesión ni su encargo, y empezar de cero pisaría la rama del PR. Vuelve a
  // «PR listo» tal cual; los cambios se siguen haciendo en su worktree (backcode task pr actualiza el PR).
  if (feature.origin === "local" && !feature.sessionId) {
    await store.event(id, "say", t("run.localTask"));
    return { status: "done", result: { ...(feature.result ?? {}), error: undefined } };
  }
  const acceptanceError = await store.verifyAcceptance(id, feature);
  if (acceptanceError) return { status: "failed", result: { error: acceptanceError } };
  // Retomarla con su sesión ya borrada (Claude Code guarda las sesiones cleanupPeriodDays días): no se intenta; vuelve
  // a como estaba (con su PR, si tiene) y la app muestra el aviso.
  if (feature.sessionId && feature.origin !== "local" && !adoptTranscript(join(cfg.worktreesDir, id), feature.sessionId)) {
    const error = t("session.gone", { days: retentionDays() });
    await publishSession(id, feature.sessionId);
    const control = await store.control(id).catch(() => ({}) as LiveControl);
    if (control.remote?.state === "requested") await store.setRemote(id, { state: "failed", code: "sessionGone", error }).catch(() => undefined);
    await store.event(id, "error", error);
    return { status: feature.result?.prUrl ? "done" : "failed", result: { ...(feature.result ?? {}), error } };
  }

  const project = await store.projectInfo();
  // Con sesión previa, es una conversación: se continúa la misma sesión en el mismo worktree y rama.
  const resuming = !!feature.sessionId;
  // Cambio de ejecutor (un admin la pasó a este runner): sin la sesión del otro ordenador, pero con su rama, su punto de
  // guardado (handoff.ts) y el hilo. Una sesión nueva de relevo, sobre lo que ya hay.
  const handoff = !resuming && !!feature.handoff;
  // Modo plan: hasta que quien la ejecuta aprueba el plan, Claude solo lee el repo y propone (o rehace) el plan.
  const planning = !!feature.planFirst && !feature.planApproved;
  const wt = await withRepoLock(() => createWorktree({ repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir, remote: cfg.remote, baseBranch: taskBase(cfg.baseBranch), featureId: id, branch: feature.branch!, resume: resuming || handoff }));
  // Hecha con Claude Code desde el repo: su sesión está guardada en la carpeta del repo, no en la del worktree.
  if (resuming && feature.origin === "local" && !adoptTranscript(wt.path, feature.sessionId!)) {
    await store.event(id, "say", t("run.localTask"));
    return { status: "done", result: { ...(feature.result ?? {}), error: undefined } };
  }
  await store.event(id, "start", resuming ? t("run.resume", { branch: wt.branch }) : handoff ? t("run.handoff", { branch: wt.branch }) : t("run.worktree", { branch: wt.branch, base: `${cfg.remote}/${taskBase(cfg.baseBranch)}` }));
  // Lo que el ejecutor anterior dejó sin subir. Antes de mezclar la base: el punto de guardado continúa la rama de entonces.
  const restored = handoff ? await restoreProgress({ worktree: wt.path, remote: cfg.remote, featureId: id }).catch((err: Error) => (void store.event(id, "say", t("run.handoffRestoreFail", { error: err.message.slice(0, 300) })), "none" as const)) : "none";
  if (restored === "restored") await store.event(id, "start", t("run.handoffRestored"));
  // Al retomar, la rama se pone al día con la base: sin conflictos se sube ya (el PR se actualiza); con conflictos,
  // Claude los resuelve en esta vuelta y el commit de open_pull_request cierra el merge.
  let conflicts: string[] = [];
  if (resuming || (handoff && wt.resumed)) {
    const sync = await mergeBaseIntoBranch(wt.path, cfg.remote, taskBase(cfg.baseBranch)).catch((err: Error) => {
      void store.event(id, "say", t("run.syncFail", { base: taskBase(cfg.baseBranch), error: err.message }));
      return null;
    });
    if (sync?.status === "merged") {
      await pushBranch(wt.path, cfg.remote, wt.branch).catch(() => undefined);
      await store.event(id, "start", t("run.synced", { base: `${cfg.remote}/${taskBase(cfg.baseBranch)}` }));
      await store.setConflicts(id, []).catch(() => undefined);
    } else if (sync?.status === "uptodate") {
      // Ya contiene la base: si quedaba una marca de conflictos de antes, sobra.
      if (feature.conflicts?.length) await store.setConflicts(id, []).catch(() => undefined);
    } else if (sync?.status === "conflicts") {
      conflicts = sync.files;
      await store.event(id, "start", t("run.conflicts", { base: `${cfg.remote}/${taskBase(cfg.baseBranch)}`, files: conflicts.join(", ") }));
    }
  }
  // Dependencias listas antes de Claude (task-deps.ts): dentro del sandbox, instalarlas a menudo no acaba. Planificando
  // solo lee, así que se dejan para cuando se apruebe el plan.
  if (!planning) {
    const deps = await prepareTaskDependencies({ worktree: wt.path, base: `${cfg.remote}/${taskBase(cfg.baseBranch)}` });
    for (const d of deps) {
      const where = d.dir || t("act.root");
      await store.event(id, "start", d.ok ? t("run.deps", { cmd: d.cmd.join(" "), dir: where }) : t("run.depsFail", { cmd: d.cmd.join(" "), dir: where, error: d.error ?? "" }));
    }
  }
  const attachments = await materializeAttachments(store, cfg.projectId, wt.path, feature.attachments ?? []);
  if (attachments.length && !resuming) await store.event(id, "start", t("run.attachments", { n: attachments.length }));

  // Permisos personales (permissions.ts): los suyos del proyecto y lo concedido en el hilo, solo si la tarea la creó y
  // la ejecuta quien tiene este runner. Se suman a los límites de siempre, nunca los quitan.
  const history = resuming || handoff ? await store.thread(id) : [];
  const permCtx = await loadPermissionContext({ applies: appliesTo(feature, store.uid), store, grants: threadGrants(history), projectId: cfg.projectId });
  const { perms, roots } = permCtx;
  const permissionsText = permCtx.prompt;
  const session = sessionPermissions(permCtx, cfg.allowedDomains);
  // Tarea de CI (ci-task.ts): solo el fichero de CI del host y docs, sin Bash ni leer secretos, y su PR nunca se
  // mergea solo. Sin host de PR (push-only) no se puede: el runner tampoco anuncia ciSetup.
  const ciHost = isCiTask(feature) ? prHost?.kind : undefined;
  if (isCiTask(feature) && !ciHost) return { status: "failed", result: { error: t("ci.noMerge", { host: "GitHub / Bitbucket" }) } };
  const ci = ciHost ? ciGuard(ciHost, isProtected) : undefined;
  const taskProtected = ci?.isProtected ?? isProtected;
  const guardExtras = ci ? { ...session.guard, denyRead: ci.denyRead } : session.guard;
  if (ciHost) await store.event(id, "start", t("ci.start", { file: ciFileFor(ciHost) }));
  if (!isEmpty(perms)) await store.event(id, "start", t("run.permissions", { list: [...perms.domains, ...perms.commands, ...roots.map((r) => r.name)].join(", ") }));

  const previousPr = feature.result?.prUrl;
  let prUrl: string | undefined; // PR abierto o actualizado en esta vuelta
  let afterMerge: FeatureResult["afterMerge"]; // pasos tras mergear que declara Claude al abrir el PR
  // Destinos de despliegue del repo (scripts backcode:deploy:*): Claude los puede citar en los pasos tras mergear.
  const deployNames = [...new Set((await findDeployTargets(wt.path, "HEAD").catch(() => [])).map((d) => d.name))];
  let question: string | undefined; // pregunta de Claude (ask_user)
  let permissionAsked = false; // Claude pidió permisos (request_permission): espera, como con una pregunta
  let planned = false; // modo plan: ya propuso el plan en esta vuelta
  const webFetch = session.allowedTools;
  const prServer = createSdkMcpServer({
    name: "backcode",
    version: "1.0.0",
    tools: [
      tool(
        "propose_plan",
        "Plan mode only: send your implementation plan (Markdown) to the people steering this task (the person who accepted it, whoever manages it or a project admin). They review it in the app, ask for changes or approve it; once approved, this same session continues and implements it. Call it once per turn with the complete plan, then end your turn.",
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
          if (files.length === 0 && (await commitsAhead(wt.path, cfg.remote, taskBase(cfg.baseBranch))) === 0) {
            return fail(t("pr.empty"));
          }
          const blocked = files.filter(taskProtected);
          if (blocked.length) return fail(t("pr.protected", { files: blocked.join(", ") }));
          const secrets = await scanStagedForSecrets(wt.path);
          if (secrets.length) return fail(t("pr.secrets", { list: secrets.join("; ") }));

          const footer = `\n\n---\n${t("pr.footer", { id, n: files.length, branch: wt.branch })}\n\n${t("pr.generated")}`;
          try {
            prUrl = await commitPushAndOpenPr({ worktree: wt.path, remote: cfg.remote, baseBranch: taskBase(cfg.baseBranch), branch: wt.branch, title, body: body + footer, featureId: id, host: prHost });
            // Si la rama tenía conflictos con la base, ya están resueltos y subidos: se quita la marca (y el botón de
            // mergear vuelve a aparecer) sin esperar a la comprobación periódica.
            if (conflicts.length || feature.conflicts?.length) await store.setConflicts(id, []).catch(() => undefined);
          } catch (err) {
            await store.event(id, "error", `open_pull_request: ${String(err)}`);
            return fail(t("pr.failed", { error: String(err).slice(0, 500) }));
          }
          await store.event(id, "pr", prUrl);
          // Un punto de guardado de antes ya no hace falta: lo hecho está en la rama.
          void dropProgress({ worktree: wt.path, remote: cfg.remote, featureId: id });
          // Tarea de CI: los ficheros que cambia el PR respecto a la base, para enseñarlos al confirmar su merge en la app.
          if (ciHost) {
            const changed = await git(wt.path, ["diff", "--name-only", `${cfg.remote}/${taskBase(cfg.baseBranch)}...HEAD`]).catch(() => "");
            const list = changed.split("\n").filter(Boolean);
            result = { ...result, ciFiles: (list.length ? list : files).slice(0, 50) };
          }
          // Solo se guardan destinos que el repo declara de verdad (la app no ejecuta nada que el repo no ofrezca).
          // Tarea de CI: sin pasos tras mergear (ni despliegues): se revisa y se mergea a mano.
          afterMerge = ciHost ? undefined : steps?.map((s) => ({ why: s.why, ...(s.command ? { command: s.command } : {}), ...(s.deployTarget && deployNames.includes(s.deployTarget) ? { deployTarget: s.deployTarget } : {}) }));
          const what = t(cfg.pullRequest === "push-only" ? "pr.pushOnly" : "pr.draft");
          return { content: [{ type: "text" as const, text: `${what}: ${prUrl}` }] };
        },
      ),
      tool(
        "request_permission",
        "Ask the person running this task for an extra permission you truly need and don't have yet: read-only network access to specific domains (hostnames), the curl/wget commands, or reading another of their Backcode projects for examples of their own code (only the ids listed as available in your instructions). Give a short, concrete reason. They decide in the app (only this task, always, continue in their own Claude Code, or deny) and this same session continues with their decision. Don't try a blocked action first. After calling it, end your turn without further changes.",
        REQUEST_PERMISSION_INPUT,
        async ({ reason, ...input }) => {
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
          if (question || permissionAsked) return fail(t("perm.pending"));
          const checked = checkPermissionRequest(input, permCtx);
          if ("error" in checked) return fail(checked.error);
          permissionAsked = true;
          await store.postPermissionRequest(id, reason, checked.need);
          await store.event(id, "question", reason.slice(0, 300));
          return { content: [{ type: "text" as const, text: t("perm.sent") }] };
        },
      ),
      tool(
        "ask_user",
        "Ask the people steering this task (the person who accepted it, whoever manages it or a project admin) a blocking clarification question. They answer in the app and this same session continues with their reply. After calling it, end your turn without further changes.",
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
  aborts.set(id, abort);
  // El tiempo máximo cuenta solo mientras trabaja el runner (no mientras la persona está en Remote Control).
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => abort.abort(), cfg.timeoutMinutes * 60_000);
  };
  armTimeout();
  // Si la mueven a mano (p. ej. a «PR listo» mientras está en la app de Claude), las reglas ya no dejan renovarla: el
  // runner la suelta en vez de quedarse esperando para siempre (y sin coger nada más ni poder actualizarse).
  let released = false;
  let onReleased = () => {};
  const releasedNow = new Promise<void>((r) => (onReleased = r));
  const lease = setInterval(() => {
    store.extendLease(id).catch(async () => {
      if (released || (await store.featureStatus(id).catch(() => "running")) === "running") return;
      released = true;
      stopRequested = true;
      onReleased();
      void liveQuery?.interrupt().catch(() => undefined);
    });
  }, FEATURE_LEASE_MS / 3);

  let result: FeatureResult = { branch: wt.branch, prUrl: previousPr, ...(feature.result?.ciFiles ? { ciFiles: feature.result.ciFiles } : {}) };
  let sessionId = feature.sessionId;
  const model = modelFor(feature, cfg.model);
  // Límite del plan de Claude Code: el último rate_limit_event rechazado y, si la vuelta acaba en error por él, el motivo.
  let rateRejected: PlanLimitHit | null = null;
  let planLimit: PlanLimitHit | null = null;
  const noteLimit = (hit: PlanLimitHit | null) => {
    if (!hit) return;
    planLimit = { reason: hit.reason, ...((hit.resetsAt ?? rateRejected?.resetsAt) ? { resetsAt: hit.resetsAt ?? rateRejected?.resetsAt } : {}) };
  };

  // --- Conversación en directo: lo que la persona escribe en el hilo mientras Claude trabaja le llega en su siguiente
  // paso. Cada mensaje va con un uuid; cuando Claude lo incorpora (user_message_uuids) se marca como leído.
  let userMessages: ThreadMessage[] = [];
  const handled = new Set<string>(); // ids de mensajes ya entregados (o incluidos en el prompt)
  const outstanding = new Map<string, string>(); // uuid enviado -> id del mensaje, pendiente de que Claude lo lea
  let liveChain: Promise<void> = Promise.resolve();
  let liveQuery: Query | null = null;
  // Coste y tokens de las fases anteriores (con Remote Control de por medio hay varias): se suman.
  let spent = { costUsd: 0, turns: 0, input: 0, output: 0, cache: 0 };
  // Consumo en directo (tokens y coste) y modelo real: la app los enseña mientras se ejecuta.
  const live = new LiveUsage();
  let runModel: string | undefined;
  let inputQueue: SDKUserMessage[] = [];
  let inputOpen = false;
  let wake: (() => void) | null = null;
  const flushLive = () => {
    if (!inputOpen) return;
    for (const m of userMessages) {
      if (!m.id || m.read || handled.has(m.id) || m.kind !== "message") continue;
      // Con vídeo, se espera al análisis del servidor (processFeatureVideo): al acabar, el hilo vuelve a avisar. Los
      // siguientes también esperan, para que lleguen en orden.
      if (videosPending([m])) break;
      handled.add(m.id);
      const uuid = randomUUID();
      const mid = m.id;
      outstanding.set(uuid, mid);
      // Los adjuntos se descargan en la copia de trabajo antes de pasárselo (en cadena, para mantener el orden).
      liveChain = liveChain.then(async () => {
        const prepared = await promptMessage(store, cfg.projectId, wt.path, m).catch((err: Error) => (console.warn(`[messages] ${err.message}`), { text: m.text }));
        // Si la fase acabó mientras tanto, el mensaje ya vuelve a estar pendiente (se entrega en la siguiente).
        if (!inputOpen || outstanding.get(uuid) !== mid) return;
        inputQueue.push({ type: "user", message: { role: "user", content: buildLiveContent(prepared) }, parent_tool_use_id: null, uuid, priority: "next" });
        wake?.();
      });
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
          append: buildSystemAppend({ projectName: project.name, projectContext: project.context, worktree: wt.path, branch: wt.branch, baseBranch: taskBase(cfg.baseBranch), remote: cfg.remote, language: LANGUAGE_NAME[lang()], permissions: permissionsText }) + (ciHost ? ciSystemAppend(ciHost) : ""),
        },
        // No cargamos settings de usuario ni del repo: permisos y hooks los define solo este runner.
        settingSources: [],
        // dontAsk: todo lo que no esté en allowedTools se deniega sin preguntar.
        permissionMode: "dontAsk",
        // Planificando solo puede leer el repo y proponer el plan (o preguntar); sin editar ni ejecutar comandos.
        allowedTools: planning
          ? ["Read", "Glob", "Grep", "TodoWrite", "mcp__backcode__propose_plan", "mcp__backcode__ask_user", "mcp__backcode__request_permission", ...webFetch]
          : ciHost
            ? [...CI_TOOLS, "mcp__backcode__open_pull_request", "mcp__backcode__ask_user", "mcp__backcode__request_permission", ...webFetch]
            : ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "TodoWrite", "mcp__backcode__open_pull_request", "mcp__backcode__ask_user", "mcp__backcode__request_permission", ...webFetch],
        // WebFetch solo con dominios concedidos, y solo a esos (allowedTools con su regla de dominio).
        disallowedTools: ciHost ? [...(session.disallowedTools ?? []), "Bash", "NotebookEdit"] : session.disallowedTools,
        hooks: { PreToolUse: [{ hooks: [createGuardHook(wt.path, taskProtected, guardExtras)] }] },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: session.allowedDomains, strictAllowlist: true },
          filesystem: { denyRead: DENY_READ, allowWrite: [wt.path] },
        },
        mcpServers: { backcode: prServer },
        maxTurns: cfg.maxTurns,
        maxBudgetUsd: cfg.maxBudgetUsd,
      },
    });
    liveQuery = messages;
    // Como mucho una escritura cada 20 s (y una al acabar cada turno).
    const liveWrite = throttled(() => store.setLiveUsage(id, live.snapshot()), 20_000);
    try {
      for await (const msg of messages) {
        clearTimeout(quiet);
        if (msg.type === "assistant") {
          live.assistant(msg.message.id, msg.message.model, msg.message.usage);
          liveWrite.touch();
          // Mensajes de la persona que Claude acaba de incorporar.
          const read = (msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : [])).filter((u) => outstanding.has(u));
          if (read.length) {
            void store.markRead(id, read.map((u) => outstanding.get(u)!));
            read.forEach((u) => outstanding.delete(u));
            // Ha respondido (o pedido cambios) en esta misma vuelta: la pregunta o el plan anteriores ya no esperan.
            question = undefined;
            permissionAsked = false;
            planned = false;
          }
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              // Lo que Claude va contando ("Voy a…"): da contexto a la actividad.
              await store.event(id, "say", block.text.trim().replace(/\n{3,}/g, "\n\n"));
            } else if (block.type === "tool_use") {
              await store.event(id, "tool", describeTool(block.name, block.input as Record<string, unknown>, wt.path));
            }
          }
        } else if (msg.type === "system" && msg.subtype === "init") {
          if (msg.session_id && msg.session_id !== sessionId) await store.setSession(id, msg.session_id);
          sessionId = msg.session_id;
          // Modelo real (al empezar y al reanudar): con «por defecto», la app ya no tiene que esperar al final.
          const real = cleanModelId(msg.model);
          if (real && real !== runModel) {
            runModel = real;
            await store.setRunModel(id, real);
          }
        } else if (msg.type === "rate_limit_event") {
          rateRejected = planLimitFromEvent(msg.rate_limit_info);
        } else if (msg.type === "result") {
          sessionId = msg.session_id;
          // Acabó en error por el límite del plan (texto de Claude Code, un 429 o un rate_limit_event rechazado).
          if (msg.is_error || msg.subtype !== "success") {
            const text = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
            noteLimit(planLimitFromText(text) ?? rateRejected ?? ("api_error_status" in msg && msg.api_error_status === 429 ? { reason: "429" } : null));
          }
          const usage = usageFromResult(msg.modelUsage, msg.total_cost_usd, msg.num_turns, spent);
          live.result(usage);
          liveWrite.touch(true);
          result = {
            ...result,
            model,
            ...usage,
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
      await liveWrite.stop();
      live.endPhase(spent);
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
    // Sesión ya borrada del ordenador: el mismo aviso que en la app, sin lanzar claude.
    const sessionGone = async () => {
      const error = t("session.gone", { days: retentionDays() });
      await store.setRemote(id, { state: "failed", code: "sessionGone", error }).catch(() => undefined);
      await store.event(id, "error", error);
      await publishSession(id, sessionId);
      return false;
    };
    if (!adoptTranscript(wt.path, sessionId)) return sessionGone();
    clearTimeout(timeout);
    await store.event(id, "start", t("remote.opening"));
    try {
      remoteSession = await startRemoteControl({ bin, cwd: wt.path, sessionId, name: `${project.name} · ${feature.title}`.slice(0, 80) });
    } catch (err) {
      remoteSession = null;
      if (isSessionGoneError((err as Error).message)) {
        armTimeout();
        return sessionGone();
      }
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
        if (block.type === "text" && block.text?.trim()) void store.event(id, "say", block.text.trim().replace(/\n{3,}/g, "\n\n"));
        else if (block.type === "tool_use" && block.name) void store.event(id, "tool", describeTool(block.name, block.input ?? {}, wt.path));
      }
    });
    // Soltada a mano: la sesión de la app de Claude sigue abierta (es tuya); el runner solo deja de esperarla.
    await Promise.race([session.exited, releasedNow]);
    unfollow();
    abort.signal.removeEventListener("abort", onAbort);
    remoteSession = null;
    if (released) return true;
    await store.setRemote(id, null).catch(() => undefined);
    await store.event(id, "start", t("remote.back"));
    armTimeout();
    return true;
  }

  /** Suma el coste de una sesión aparte (el review) al de la tarea, como el resto de su trabajo. */
  const reviewModels: ReviewSpend["models"] = {};
  const addSpend = (s: ReviewSpend) => {
    for (const [name, m] of Object.entries(s.models)) {
      const prev = reviewModels[name];
      reviewModels[name] = prev ? { costUsd: prev.costUsd + m.costUsd, tokens: prev.tokens + m.tokens, input: prev.input + m.input, output: prev.output + m.output, cache: prev.cache + m.cache } : { ...m };
    }
    const all = Object.values(s.models);
    const sum = (k: "input" | "output" | "cache") => all.reduce((n, m) => n + m[k], 0);
    result = {
      ...result,
      costUsd: (result.costUsd ?? 0) + s.costUsd,
      turns: (result.turns ?? 0) + s.turns,
      tokens: { input: (result.tokens?.input ?? 0) + sum("input"), output: (result.tokens?.output ?? 0) + sum("output"), cache: (result.tokens?.cache ?? 0) + sum("cache") },
    };
    spent = { costUsd: result.costUsd ?? 0, turns: result.turns ?? 0, input: result.tokens?.input ?? 0, output: result.tokens?.output ?? 0, cache: result.tokens?.cache ?? 0 };
  };

  /** Sube lo que arregló la sesión de la tarea tras el review (con las mismas comprobaciones que open_pull_request). */
  async function pushReviewFix(before: string): Promise<boolean> {
    const files = await stageAll(wt.path);
    const blocked = files.filter(taskProtected);
    const secrets = blocked.length ? [] : await scanStagedForSecrets(wt.path);
    if (blocked.length || secrets.length) {
      // Se quita del índice y no se sube: queda en el worktree para revisarlo a mano.
      await git(wt.path, ["restore", "--staged", "."]).catch(() => undefined);
      await store.event(id, "error", blocked.length ? t("pr.protected", { files: blocked.join(", ") }) : t("pr.secrets", { list: secrets.join("; ") }));
      return false;
    }
    if (files.length) await git(wt.path, ["commit", "--quiet", "--no-verify", "-m", t("review.commit")]);
    if ((await git(wt.path, ["rev-parse", "HEAD"])) === before) return false;
    await pushBranch(wt.path, cfg.remote, wt.branch);
    return true;
  }

  /**
   * Code review automático: una pasada en una sesión nueva (sin el contexto de la tarea); los fallos graves vuelven a la
   * sesión de la tarea, el runner sube el arreglo y revisa una vez más. Lo que quede, en la tarea y en el PR.
   */
  async function reviewAndFix(level: ReviewLevel): Promise<void> {
    let review: ReviewState = { state: "reviewing", level, passes: 0, findings: [], costUsd: 0 };
    const save = () => store.setReview(id, review).catch((err: Error) => console.error("[review]", err.message));
    const pass = async () => {
      review = { ...review, state: "reviewing" };
      await save();
      await store.event(id, "start", t(review.passes ? "review.retry" : "review.start", { level }));
      const r = await runReview({ cwd: wt.path, branch: wt.branch, base: `${cfg.remote}/${taskBase(cfg.baseBranch)}`, level, model, env: agentEnv(), isProtected: taskProtected, denyRead: DENY_READ, allowedDomains: cfg.allowedDomains, maxTurns: cfg.maxTurns, maxBudgetUsd: cfg.maxBudgetUsd, signal: abort.signal });
      addSpend(r.spend);
      review = { ...review, passes: review.passes + 1, costUsd: review.costUsd + r.spend.costUsd, findings: r.findings ?? review.findings };
      return r;
    };
    let r = await pass();
    const major = majorOf(r.findings ?? []);
    if (major.length && !stopRequested && !abort.signal.aborted) {
      await store.event(id, "start", t("review.fixing", { n: major.length }));
      const summary = result.summary;
      const before = await git(wt.path, ["rev-parse", "HEAD"]);
      await runPhase(reviewFixPrompt(r.findings!));
      // El resumen de la tarea sigue siendo el de su implementación; el del arreglo va a la actividad.
      if (result.summary && result.summary !== summary) await store.event(id, "say", result.summary);
      result = { ...result, summary, error: undefined };
      const pushed = await pushReviewFix(before).catch(async (err: Error) => {
        await store.event(id, "error", t("review.pushFailed", { error: err.message.slice(0, 300) }));
        return false;
      });
      if (pushed && !stopRequested && !abort.signal.aborted) r = await pass();
    }
    // Coste por modelo: el de las sesiones del review se suma al de la tarea.
    const models = { ...(result.models ?? {}) };
    for (const [name, m] of Object.entries(reviewModels)) models[name] = { costUsd: (models[name]?.costUsd ?? 0) + m.costUsd, tokens: (models[name]?.tokens ?? 0) + m.tokens, cache: (models[name]?.cache ?? 0) + m.cache };
    result = { ...result, models };

    const left = majorOf(review.findings);
    review = r.findings === null ? { ...review, state: "error", error: r.error ?? "review failed" } : { ...review, state: left.length ? "findings" : "approved" };
    await save();
    const text = review.state === "error" ? t("review.error", { error: review.error ?? "" }) : review.state === "approved" ? t("review.approved", { n: review.findings.length }) : t("review.findings", { n: left.length });
    await store.event(id, review.state === "approved" ? "start" : "error", text);
    if (review.findings.length && prHost?.comment && cfg.pullRequest !== "push-only") {
      const body = reviewComment(review, { title: t("review.commentTitle"), approved: t("review.commentApproved"), blocking: t("review.commentBlocking"), minor: t("review.commentMinor") });
      await prHost.comment(prUrl!, body).catch((err: Error) => store.event(id, "say", t("review.commentFailed", { error: err.message.slice(0, 300) })));
    }
  }

  try {
    let thread = history;
    // Lo que escribió quien la ejecuta y Claude aún no ha recibido. Las tareas de antes de los mensajes en directo no
    // tienen marcas de leído: ahí cuenta lo escrito desde el último mensaje de Claude, y lo anterior se da por leído.
    const pendingOf = (list: ThreadMessage[]) => {
      const fromUser = list.filter((m) => m.author === "user");
      const lastClaude = list.map((m) => m.author).lastIndexOf("claude");
      const legacy = !fromUser.some((m) => m.read);
      const replies = legacy ? list.slice(lastClaude + 1).filter((m) => m.author === "user") : fromUser.filter((m) => !m.read);
      return { replies, seen: legacy ? fromUser.filter((m) => !replies.includes(m)) : [] };
    };
    // Un vídeo recién enviado: se espera al análisis del servidor (processFeatureVideo) como en la conversación con el runner.
    const videoStart = Date.now();
    if (videosPending(pendingOf(thread).replies)) await store.event(id, "start", t("ch.analyzingVideo"));
    while (videosPending(pendingOf(thread).replies) && Date.now() - videoStart < VIDEO_WAIT_MS && !abort.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      thread = await store.thread(id);
    }
    const { replies: pendingReplies, seen } = pendingOf(thread);
    // Sus adjuntos (y los fotogramas del vídeo) se descargan en la copia de trabajo para que Claude los lea.
    const replies = await Promise.all(pendingReplies.map((m) => promptMessage(store, cfg.projectId, wt.path, m).catch((err: Error) => (console.warn(`[messages] ${err.message}`), { text: m.text }))));
    // Todo lo ya existente cuenta como entregado: lo de antes ya lo recibió en vueltas anteriores y lo nuevo va en el prompt.
    for (const m of [...pendingReplies, ...seen]) if (m.id) handled.add(m.id);
    const delivered = [...pendingReplies, ...seen].map((m) => m.id).filter((m): m is string => !!m);
    if (delivered.length) void store.markRead(id, delivered);
    // Recién aprobado: el último mensaje de Claude es un plan y aún no hay PR.
    const justApproved = !!feature.planApproved && !previousPr && thread.filter((m) => m.author === "claude").pop()?.kind === "plan";
    const prompt = handoff
      ? buildHandoffPrompt(id, ciHost ? { ...feature, title: "CI", refinedPrompt: buildCiPrompt(ciHost), acceptanceCriteria: [] } : feature, {
          attachments,
          thread: thread.filter((m) => m.kind !== "grant" && m.kind !== "permission").map((m) => ({ author: m.author, kind: m.kind, text: m.text })),
          replies,
          hasPr: !!previousPr,
          planning,
          planApproved: !!feature.planApproved,
          restored: restored === "restored",
          base: taskBase(cfg.baseBranch),
          conflicts,
        })
      : planning
      ? resuming
        ? buildPlanFollowUpPrompt(replies)
        : buildPlanPrompt(id, ciHost ? { ...feature, title: "CI", refinedPrompt: buildCiPrompt(ciHost), acceptanceCriteria: [] } : feature, attachments)
      : justApproved
        ? buildApprovedPlanPrompt(replies)
        : resuming
          ? buildFollowUpPrompt(replies, !!previousPr, { base: taskBase(cfg.baseBranch), files: conflicts })
          : ciHost
            ? buildCiPrompt(ciHost)
            : buildUserPrompt(id, feature, attachments);
    if (model) await store.event(id, "say", t("run.model", { model }));
    // Pedida desde la app con la tarea parada: primero Remote Control, y al volver sigue el runner.
    if (remoteWanted && resuming && (await runRemote())) {
      if (!stopRequested) await runPhase(buildAfterRemotePrompt({ planning, hasPr: !!previousPr }));
    } else {
      if (planning) await store.event(id, "start", t(resuming || handoff ? "run.replanning" : "run.planning"));
      else if (justApproved) await store.event(id, "start", t("run.planApproved"));
      await runPhase(prompt);
    }
    // Pedida mientras trabajaba: se interrumpe su turno, se abre Remote Control y al volver sigue la misma sesión.
    while (remoteWanted && !stopRequested && !abort.signal.aborted) {
      if (!(await runRemote())) break;
      if (stopRequested) break;
      await runPhase(buildAfterRemotePrompt({ planning, hasPr: !!(prUrl ?? previousPr) }));
    }
    // Code review automático (ajuste del proyecto): solo si esta vuelta abrió o actualizó el PR y terminó sin más pendiente.
    if (project.codeReview && prUrl && !planning && !stopRequested && !remoteWanted && !question && !permissionAsked && !released && !abort.signal.aborted) {
      const level = project.codeReview;
      // Un fallo inesperado no deja la tarea «revisando» para siempre: queda como no aprobada.
      await reviewAndFix(level).catch(async (err: Error) => {
        await store.setReview(id, { state: "error", level, passes: 0, findings: [], costUsd: 0, error: err.message }).catch(() => undefined);
        await store.event(id, "error", t("review.error", { error: err.message.slice(0, 300) }));
      });
    } else if (!project.codeReview && prUrl && feature.review) {
      // Desactivado desde la última revisión: el resultado anterior ya no describe los cambios de ahora.
      await store.setReview(id, null).catch(() => undefined);
    }
  } catch (err) {
    result.error = abort.signal.aborted ? (stopping ? t("run.stopped") : t("run.timeout", { min: cfg.timeoutMinutes })) : String(err);
    // Claude Code se cerró por el límite del plan: no es un fallo (ni de Backcode).
    if (!abort.signal.aborted) noteLimit(planLimitFromText(String(err)) ?? rateRejected);
    // Si no es de Backcode (plan, presupuesto, proyecto…), la app lo explica en la tarea.
    const category = abort.signal.aborted ? null : notOurs(String(err));
    if (category) result.notOurs = category;
    // Un error interno del runner (no parar ni agotar el tiempo): a Backcode, si quien lo usa lo permite.
    if (!abort.signal.aborted && !planLimit) void report(store, buildReport({ action: "feature", error: String(err), log: (err as Error)?.stack, thrown: true }, diagCtx));
  } finally {
    clearTimeout(timeout);
    clearInterval(lease);
    unwatchFeature();
    unwatchMessages();
    // Se asigna dentro de runRemote: TypeScript no lo ve desde aquí.
    const leftOpen = remoteSession as RemoteSession | null;
    leftOpen?.stop();
    if (leftOpen) await store.setRemote(id, null).catch(() => undefined);
    aborts.delete(id);
    // El worktree se conserva: la conversación puede continuar (se limpia tras días sin uso).
  }

  if (released) {
    // El PR que abriera Claude desde la app de Claude en la rama de la tarea queda enlazado (si la dejaron en «PR listo»).
    const pr = !previousPr && prHost ? (await prHost.listOpen().catch(() => [])).find((p) => p.branch === wt.branch) : undefined;
    if (pr) await store.setPrUrl(id, pr.url).catch(() => undefined);
    return { status: "released", result: { ...result, prUrl: pr?.url ?? previousPr }, sessionId };
  }
  // Parada desde la app: queda esperando a que la persona escriba (con el PR que hubiera).
  if (stopRequested && !stopping) {
    const pr = prUrl ?? previousPr;
    return { status: pr ? "done" : "waiting", result: { ...result, prUrl: pr, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId };
  }
  // Pidieron abrirla en la app de Claude mientras terminaba (o justo cuando falló): la petición no se pudo atender en esta
  // vuelta. Vuelve a la cola y la siguiente empieza abriendo Remote Control, en vez de dejar la app esperando para siempre.
  if (remoteWanted && !stopping && sessionId) {
    return { status: "execute", result: { ...result, prUrl: prUrl ?? previousPr, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId };
  }
  // Parada por el límite del plan de Claude Code: en espera del límite (no fallida); el runner la retoma sola, en la
  // misma sesión y rama, cuando vuelve la cuota. Lo que respondió Claude Code (el aviso del límite) no va al hilo.
  const limitHit = planLimit as PlanLimitHit | null;
  if (limitHit && !question && !permissionAsked && !planned) {
    return { status: "waiting", result: { ...result, prUrl: prUrl ?? previousPr, summary: undefined, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId, planLimit: limitHit };
  }
  // El resumen de cada vuelta queda en el hilo; si preguntó o propuso un plan, eso ya está publicado.
  if (!question && !permissionAsked && !planned && result.summary) await store.postMessage(id, "summary", result.summary).catch(() => undefined);
  // Mensajes que llegaron al final y Claude no llegó a leer: vuelve a la cola y la siguiente vuelta empieza por ellos.
  const unread = userMessages.some((m) => m.kind === "message" && !m.read && !handled.has(m.id ?? ""));
  if (unread && !result.error && !stopping) {
    return { status: "execute", result: { ...result, prUrl: prUrl ?? previousPr, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId };
  }
  if ((question || permissionAsked) && !result.error) return { status: "waiting", result: { ...result, error: undefined }, sessionId };
  // Plan propuesto: espera a que lo aprueben o pidan cambios (como una pregunta).
  if (planned && !result.error) return { status: "waiting", result: { ...result, planReady: true, error: undefined }, sessionId };
  if (planning) return { status: "failed", result: { ...result, error: result.error ?? t("run.noPlan"), ...(result.error ? {} : { errorCode: "noPlan" as const }) }, sessionId, cancelled: stopRequested && !released };
  if (prUrl) return { status: "done", result: { ...result, prUrl, error: undefined, ...(afterMerge?.length ? { afterMerge } : {}) }, sessionId };
  // Continuación sin cambios nuevos (p. ej. solo respondió una duda): sigue con el PR que ya había.
  if ((resuming || handoff) && previousPr && !result.error) return { status: "done", result: { ...result, prUrl: previousPr }, sessionId };
  // Acabó sin PR pero con trabajo hecho (p. ej. no pudo pasar los tests y pregunta cómo seguir en su resumen): espera a
  // quien la ejecuta, que puede contestarle en el hilo, en vez de darla por fallida.
  if (!result.error && sessionId && (await hasWork(wt.path))) {
    await store.event(id, "say", t("run.noPrWaiting"));
    return { status: "waiting", result: { ...result, error: undefined }, sessionId };
  }
  return { status: "failed", result: { ...result, error: result.error ?? t("run.noPr"), ...(result.error ? {} : { errorCode: "noPr" as const }) }, sessionId, cancelled: stopRequested && !released };
}

/** ¿Hay cambios sin publicar en el worktree (sin commitear o commits por delante de la base)? */
async function hasWork(worktree: string): Promise<boolean> {
  const dirty = await git(worktree, ["status", "--porcelain"]).then((o) => o.trim().length > 0, () => false);
  return dirty || (await commitsAhead(worktree, cfg.remote, taskBase(cfg.baseBranch)).catch(() => 0)) > 0;
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

/**
 * Arranca tareas de la cola mientras haya hueco: límite personal del proyecto, total del ordenador (huecos compartidos
 * en ~/.backcode/slots), freno por RAM/disco y nunca dos de la misma conversación a la vez. Las que esperan publican el
 * motivo (runners/{uid}.queue) para que la app lo enseñe en su tarjeta.
 */
async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  clearTimeout(drainRetry);
  let reason: QueueReason | null = null;
  try {
    while (!stopping && !restarting) {
      // Las ya reanudadas por el runner (sin marca, p. ej. con reglas antiguas) también pasan aunque otras sigan esperando.
      const queue = pending.map((p) => (!p.resumeNow && quotaWaits.isResumed(p.id) ? { ...p, resumeNow: true } : p));
      const pick = nextTask(queue, [...running.values()], effectiveProjectLimit(limits.project, limits.machine), quotaWaits.blockedUntil() > 0);
      if (!pick.task) {
        reason = pick.reason;
        break;
      }
      const brake = brakeReason(await quickCheck(WORKTREES_ROOT).catch(() => ({ pressure: "normal" as const, diskFree: Number.MAX_SAFE_INTEGER })));
      if (brake) {
        reason = brake;
        break;
      }
      const task = pick.task;
      const releaseSlot = takeSlot(SLOTS_DIR, cfg.projectId, task.id, limits.machine);
      if (!releaseSlot) {
        reason = "machine";
        break;
      }
      pending = pending.filter((p) => p.id !== task.id);
      const feature = await store.claim(task.id).catch((err) => {
        console.warn(`[claim] ${task.id} ${(err as Error).message}`);
        return null;
      });
      if (!feature) {
        releaseSlot();
        continue;
      }
      running.set(task.id, task);
      // Reanudada (sola o con «Reprèn ara»): ya no retiene la cola; conserva los intentos por si vuelve a toparse con el límite.
      quotaWaits.markResumed(task.id);
      void runOne(task.id, feature).finally(() => {
        releaseSlot();
        running.delete(task.id);
        void drain();
      });
    }
  } finally {
    busy = false;
  }
  // Esperando por RAM, disco o el total del ordenador (que liberan otros procesos): se vuelve a mirar en 30 s.
  if (reason === "memory" || reason === "disk" || reason === "machine") drainRetry = setTimeout(() => void drain(), 30_000);
  // Límite del plan: se vuelve a mirar al acabar (como mucho cada 30 min; la represa también despierta la cola).
  else if (reason === "quota") drainRetry = setTimeout(() => void drain(), Math.min(Math.max(quotaWaits.blockedUntil() - Date.now(), 0) + 1_000, 30 * 60_000));
  await publishQueue(reason);
}

async function publishQueue(reason: QueueReason | null): Promise<void> {
  const ids = reason ? pending.map((p) => p.id).slice(0, 50) : [];
  const key = reason ? `${reason}:${ids.join(",")}` : "";
  if (key === queueKey || stopping) return;
  queueKey = key;
  if (reason) console.log(`[queue] ${t(`queue.${reason}`)}`);
  await store.setQueue(reason ? { reason, featureIds: ids } : null).catch((err) => console.warn(`[queue] ${(err as Error).message}`));
}

async function runOne(id: string, feature: Feature): Promise<void> {
  console.log(`[run] ${id} · ${feature.title}`);
  const release = awake.hold();
  try {
    const { status, result, sessionId, cancelled, planLimit } = await runFeature(id, feature);
    // Parada sin PR (necesita respuesta, fallida o en espera del límite): lo hecho se sube aparte, por si un admin la pasa a
    // otro ejecutor. Antes del estado, para que ya esté cuando la app la enseñe parada.
    if (status === "waiting" || status === "failed" || planLimit) await checkpoint(id, feature);
    if (status === "released") {
      console.log(`[released] ${id} ${result.prUrl ?? ""}`);
      return;
    }
    if (planLimit) {
      await waitForQuota(id, feature, planLimit, result, sessionId);
      return;
    }
    quotaWaits.delete(id);
    // Ha trabajado con Claude sin toparse con el límite: la cuota está disponible y las demás en espera se reanudan ya.
    if ((result.turns ?? 0) > 0 && quotaWaits.release()) void checkQuotaWaits();
    if (stopping && !result.prUrl && status !== "waiting" && status !== "execute") {
      await store.requeue(id);
    } else {
      // Volver a la cola con mensajes sin leer necesita las reglas nuevas: sin ellas, queda esperando (no fallida).
      const fallback = result.prUrl ? "done" : "waiting";
      await store.finish(id, status, result, sessionId).catch((err) => (status === "execute" ? store.finish(id, fallback, result, sessionId) : Promise.reject(err)));
      await store.event(id, status, result.prUrl ?? result.error ?? "");
      // Un PR de CI nunca entra en el modo auto: se revisa y se mergea a mano.
      if (status === "done" && result.prUrl?.startsWith("https://") && !isCiTask(feature)) queueAutoMerge(id);
      if (status === "failed") await afterFailure(id, feature, result, !!cancelled).catch((err) => console.warn(`[retry] ${id} ${(err as Error).message}`));
    }
    console.log(`[${status}] ${id} ${result.prUrl ?? result.error ?? ""}`);
    void refreshQuota();
    void publishSession(id, sessionId ?? feature.sessionId);
  } catch (err) {
    console.error(`[error] ${id}`, err);
    const result = { error: String(err).slice(0, 2000) };
    await checkpoint(id, feature);
    await store.finish(id, "failed", result).catch(() => undefined);
    await afterFailure(id, feature, result, false).catch(() => undefined);
  } finally {
    release();
  }
}

/** Punto de guardado de una tarea parada (handoff.ts): nunca la hace fallar ni la retrasa más de lo que tarde el push. */
async function checkpoint(id: string, feature: Feature): Promise<void> {
  const worktree = join(cfg.worktreesDir, id);
  if (!feature.branch || isCiTask(feature) || feature.origin === "local" || !existsSync(worktree)) return;
  const saved = await saveProgress({ worktree, remote: cfg.remote, baseBranch: taskBase(cfg.baseBranch), branch: feature.branch, featureId: id, isProtected }).catch((err: Error) => {
    console.warn(`[checkpoint] ${id} ${err.message}`);
    return null;
  });
  if (saved?.saved) await store.event(id, "say", t("run.checkpoint", { n: saved.files })).catch(() => undefined);
  else if (saved && saved.reason !== "clean") await store.event(id, "say", t("run.checkpointSkipped", { files: (saved.files ?? []).join(", ").slice(0, 300) })).catch(() => undefined);
}

/**
 * La tarea se paró por el límite del plan de Claude Code: queda en espera del límite (waiting + waitingQuota) con la hora
 * prevista de represa, y no se arranca ninguna otra hasta entonces (fallarían igual). Si las reglas desplegadas aún no
 * aceptan la marca, vuelve a la cola ('execute', la transición de siempre) retenida hasta su hora (quota-waits.ts, que
 * sobrevive a los reinicios); y si ni eso, queda en espera sin marca y se avisa en la tarea: nunca en silencio.
 */
async function waitForQuota(id: string, feature: Feature, hit: PlanLimitHit, result: FeatureResult, sessionId: string | undefined): Promise<void> {
  // Intentos seguidos: los que llevaba la tarea (en memoria, o en la marca si la reanudaron desde la app) más este.
  const tries = (quotaWaits.get(id)?.tries ?? feature.waitingQuota?.tries ?? 0) + 1;
  const quota = hit.resetsAt ? null : await readQuota(agentEnv()).catch(() => null);
  const until = waitUntil(hit, quota, tries - 1);
  const time = new Date(until).toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" });
  const reason = hit.reason.slice(0, 200);
  const mode = await parkForQuota(quotaWaits, quotaStore(result, sessionId, { until, reason: hit.reason, tries }), id, until, tries, (msg) => console.warn(`[quota] ${msg}`));
  const say = mode === "unmarked" ? t("run.planLimitManual", { time, reason }) : t("run.planLimit", { time, reason });
  await store.event(id, "say", say);
  console.log(`[quota] ${id} ${say}`);
  void refreshQuota();
  void publishSession(id, sessionId ?? feature.sessionId);
}

/** Las operaciones de Firestore de la espera del límite (quota-waits.ts). */
function quotaStore(result: FeatureResult = {}, sessionId?: string, wait?: { until: number; reason: string; tries: number }): QuotaWaitStore {
  return {
    markWaiting: (id) => (wait ? store.finish(id, "waiting", result, sessionId, wait) : Promise.reject(new Error("no wait"))),
    requeue: (id) => store.requeue(id),
    plainWaiting: (id) => store.finish(id, "waiting", result, sessionId),
    resumeFromQuota: (id) => store.resumeFromQuota(id),
    postponeQuota: (id, until, tries) => store.postponeQuota(id, until, tries),
  };
}

/**
 * Represa automática: las tareas en espera del límite cuya hora ya pasó vuelven a la cola (misma sesión y rama) si la
 * cuota lo confirma (quota.ts); si aún está agotada, se aplaza a su reinicio. Sin datos de cuota (API key), por la hora.
 * La que no se puede reanudar sola (sin marca, con reglas antiguas) lo dice en la tarea: la app ofrece «Reprèn ara».
 */
async function checkQuotaWaits(): Promise<void> {
  if (quotaChecking || stopping || restarting) return;
  if (!quotaWaits.due().length) return;
  quotaChecking = true;
  try {
    const still = quotaBlockedUntil(await readQuota(agentEnv()).catch(() => null));
    const out = await resumeDue(quotaWaits, quotaStore(), still, Date.now(), (msg) => console.warn(`[quota] ${msg}`));
    for (const id of out.resumed) console.log(`[quota] ${id} ${t("run.planLimitResume")}`);
    for (const id of out.manual) {
      console.warn(`[quota] ${id} ${t("run.planLimitManualNow")}`);
      await store.event(id, "say", t("run.planLimitManualNow"));
    }
  } finally {
    quotaChecking = false;
  }
  void drain();
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
  const { db, storage, uid, fns } = await connect(cfg);
  store = new Store(db, storage, cfg, uid);
  // Desde aquí, el idioma del perfil del usuario en la app (y en vivo si lo cambia).
  const stopLang = await store.watchLang();
  console.log(`[backcode] ${t("main.user", { uid, project: cfg.projectId, repo: cfg.repoPath, base: `${cfg.remote}/${cfg.baseBranch}`, runner: cfg.runnerId })}`);
  // Ajusta rama base y modo de PR al repo real; los avisos se ven en la terminal y en la app.
  const repo = await checkRepo(cfg.repoPath, cfg.remote, cfg.baseBranch, cfg.pullRequest, !!cfg.bitbucket);
  cfg.baseBranch = repo.baseBranch;
  cfg.pullRequest = repo.pullRequest;
  diagCtx.remoteUrl = repo.remoteUrl || undefined;
  const repoUrl = publicRepoUrl(repo.remoteUrl);
  if (repoUrl) await store.saveRepoUrl(repoUrl).catch(() => undefined);
  prHost = repo.pullRequest === "github" ? githubHost(cfg.repoPath) : repo.pullRequest === "bitbucket" ? bitbucketHost(repo.remoteUrl, cfg.bitbucket!.email, cfg.bitbucket!.token) : undefined;
  store.warnings = repo.warnings;
  const head = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const expoApp = await findExpoApp(cfg.repoPath, head).catch(() => null);
  // Despliegues que el repo declara (scripts backcode:deploy:*): web, api, scripts… cada uno con su botón en la app.
  const deploys = deployCapabilities(await findDeployTargets(cfg.repoPath, head).catch(() => []));
  store.capabilities = {
    pr: prHost?.kind ?? null,
    expo: !!expoApp,
    deploys,
    // Con lo detectado de su configuración (servidor, tipo y script), para que la app lo enseñe tal cual.
    ota: expoApp?.ota ? { channels: expoApp.channels, via: expoApp.ota, ...(expoApp.otaServer ? { server: expoApp.otaServer } : {}), ...(expoApp.otaProvider ? { provider: expoApp.otaProvider } : {}), ...(expoApp.otaScript ? { script: expoApp.otaScript.slice(0, 200) } : {}) } : null,
    // Builds locales para testers: con perfil `production` en eas.json; iOS solo si el runner corre en un Mac.
    build: expoApp?.buildProfiles.includes("production") ? { platforms: process.platform === "darwin" ? ["ios", "android"] : ["android"] } : null,
    // «Instalar en mi móvil»: app Expo y, en este ordenador, Xcode (iOS) o adb (Android).
    install: expoApp ? { platforms: await installPlatforms().catch(() => []) } : null,

    refine: true,
    knowledge: true,
    // Continúa tareas que un admin le pasa desde otro runner (handoff.ts): el servidor solo se las pasa si lo anuncia.
    handoff: true,
    fixConflicts: true,
    fixChecks: true,
    // Checks en local (local-checks.ts): los que declara el backcode.toml de la rama base. La app ofrece «Pasar los checks en
    // local» y el ajuste «Checks en local» solo a runners que lo saben hacer ([] = lo sabe, pero el repo no declara ninguno).
    localChecks: (await localChecksAt(cfg.repoPath, `${cfg.remote}/${cfg.baseBranch}`).catch(() => [])).map((c) => c.name),
    // «Relanzar los checks» (GitHub Actions).
    rerunChecks: prHost?.kind === "github",
    // «Pausar / Reactivar GitHub Actions» y el estado de sus minutos (runners/{uid}.githubActions).
    githubActions: prHost?.kind === "github",
    // Tareas de CI (ci-task.ts): la app ofrece «Prepararla con Claude Code» en «CI y checks» si el repo no tiene CI.
    ciSetup: !!prHost,
    chat: true,
    // Las tareas en espera del límite del plan se reanudan solas (también sin la marca y tras reiniciar): la app avisa si falta.
    quotaResume: true,
    live: true,
    remoteControl: REMOTE_PLATFORMS.includes(process.platform) && !!installedClaude(),
  };
  if (expoApp && !expoApp.ota) console.warn(`\x1b[33m⚠ ${t("main.otaOff", { reason: otaMissing() })}\x1b[0m`);
  for (const w of repo.warnings) console.warn(`\x1b[33m⚠ ${describeWarning(w)}\x1b[0m`);
  const releaseLock = await store.acquireLock();
  // «Pendiente de desplegar»: qué falta por salir (reglas, functions, OTA…) y en qué orden. Al arrancar, cada 3 min y
  // tras cada acción (un despliegue o un merge lo cambian).
  // Si se pide mientras ya se calcula (p. ej. al acabar un despliegue), se repite al terminar: si no, el plan recién
  // desplegado esperaría al siguiente ciclo (hasta 3 min) y la app lo vería como pendiente.
  let planBusy = false;
  let planAgain = false;
  const rulesChecked = new Map<string, number>();
  let ciChecked = "";
  const refreshPlan = async (): Promise<void> => {
    if (planBusy) {
      planAgain = true;
      return;
    }
    planBusy = true;
    planAgain = false;
    try {
      const base = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
      // CI de la rama base: una vez por commit. Sin CI no se da por sabido (los checks de un push tardan en aparecer).
      if (base !== ciChecked) {
        const ci = await detectCi(cfg.repoPath, base, prHost);
        if (ci !== null) await store.saveCi(ci);
        if (ci) ciChecked = base;
      }
      const [found, app] = await Promise.all([findDeployTargets(cfg.repoPath, base).catch(() => null), findExpoApp(cfg.repoPath, base).catch(() => null)]);
      // Un destino añadido (o quitado) en la rama principal sale en la app sin reiniciar el runner.
      if (found) await store.saveDeploys(deployCapabilities(found));
      const targets = found ?? [];
      if (!targets.length && !app?.ota && !app?.buildProfiles.includes("production")) return;
      // Lo que Claude Code desplegó (el hook del plugin lo deja en ~/.backcode/deploylog): ya en la rama principal, se apunta.
      const fromHook = await flushDeployQueue({ projectId: cfg.projectId, repoPath: cfg.repoPath, remote: cfg.remote, baseBranch: cfg.baseBranch, targets, log: (step, sha, via) => store.logDeploy(step, sha, via) }).catch((err: Error) => (console.warn(`[deploy] ${err.message}`), 0));
      if (fromHook) console.log(`[deploy] ${t("deployed.fromHook", { n: fromHook })}`);
      let plan = await computePlan(cfg, store, targets, app, base);
      // Reglas de Firebase que no están al día: si las publicadas son las de la rama principal, lo están.
      let verified = 0;
      for (const s of plan.steps.filter((x) => x.status !== "upToDate" && x.kind === "deploy")) {
        const target = targets.find((d) => `deploy:${d.id}` === s.id);
        const key = `${s.id}@${plan.base}`;
        if (!target || (rulesChecked.get(key) ?? 0) > Date.now() - 30 * 60_000) continue;
        rulesChecked.set(key, Date.now());
        if ((await rulesPublished({ repoPath: cfg.repoPath, base: plan.base, target, lastSha: s.lastSha, token: gcloudToken }).catch(() => null)) !== true) continue;
        await store.logDeploy(s.id, plan.base, "verified").then(
          () => (verified++, console.log(`[deploy] ${t("deployed.verified", { name: s.name })}`)),
          () => undefined,
        );
      }
      if (verified) plan = await computePlan(cfg, store, targets, app, base);
      await store.savePlan(plan);
    } catch (err) {
      console.warn(`[plan] ${(err as Error).message}`);
    } finally {
      planBusy = false;
      if (planAgain) void refreshPlan();
    }
  };
  void refreshPlan();
  const planTimer = setInterval(() => void refreshPlan(), 3 * 60_000);
  // «Ya lo desplegué» desde la app, `backcode deployed` o el runner de otro: se ve al momento.
  const stopDeployLog = store.watchDeployLog(() => void refreshPlan());
  // Lo que deja el hook del plugin: cada minuto (sin esperar a los 3 min del plan).
  const deployQueueTimer = setInterval(() => {
    if (hasQueuedDeploys(cfg.projectId)) void refreshPlan();
  }, 60_000);

  // OTA publicados desde la terminal (el script deja el commit en <app>/.expo): cada minuto, si cambia, las tareas
  // mergeadas que entraron pasan a «Desplegada», como al publicar desde la app.
  let cliSeen = "";
  const watchCliOta = async () => {
    const app = await findExpoApp(cfg.repoPath, "HEAD").catch(() => null);
    if (!app?.ota) return;
    const published = lastCliPublish(cfg.repoPath, app.appDir, cfg.baseBranch);
    const key = JSON.stringify(published);
    if (key === cliSeen || key === "{}") return;
    cliSeen = key;
    const marked = await markCliPublished(store, cfg.repoPath, published);
    if (marked) {
      console.log(`[ota] ${t("ota.cliMarked", { n: marked })}`);
      void refreshPlan();
    }
  };
  void watchCliOta();
  const cliOtaTimer = setInterval(() => void watchCliOta(), 60_000);

  // PR abiertos creados fuera de Backcode (las ramas de tareas, backcode/…, ya salen como tareas): para el tablero, con
  // sus checks. Solo si este runner tiene con qué leerlos (gh con sesión o token de Bitbucket); si falla, se dice por qué.
  const refreshPrs = async () => {
    if (!prHost) return;
    try {
      const all = await prHost.listOpen();
      // PR de una rama de tarea abierto fuera del runner (p. ej. por Claude en la app de Claude): se enlaza a su tarea.
      for (const p of all.filter((x) => x.branch.startsWith("backcode/"))) await store.adoptPr(p.branch, p.url).catch(() => undefined);
      const open = all.filter((p) => !p.branch.startsWith("backcode/")).slice(0, 30);
      const items = await Promise.all(open.map(async (p, i) => ({ ...p, ...(i < 15 ? { checks: (await prHost!.prChecks(p.url).catch(() => null))?.state } : {}) })));
      await store.savePrs({ items: items.map((x) => JSON.parse(JSON.stringify(x)) as typeof x) });
    } catch (err) {
      await store.savePrs({ items: [], error: String((err as Error).message).slice(0, 300) });
    }
  };
  void refreshPrs();
  const prsTimer = setInterval(() => void refreshPrs(), 5 * 60_000);
  // GitHub Actions (github-actions.ts): estado y minutos del mes para la app, aviso si se acaban y reactivación al renovarse.
  const ghActions = prHost?.kind === "github" ? githubActions(cfg.repoPath, cfg.projectId) : undefined;
  let ghActionsBusy = false;
  const refreshActions = async () => {
    if (!ghActions || ghActionsBusy) return;
    ghActionsBusy = true;
    try {
      if (await ghActions.autoResumeIfDue().catch(() => false)) console.log(`[actions] ${t("ga.autoResumed")}`);
      const status = await ghActions.status();
      await store.saveGithubActions(status);
    } catch (err) {
      console.warn(`\x1b[33m⚠ ${t("ga.statusFail", { error: String((err as Error).message).split("\n")[0] })}\x1b[0m`);
    } finally {
      ghActionsBusy = false;
    }
  };
  setGithubActions(ghActions, () => void refreshActions());
  void refreshActions();
  const actionsTimer = setInterval(() => void refreshActions(), 30 * 60_000);
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
  // Si antes de reiniciarse el runner servía la versión de desarrollo, vuelve a hacerlo.
  if (store.capabilities.install?.platforms.length) void resumeDevServer(cfg, store);
  await store.recoverOrphans();
  await store.recoverActions().catch(() => undefined);
  await store.recoverChats().catch(() => undefined);
  await pruneOldWorktrees(cfg.repoPath, cfg.worktreesDir, 14).catch(() => undefined);
  // Al arrancar, tu copia local de la rama base se pone al día si es seguro (p. ej. tras merges hechos por otros).
  const local = await syncLocalBase(cfg.repoPath, cfg.remote, cfg.baseBranch).catch((e: Error) => ({ status: "skipped" as const, reason: e.message, changed: [] as string[] }));
  logLocalSync(cfg, local);
  if (local.status === "updated") await installIfNeeded(cfg.repoPath, local.changed ?? []);

  const project = await store.projectInfo();
  printConnected(project.name);
  // Para el plugin de Claude Code: qué repo es de qué proyecto y con qué pautas (sin claves ni tokens).
  const stopWorkflow = store.watchWorkflow((workflow) => {
    try {
      writeGuard({ projectId: cfg.projectId, projectName: project.name, repoPath: cfg.repoPath, baseBranch: cfg.baseBranch, remote: cfg.remote, workflow: asWorkflow(workflow) });
    } catch (err) {
      console.warn(`[guard] ${(err as Error).message}`);
    }
  });
  const stopRequireChecks = store.watchRequireChecks(setRequireChecks);
  const stopChecksMode = store.watchChecksMode(setChecksMode);
  const stopDeployRetry = store.watchDeployRetry(setDeployRetry);
  // «Rama de preview» (opcional): solo cuenta si es válida y existe en el remoto; si no, todo sigue en la rama base.
  const stopPreviewBranch = store.watchPreviewBranch((branch) => {
    if (!branch) {
      if (previewBranch()) console.log(`[backcode] ${t("env.previewOff", { base: cfg.baseBranch })}`);
      setPreviewBranch(undefined);
      return;
    }
    if (!validPreviewBranch(branch, cfg.baseBranch)) {
      console.warn(`\x1b[33m⚠ ${t("env.previewInvalid", { branch })}\x1b[0m`);
      setPreviewBranch(undefined);
      return;
    }
    void remoteHead(cfg.repoPath, cfg.remote, branch).then(
      () => {
        if (previewBranch() !== branch) console.log(`[backcode] ${t("env.previewOn", { branch: `${cfg.remote}/${branch}`, base: cfg.baseBranch })}`);
        setPreviewBranch(branch);
      },
      () => {
        console.warn(`\x1b[33m⚠ ${t("env.previewMissing", { branch: `${cfg.remote}/${branch}`, base: cfg.baseBranch })}\x1b[0m`);
        setPreviewBranch(undefined);
      },
    );
  });
  const stopAutoMerge = store.watchAutoMerge(({ on, retries }) => {
    autoMergeSettings.on = on;
    autoMergeSettings.retries = clampRetries(retries);
  });
  const stopAutoRetry = store.watchAutoRetry(({ on, max, maxCostUsd }) => {
    autoRetrySettings.on = on;
    autoRetrySettings.max = clampRetryMax(max);
    autoRetrySettings.maxCostUsd = typeof maxCostUsd === "number" && maxCostUsd > 0 ? maxCostUsd : undefined;
  });
  // Reintentos que quedaron programados antes de reiniciar el runner.
  void store
    .scheduledRetries()
    .then((list) => list.forEach((r) => scheduleRetry(r.id, r.nextAt)))
    .catch((err) => console.warn(`[retry] ${(err as Error).message}`));
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
  // Tareas ya marcadas como mergeadas por este runner (las dos comprobaciones no la marcan dos veces).
  const mergedOutside = new Set<string>();
  const markMergedOutside = async (id: string, sha: string | undefined) => {
    if (mergedOutside.has(id)) return;
    mergedOutside.add(id);
    await store.markMerged(id, sha).catch((err) => console.warn(`[merge] ${(err as Error).message}`));
    await store.setConflicts(id, []).catch(() => undefined);
    console.log(`[backcode] ${t("main.mergedOutside", { id })}`);
    // Lo pendiente de desplegar cambia con el merge: se recalcula ya, sin esperar a su ciclo de 3 minutos.
    void refreshPlan();
  };
  const checkConflicts = async () => {
    for (const f of await store.myOpenPrs().catch(() => [])) {
      if (running.has(f.id)) continue; // se está ejecutando
      // ¿Se mergeó a mano en GitHub/Bitbucket? Se marca como mergeada (y la próxima OTA la marcará desplegada).
      if (prHost && f.prUrl?.startsWith("https://")) {
        const pr = await prHost.prState(f.prUrl).catch(() => null);
        if (pr?.state === "merged") {
          await markMergedOutside(f.id, pr.sha);
          continue;
        }
        if (pr?.state === "closed") continue; // cerrado sin mergear: nada que vigilar
      }
      if (!(await fetchBranches(cfg.repoPath, cfg.remote, taskBase(cfg.baseBranch), f.branch).then(() => true, () => false))) continue;
      const key = `${await remoteSha(cfg.repoPath, cfg.remote, taskBase(cfg.baseBranch))}:${await remoteSha(cfg.repoPath, cfg.remote, f.branch)}`;
      if (checked.get(f.id) === key) continue;
      const files = await findConflicts(cfg.repoPath, cfg.worktreesDir, cfg.remote, taskBase(cfg.baseBranch), f.branch).catch(() => null);
      if (files === null) continue;
      checked.set(f.id, key);
      if (files.join("\n") !== f.conflicts.join("\n")) {
        await store.setConflicts(f.id, files).catch(() => undefined);
        if (files.length) console.warn(`\x1b[33m⚠ ${t("main.clash", { id: f.id, base: taskBase(cfg.baseBranch), files: files.join(", ") })}\x1b[0m`);
      }
    }
  };
  void checkConflicts();
  const conflictsTimer = setInterval(() => void checkConflicts(), 5 * 60_000);
  // PR mergeados fuera de la app, cada minuto y con una sola consulta al host (merged-watch.ts); solo si tengo PR abiertos.
  let mergedBusy = false;
  const watchMerged = async () => {
    if (!prHost?.recentlyMerged || mergedBusy) return;
    mergedBusy = true;
    try {
      const open = (await store.myOpenPrs().catch(() => [])).filter((f) => f.prUrl?.startsWith("https://") && !running.has(f.id) && !mergedOutside.has(f.id));
      if (!open.length) return;
      for (const f of findMergedOutside(open, await prHost.recentlyMerged().catch(() => []))) await markMergedOutside(f.id, f.sha);
    } finally {
      mergedBusy = false;
    }
  };
  const mergedTimer = setInterval(() => void watchMerged(), MERGED_POLL_MS);

  // Sesiones de Claude Code de mis tareas paradas, al arrancar y cada 6 h: si Claude Code ya las borró (pasados
  // cleanupPeriodDays días), la app lo avisa en vez de ofrecer abrirlas en la app de Claude o retomarlas.
  const checkSessions = async () => {
    for (const f of await store.mySessionTasks().catch(() => [])) {
      if (running.has(f.id)) continue;
      await publishSession(f.id, f.sessionId);
    }
  };
  void checkSessions();
  const sessionsTimer = setInterval(() => void checkSessions(), 6 * 60 * 60_000);

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
      // La cuota ha vuelto (ninguna ventana al 100 %): las tareas en espera se reanudan ya y la cola deja de estar retenida.
      if (quotaAvailable(quota) && quotaWaits.release()) void checkQuotaWaits();
    } finally {
      quotaBusy = false;
    }
  };
  void refreshQuota();
  const quotaTimer = setInterval(() => void refreshQuota(), 5 * 60_000);
  // Tareas en espera del límite del plan: las de antes de arrancar (fichero local, también las que las reglas no dejaron
  // marcar) y, en directo, las marcadas en Firestore (mías y de compañeros con mi runner). Las que alguien cancela o
  // reanuda a mano dejan de retener la cola. No se arranca nada hasta su hora y luego se retoman solas.
  quotaWaits = new QuotaWaits(join(HOME_DIR, "quota", `${cfg.projectId}-${uid}.json`));
  quotaWaits.load();
  const stopQuotaWaits = store.watchQuotaWaits(
    (waiting, marked) => {
      if (quotaWaits.syncWaiting(waiting, marked).length) void drain();
      void checkQuotaWaits();
    },
    (err) => console.warn(`[quota] ${err.message}`),
  );
  const quotaWaitTimer = setInterval(() => void checkQuotaWaits(), 60_000);
  void checkQuotaWaits();
  const stopQuotaRequests = await store.watchQuotaRequests(() => void refreshQuota()).catch(() => () => undefined);

  // Solo las tareas que este usuario aceptó en este proyecto, por prioridad y orden de aceptación.
  // Más las de compañeros que se aceptaron con mi runner (runnerUid); las mías con el runner de otro, no.
  const queued = { mine: [] as QueryDocumentSnapshot[], shared: [] as QueryDocumentSnapshot[], loaded: { mine: false, shared: false } };
  const requeue = () => {
    pending = [...queued.mine, ...queued.shared]
      // Las archivadas se quedan en la cola sin ejecutarse: al desarchivarlas, el snapshot cambia y vuelven aquí.
      .filter((d) => store.executes(d.data() as Feature) && d.get("archivedAt") == null)
      .map((d) => ({ id: d.id, chatId: typeof d.get("chatId") === "string" ? (d.get("chatId") as string) : undefined, resumeNow: d.get("waitingQuota") != null, priority: (d.get("priority") as number) ?? 0, at: d.get("acceptedAt")?.toMillis?.() ?? 0 }))
      .sort((a, b) => a.priority - b.priority || a.at - b.at)
      .map((d) => ({ id: d.id, chatId: d.chatId, ...(d.resumeNow ? { resumeNow: true } : {}) }));
    // Las que volvieron a la cola sin marca y ya no están (liberadas o descartadas) dejan de retenerla.
    if (queued.loaded.mine && queued.loaded.shared) quotaWaits.syncQueued(new Set([...pending.map((p) => p.id), ...running.keys()]));
    if (pending.length) console.log(`[queue] ${t("main.queue", { n: pending.length })}`);
    void drain();
  };
  const unsubscribeMine = onSnapshot(
    store.myQueue(),
    (snap) => {
      queued.mine = snap.docs;
      queued.loaded.mine = true;
      requeue();
    },
    (err) => {
      console.error("[snapshot] error:", err.message);
      process.exit(1);
    },
  );
  const unsubscribeShared = onSnapshot(
    store.sharedQueue(),
    (snap) => {
      queued.shared = snap.docs;
      queued.loaded.shared = true;
      requeue();
    },
    (err) => console.warn("[snapshot] shared:", err.message),
  );
  const unsubscribe = () => {
    unsubscribeMine();
    unsubscribeShared();
  };

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
        console.log(`[action] ${String(action.type)} ${String(action.featureId ?? action.channel ?? action.target ?? action.deviceName ?? action.deviceId ?? (Array.isArray(action.steps) ? action.steps.join(" → ") : undefined) ?? (Array.isArray(action.platforms) ? `${action.platforms.join("+")} ${String(action.version)}` : ""))}`);
        const actionLease = setInterval(() => void store.extendActionLease(id).catch(() => undefined), 60_000);
        const release = awake.hold();
        // «Actualizar ahora» el mapa del código: aquí mismo (necesita el entorno de Claude y se cancela al cerrar el runner).
        // Igual «Arreglar con Claude» los conflictos de un PR y «Devolver a Claude Code» sus checks en rojo: Claude
        // arregla, el runner commitea y sube.
        const work =
          action.type === "knowledge"
            ? refreshKnowledge(cfg, store, agentEnv(), knowledgeAbort.signal, { force: true }).then((): { ok: boolean; result: ActionResult } => ({ ok: true, result: {} }))
            : action.type === "fixConflicts"
              ? fixConflicts(cfg, store, prHost, agentEnv(), knowledgeAbort.signal, String(action.featureId ?? ""))
              : action.type === "fixChecks"
                ? fixChecks(cfg, store, prHost, { env: agentEnv(), isProtected, denyRead: DENY_READ }, knowledgeAbort.signal, String(action.featureId ?? ""))
                : runAction(cfg, store, prHost, { ...(action as unknown as Action), id });
        let thrown: Error | undefined;
        const { ok, result } = await work
          .catch(async (err): Promise<{ ok: boolean; result: ActionResult }> => {
            thrown = err as Error;
            // Caída pasajera de GitHub/Bitbucket (ya reintentada): decirlo y, si GitHub tiene una incidencia, nombrarla.
            const error = await explainRemoteError(String((err as Error).message ?? err), remoteTexts());
            return { ok: false, result: { error: error.slice(0, 1500) } };
          })
          .finally(() => {
            clearInterval(actionLease);
            release();
          });
        await store.finishAction(id, ok, result as Record<string, unknown>);
        if (!ok) void report(store, diagnosticFor(action as unknown as Action, result, thrown));
        void refreshPlan();
        if (action.type === "closePr" || action.type === "mergePr" || action.type === "merge") void refreshPrs();
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

  // Conversación libre con mi runner (botón junto a «Proponer una idea»): de una en una, en paralelo a las tareas.
  let chatBusy = false;
  let pendingChats: string[] = [];
  const chatAbort = new AbortController();
  const drainChats = async () => {
    if (chatBusy) return;
    chatBusy = true;
    try {
      while (!stopping && !restarting && pendingChats.length) {
        const id = pendingChats.shift()!;
        const chat = await store.claimChat(id).catch(() => null);
        if (!chat) continue;
        const release = awake.hold();
        const project = await store.projectInfo().catch(() => ({ name: "", context: "" }));
        // create_task: la tarea la crea y acepta el servidor (createChatTask) y entra en la cola de este runner (myQueue).
        const createTask = async (input: ChatTaskInput) =>
          (await httpsCallable<Record<string, unknown>, { featureId: string; branch: string }>(fns, "createChatTask")({ projectId: cfg.projectId, chatId: id, ...input, lang: lang() })).data;
        // message_task: el servidor (messageChatTask) comprueba que la tarea es mía y de esta conversación y decide según su estado.
        const messageTask = async ({ taskId, ...rest }: ChatTaskMessage) =>
          (await httpsCallable<Record<string, unknown>, { mode: "update" | "message" | "resume" }>(fns, "messageChatTask")({ projectId: cfg.projectId, chatId: id, featureId: taskId, ...rest, lang: lang() })).data;
        const listTasks = () => store.chatTasks(id);
        await runChat(cfg, store, id, chat, { env: agentEnv(), createTask, messageTask, listTasks, isProtected, denyRead: DENY_READ, describeTool, project }, chatAbort.signal)
          .catch((err: Error) => console.warn(`[chat] ${err.message}`))
          .finally(release);
      }
    } finally {
      chatBusy = false;
    }
  };
  // Las mías (sin runnerUid o con el mío) y las de compañeros dirigidas a mi runner. Sus mensajes siguen siendo datos no
  // fiables: el chat tiene los mismos límites para todos (prompt.ts, guard, sandbox).
  const chatDocs = { mine: [] as QueryDocumentSnapshot[], shared: [] as QueryDocumentSnapshot[] };
  const rechat = () => {
    pendingChats = [...new Set([...chatDocs.mine, ...chatDocs.shared].filter((d) => store.serves(d.data() as RunnerChat)).map((d) => d.id))];
    void drainChats();
  };
  const unsubscribeMyChats = onSnapshot(
    store.myChats(),
    (snap) => {
      chatDocs.mine = snap.docs;
      rechat();
    },
    (err) => console.warn(`[chat] ${err.message}`),
  );
  const unsubscribeSharedChats = onSnapshot(
    store.sharedChats(),
    (snap) => {
      chatDocs.shared = snap.docs;
      rechat();
    },
    (err) => console.warn(`[chat] ${err.message}`),
  );
  const unsubscribeChats = () => {
    unsubscribeMyChats();
    unsubscribeSharedChats();
  };

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
    // «Mantener mis ordenadores despiertos» de la app: lo aplica el panel de este ordenador (lo mira cada minuto).
    const keepAwake = w.keepAwake ?? "off";
    if (readState().appKeepAwake !== keepAwake) updateState({ appKeepAwake: keepAwake });
  });
  const machineTimer = setInterval(reportMachine, 60 * 60_000);

  // Versión nueva del runner o plugin de Claude Code antiguo: push al móvil y a la web (update-notice.ts). Un rato después
  // de arrancar (para no sumarse a todo lo del arranque) y cada media hora.
  const updateNoticeStart = setTimeout(() => void reportUpdates(fns, cfg.projectId), 2 * 60_000);
  const updateNoticeTimer = setInterval(() => void reportUpdates(fns, cfg.projectId), UPDATE_NOTICE_EVERY_MS);

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

  // Este ordenador en la app (users/{uid}/machines/{id}): latido y qué tiene instalado, para que «Conectar mi Claude Code»
  // sepa que el runner ya está aquí. Con varios proyectos conectados lo publican todos (es lo mismo).
  const thisMachine = machineId();
  const beat = () =>
    void machineStatus(cfg.bitbucket)
      .then((status) => store.saveMachineStatus(thisMachine, status))
      .catch((err) => console.warn(`[machine] ${(err as Error).message}`));
  beat();
  const beatTimer = setInterval(beat, MACHINE_BEAT_MS);

  // Monitor de la máquina (monitor.ts): cada minuto lo publica uno solo de los runners del ordenador, en su ficha y en la
  // de cada equipo. Solo números agregados.
  const publishMetrics = async () => {
    if (stopping || !takeMonitorTurn(HOME_DIR)) return;
    const m = await measure(WORKTREES_ROOT, SLOTS_DIR);
    rememberSessionRam(SLOTS_DIR, m.sessionRam);
    await store.saveMachineMetrics(thisMachine, metricsDoc(m));
  };
  const metricsTick = () => void publishMetrics().catch((err) => console.warn(`[monitor] ${(err as Error).message}`));
  metricsTick();
  monitorTimer = setInterval(metricsTick, MONITOR_EVERY_MS);

  // Límites de tareas a la vez: el personal de este proyecto y el total de este ordenador (los dos desde la app).
  const stopLimits = store.watchLimits(thisMachine, (next) => {
    const project = clampLimit(next.project, MAX_PROJECT_LIMIT, null);
    const machine = clampLimit(next.machine, MAX_MACHINE_LIMIT, null);
    if (project === limits.project && machine === limits.machine) return;
    limits.project = project;
    limits.machine = machine;
    console.log(`[backcode] ${t("queue.limits", { project: effectiveProjectLimit(project, machine), machine: machine ?? "-" })}`);
    void drain();
  });

  // «Conectar en <host>» / «Clonar en <host>» desde la app: solo peticiones de mi uid (las reglas solo dejan crearlas a
  // mí y para proyectos de los que soy miembro) y se vuelve a comprobar que puedo leer el proyecto. La llave no viaja:
  // se usa la de este ordenador.
  let linkBusy = false;
  let pendingLinks: string[] = [];
  const drainLinks = async () => {
    if (linkBusy) return;
    linkBusy = true;
    try {
      while (!stopping && !restarting && pendingLinks.length) {
        const id = pendingLinks.shift()!;
        const raw = await store.claimLinkRequest(thisMachine, id, t("link.connecting")).catch(() => null);
        if (!raw) continue;
        const job = parseLinkRequest(raw);
        if ("error" in job) {
          await store.finishLinkRequest(thisMachine, id, "failed", { error: job.error }).catch(() => undefined);
          continue;
        }
        const project = await store.projectForLink(job.projectId);
        if (!project) {
          await store.finishLinkRequest(thisMachine, id, "failed", { error: t("link.noAccess") }).catch(() => undefined);
          continue;
        }
        console.log(`[link] ${job.projectId}${job.clonePath ? ` (clone)` : ""}`);
        const release = awake.hold();
        const outcome = await linkProject(cfg.envFile, job, { ...project, projectsDir: resolveProjectsDir((await store.workspace().catch(() => ({}) as { projectsDir?: string })).projectsDir).dir }, (text) => {
          console.log(`[link] ${text}`);
          void store.linkRequestActivity(thisMachine, id, text);
        })
          .catch((err): Awaited<ReturnType<typeof linkProject>> => ({ status: "failed", error: String((err as Error).message ?? err).slice(0, 1500) }))
          .finally(release);
        if (outcome.status === "done") {
          // El supervisor arranca los nuevos solo (cada 10 s); uno que ya estaba conectado se reinicia con lo nuevo.
          if (outcome.restart) await panelCall("POST", `/api/projects/${job.projectId}/restart`).catch(() => undefined);
          await store.finishLinkRequest(thisMachine, id, "done", { repoPath: outcome.repoPath.slice(0, 300) }).catch((err) => console.warn(`[link] ${(err as Error).message}`));
          beat();
        } else if (outcome.status === "needsRepo") {
          await store.finishLinkRequest(thisMachine, id, "needsRepo", { clonePath: outcome.clonePath.slice(0, 300), canClone: outcome.canClone }).catch(() => undefined);
        } else await store.finishLinkRequest(thisMachine, id, "failed", { error: outcome.error }).catch(() => undefined);
        console.log(`[link] ${job.projectId} -> ${outcome.status}`);
      }
    } finally {
      linkBusy = false;
    }
  };
  const unsubscribeLinks = onSnapshot(
    store.myLinkRequests(thisMachine),
    (snap) => {
      // Las de control del ordenador (parar, actualizar, apagar…, con `type`) las atiende el supervisor (remote-control.ts).
      pendingLinks = snap.docs.filter((d) => !d.get("type")).map((d) => d.id);
      void drainLinks();
    },
    (err) => console.warn(`[link] ${err.message}`),
  );

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[backcode] ${t("main.stopping")}`);
    stopWaitingForChecks();
    unsubscribe();
    stopLang();
    unsubscribeActions();
    unsubscribeRefines();
    unsubscribeChats();
    unsubscribeScaffolds();
    unsubscribeLinks();
    clearInterval(beatTimer);
    clearInterval(monitorTimer);
    stopLimits();
    stopWorkspace();
    stopWorkflow();
    stopRequireChecks();
    stopChecksMode();
    stopDeployRetry();
    stopPreviewBranch();
    stopAutoMerge();
    stopAutoRetry();
    autoMergeAbort.abort();
    clearInterval(machineTimer);
    clearTimeout(updateNoticeStart);
    clearInterval(updateNoticeTimer);
    refineAbort.abort();
    chatAbort.abort();
    clearInterval(knowledgeTimer);
    clearInterval(devicesTimer);
    clearInterval(planTimer);
    clearInterval(deployQueueTimer);
    stopDeployLog();
    clearInterval(cliOtaTimer);
    clearInterval(prsTimer);
    clearInterval(actionsTimer);
    stopDevServer();
    clearInterval(quotaTimer);
    clearInterval(quotaWaitTimer);
    stopQuotaWaits();
    clearInterval(conflictsTimer);
    clearInterval(mergedTimer);
    clearInterval(sessionsTimer);
    stopQuotaRequests();
    knowledgeAbort.abort();
    for (const abort of aborts.values()) abort.abort();
    clearTimeout(drainRetry);
    clearInterval(monitorTimer);
    while (busy || running.size > 0) await new Promise((r) => setTimeout(r, 200));
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
    // Una acción esperando a la CI no retrasa el reinicio hasta 15 minutos: falla con los checks en curso.
    stopWaitingForChecks();
    while (busy || running.size > 0 || actionsBusy || refineBusy || chatBusy || scaffoldBusy || linkBusy) await new Promise((r) => setTimeout(r, 1000));
    stopping = true;
    unsubscribe();
    stopLang();
    unsubscribeActions();
    unsubscribeRefines();
    unsubscribeChats();
    unsubscribeScaffolds();
    unsubscribeLinks();
    clearInterval(beatTimer);
    clearInterval(monitorTimer);
    stopLimits();
    stopWorkspace();
    stopWorkflow();
    stopRequireChecks();
    stopChecksMode();
    stopDeployRetry();
    stopPreviewBranch();
    stopAutoMerge();
    stopAutoRetry();
    autoMergeAbort.abort();
    clearInterval(machineTimer);
    clearTimeout(updateNoticeStart);
    clearInterval(updateNoticeTimer);
    clearInterval(knowledgeTimer);
    clearInterval(devicesTimer);
    clearInterval(planTimer);
    clearInterval(deployQueueTimer);
    stopDeployLog();
    clearInterval(cliOtaTimer);
    clearInterval(prsTimer);
    clearInterval(actionsTimer);
    stopDevServer();
    clearInterval(quotaTimer);
    clearInterval(quotaWaitTimer);
    stopQuotaWaits();
    clearInterval(conflictsTimer);
    clearInterval(mergedTimer);
    clearInterval(sessionsTimer);
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
