import { explainRemoteError, isTransientRemoteError, withRemoteRetry } from "./remote-retry.js";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { failingLog } from "./check-logs.js";
import { MISSING_MODULES } from "./diagnostics.js";
import { type RunnerConfig } from "./config.js";
import { smokeCliPath } from "./paths.js";
import { countBetween, createDetachedWorktree, DEPLOY_PREFIX, git as gitIn, type ExpoApp, fetchBranches, findConflicts, findDeployTargets, findExpoApp, holdWorktree, isAncestor, mergedCommit, releaseWorktree, remoteHead, remoteSha, removeWorktree, scanStagedForSecrets, syncLocalBase } from "./git.js";
import { type Checks, isMergeConflictError, type MergeOptions, type PrHost } from "./hosts.js";
import { branchForChannel, branchForTarget, previewBranch, promotionPr, protectedBranch, syncMode, taskBase } from "./environments.js";
import { remoteTexts, t } from "./i18n.js";
import { BASE_CHECKS_APPEAR_MS, gatePrChecks, waitForChecks } from "./wait-checks.js";
import { updateBehindPr, waitHostHead } from "./pr-update.js";
import { followLocalWorktree } from "./conflicts.js";
import { ciConfigAt } from "./ci.js";
import type { GithubActions } from "./github-actions.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { shouldVerifyAfterTask, verifiedChecksPlan, VERIFY_SUMMARY_MAX, VERIFY_TIMEOUT_MS } from "./checks-verify.js";
import { type ChecksMode, LOCAL_CHECK_PREFIX, type LocalRun, isBranchProtectionError, localChecksAt, mergeChecksPlan, onlyNotStarted, onlyNotStartedIn, rememberPrLog, runLocalChecks } from "./local-checks.js";
import { adbPath, androidSdk, listDevices, prepareIosDevice, type DevicePlatform } from "./devices.js";
import { adbReverse, devPort, devServe, devServerRunning, devStop, recordDevInstall, stopDevServer } from "./dev-server.js";
import { appConfig, buildErrors, prepareNativeProject, smokeTest } from "./smoke.js";
import { otaScriptArgs, promoteCheck } from "./ota.js";
import { appScheme, nativeFiles, prChannel, prNumberOf, prOtaArgs, prOtaLink } from "./pr-ota.js";
import { channelOfTarget, type DeployedTask, includedTasks, MAX_DEPLOYED_TASKS, markBuiltTasks, markDeployedTasks } from "./deploy-tasks.js";
import type { Store } from "./store.js";
import { clampDeployRetries, classifyDeployError, type CurrentStep, DEFAULT_DEPLOY_RETRIES, type DeployLock, DeployProgress, isTransientDeployError, retryDelays, retryTransient, transientReason, withDeployLock } from "./deploy-progress.js";
import { scopeOf } from "./pending.js";
import { buildNumberFrom, otaInfoFrom, readFrom, readVersion, versionDir } from "./versions.js";

// Acciones que pide un admin desde la app y ejecuta su runner con sus credenciales (gh / Bitbucket / EAS):
// mergear el PR de una tarea, publicar un OTA de Expo (EAS Update o el script `ota:publish` del repo, p. ej. xprem) o
// hacer una build local con EAS y enviarla a testers (TestFlight / Internal Testing). Los comandos son fijos: nunca los
// decide Claude.

export interface Action {
  /** Id del documento de la acción (lo pone el runner al reclamarla): una build lo apunta en sus tareas. */
  id?: string;
  type: "merge" | "rerunChecks" | "actionsPause" | "actionsResume" | "ota" | "openPr" | "build" | "deploy" | "install" | "devServe" | "devStop" | "deployAll" | "closePr" | "mergePr" | "knowledge" | "fixConflicts" | "promote" | "syncPreview" | "prOta" | "revert" | "revertCheck";
  /** PR externo (creado fuera de Backcode) que mergear o cerrar: tiene que estar entre los abiertos del repo. */
  prUrl?: string;
  /** Al cerrar un PR externo, borrar también su rama (la de una tarea se borra siempre). */
  deleteBranch?: boolean;
  /** «Desplegarlo todo»: pasos (`deploy:<destino>`, `ota:<canal>`) que se ejecutan en el orden del plan, parando al primer fallo. */
  steps?: string[];
  /** «Instalar en mi móvil»: plataforma y dispositivo (UDID de iOS o serie de adb) de los que publica el runner. */
  platform?: DevicePlatform;
  deviceId?: string;
  /** release: la app tal cual (JS dentro). dev: build Debug que carga el JS del Metro de tu ordenador (ver dev-server.ts). */
  variant?: "release" | "dev";
  /** Despliegue: `<carpeta>#<nombre>` de un script `backcode:deploy:<nombre>` detectado en el repo. */
  target?: string;
  featureId?: string;
  channel?: "preview" | "production";
  message?: string;
  /** Rollback: volver a publicar este commit (una versión anterior ya publicada) en lugar del último de la rama base. */
  commit?: string;
  /** Build para testers: plataformas, versión de tienda (x.y.z) y runtimeVersion escritas a mano en la app. */
  platforms?: ("ios" | "android")[];
  version?: string;
  runtimeVersion?: string;
  /** OTA: si la copia que se publica queda con archivos sin commitear, commitearlos en la rama base y publicar igualmente. */
  commitDirty?: boolean;
  /**
   * OTA «Publicar sin comprobaciones»: sin prueba de arranque (ni la del runner ni la del script) y con --allow-native si el
   * script lo admite. En deployAll solo se aplica al paso OTA.
   */
  skipSmoke?: boolean;
  /**
   * OTA «Promocionar a producción» (con channel production y commit): publica en production el commit que está ahora en
   * preview, sin esperar otra vez a los checks (ya los pasó) y con las variables de production. Ver promoteCheck.
   */
  promote?: boolean;
  /**
   * Merge del PR de una tarea de CI: la persona confirmó en la app, viendo los ficheros y el diff, que este PR cambia lo
   * que comprueba la CI. Sin esta marca (y siempre en modo auto o en un merge en lote) el PR de CI no se mergea.
   */
  confirmCi?: boolean;
  /**
   * Merge «Pasar los checks en local»: el runner ejecuta los checks del backcode.toml de la rama base sobre el PR y, si
   * pasan, sustituyen a los de la CI del host que no llegaron a ejecutarse (o, sin «Exigir checks», a los que fallaron).
   * En un despliegue, OTA, build o «Desplegarlo todo»: solo si los checks del último commit de la rama no llegaron a
   * ejecutarse, se pasan en local y, en verde, se publica (ver requireGreenBase).
   */
  localChecks?: boolean;
  /** Merge «Merge sense CI» (solo admins): sin esperar ni pasar checks, solo ese merge. */
  skipChecks?: boolean;
  /** «Pausar GitHub Actions»: reactivarlos solo al renovarse los minutos (el día 1 del mes siguiente). */
  autoResume?: boolean;
}
export interface StepResult {
  id: string;
  ok: boolean;
  sha?: string;
  version?: string;
  updateId?: string;
  url?: string;
  error?: string;
  /** Cuándo empezó de verdad (ya con el candado de despliegue; ms del reloj del runner) y cuánto duró. */
  startedAt?: number;
  durationMs?: number;
  autoRetry?: AutoRetry;
}
/**
 * Reintentos automáticos de un despliegue, OTA o build tras errores transitorios: cuántos se hicieron (`retries`), el
 * máximo del proyecto (`max`), el motivo de cada intento fallido (`reasons`) y si el último error parecía transitorio
 * (`transient`: la app lo explica junto a «Reintentar»). Sin reintentos ni fallo, ausente.
 */
export interface AutoRetry {
  retries: number;
  max: number;
  reasons: string[];
  transient?: boolean;
}
export interface ActionResult {
  autoRetry?: AutoRetry;
  /** «Desplegarlo todo»: cómo fue cada paso (los que no llegaron a ejecutarse no aparecen). */
  steps?: StepResult[];
  /** «Desplegarlo todo»: los pasos en el orden en que el runner los ejecuta. */
  order?: string[];
  /** Mientras corre: el paso que se está haciendo (o esperando el candado). Desaparece en el resultado final. */
  current?: CurrentStep;
  url?: string;
  sha?: string;
  /**
   * Versión de lo publicado (ver versions.ts): despliegue, la de su carpeta (runner 1.0.78, web 1.4.0); OTA, su
   * runtimeVersion. Sin versión propia (reglas, functions…), ausente: la app enseña la fecha.
   */
  version?: string;
  /** Build: número de build que asignó EAS (buildNumber / versionCode), si lo imprimió. */
  buildNumber?: string;
  /** OTA: id del grupo de update que imprime `eas update`. */
  updateId?: string;
  error?: string;
  /** Checks que no están en verde (si se rechaza por eso). */
  checks?: string[];
  log?: string;
  /**
   * fixChecks de un PR de CI: «ciAppCode» si Claude concluye que el fichero de CI está bien y lo que falla es el código de la
   * app o sus tests (la app ofrece entonces una tarea normal para arreglarlo; `log` lleva su explicación).
   */
  blocked?: "ciAppCode" | "ciNotStarted";
  /** Merge bloqueado por checks: dónde se pasaron (local: con el runner, «Backcode · …»; host: GitHub/Bitbucket). */
  checksWhere?: "local" | "host";
  /** OTA: archivos sin commitear que impidieron publicar (la app ofrece «Commit y publicar»). */
  dirty?: string[];
  /** OTA de un PR (prOta): su canal de EAS Update y los enlaces que abren la app en él o la devuelven a su canal. */
  channel?: string;
  link?: string;
  backLink?: string;
  /** OTA de un PR: ficheros nativos que impiden publicarlo por OTA. */
  native?: string[];
  /** revertCheck: PRs mergeados después que tocan los mismos ficheros que el que se quiere revertir. */
  later?: { sha: string; title: string; number?: number }[];
  /** OTA, build y despliegue hechos bien: tareas que entraron en él (su detalle en la app). */
  features?: DeployedTask[];
}

const OTA_TIMEOUT_MS = 25 * 60_000;
/** Una build local (sobre todo la de iOS) puede tardar bastante más que un OTA. */
const BUILD_TIMEOUT_MS = 90 * 60_000;
const DEPLOY_TIMEOUT_MS = 30 * 60_000;
/** Perfil de eas.json de las builds para testers: el de tienda (TestFlight e Internal Testing solo aceptan builds de tienda). */
const BUILD_PROFILE = "production";
// Las mismas comprobaciones que firestore.rules: llegan a la build como variables de entorno.
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const RUNTIME_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;

// «Exigir checks» del proyecto (plan Equipo; lo cambian los admins en la app y lo sigue index.ts): sin checks, o sin
// GitHub/Bitbucket donde leerlos, no se mergea ni se despliega.
let requireChecks = false;
export function setRequireChecks(on: boolean): void {
  requireChecks = on;
}

// «Dónde se pasan los checks» del proyecto: la CI del host (por defecto) o el runner con los comandos del backcode.toml
// (local-checks.ts). Lo cambian los admins en la app y lo sigue index.ts.
let checksMode: ChecksMode = "host";
export function setChecksMode(mode: ChecksMode): void {
  checksMode = mode;
}

// GitHub Actions del repo (github-actions.ts): pausados por Backcode, los checks se pasan en local si el repo los declara.
let ghActions: GithubActions | undefined;
let onActionsChange: () => void = () => undefined;
export function setGithubActions(ga: GithubActions | undefined, onChange: () => void): void {
  ghActions = ga;
  onActionsChange = onChange;
}

/** ¿Se pasan los checks en local? Por el ajuste del proyecto o, con Actions pausado por Backcode, si hay checks declarados. */
async function useLocal(cfg: RunnerConfig, configRef: string): Promise<boolean> {
  if (checksMode === "local") return true;
  if (!ghActions?.isPaused()) return false;
  return (await localChecksAt(cfg.repoPath, configRef)).length > 0;
}

/**
 * Checks locales de `sha`, leyendo qué comprobar de `configRef` (la rama base: un PR no puede rebajarlos). Se pasan sobre
 * `sha` mezclado con lo último de la base (withBase): un PR se comprueba tal como quedaría mergeado. Los estados se
 * publican en `sha`.
 */
async function localChecks(cfg: RunnerConfig, host: PrHost | undefined, sha: string, configRef: string): Promise<LocalRun> {
  const checks = await localChecksAt(cfg.repoPath, configRef);
  const combined = await withBase(cfg, sha, configRef);
  return runLocalChecks({ repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir, host, sha: combined, publishSha: sha, checks });
}

/**
 * El commit que se comprueba para `headSha`: él mismo si ya contiene `baseRef` (lo de siempre, p. ej. un despliegue de
 * la base) o, si no, su mezcla local con la base (mergedCommit). Si chocan o no se puede calcular, `headSha` (el merge
 * ya mira los conflictos aparte). Trae antes la base.
 */
async function withBase(cfg: RunnerConfig, headSha: string, baseRef: string, baseSha?: string): Promise<string> {
  const prefix = `${cfg.remote}/`;
  if (!baseSha && baseRef.startsWith(prefix)) {
    const base = baseRef.slice(prefix.length);
    await gitIn(cfg.repoPath, ["fetch", "--quiet", cfg.remote, `${base}:refs/remotes/${baseRef}`]).catch(() => undefined);
  }
  const at = baseSha || (await gitIn(cfg.repoPath, ["rev-parse", baseRef]).catch(() => ""));
  if (!at) return headSha;
  const combined = await mergedCommit(cfg.repoPath, headSha, at).catch(() => null);
  if (!combined) return headSha;
  if (combined !== headSha) console.log(`[checks] ${t("lc.withBase", { sha: headSha.slice(0, 7), base: baseRef, at: at.slice(0, 7) })}`);
  return combined;
}

/** Estado resumen que se publica en el último commit del PR tras verificar los checks al terminar la tarea. */
export const VERIFY_STATUS = "backcode/local-checks";

/**
 * Al terminar una tarea con PR: con checks en local (y alguno declarado), los pasa sobre el último commit del PR y guarda
 * el resultado en la tarea atado a ese commit y a la base (checks-verify.ts). No bloquea nada: si falla, solo se marca
 * (el merge los volverá a pasar). Nunca lanza.
 */
export async function verifyTaskChecks(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string, branch: string): Promise<void> {
  try {
    const base = taskBase(cfg.baseBranch);
    const baseRef = `${cfg.remote}/${base}`;
    // «Sin CI»: nada que verificar. Con la CI del host, solo si Actions está pausado y se pasan en local (useLocal).
    if (checksMode === "none" || !(await useLocal(cfg, baseRef))) return;
    const checks = await localChecksAt(cfg.repoPath, baseRef);
    if (!shouldVerifyAfterTask("local", checks.length)) return;
    await gitIn(cfg.repoPath, ["fetch", "--quiet", cfg.remote, `${base}:refs/remotes/${cfg.remote}/${base}`]).catch(() => undefined);
    const [headSha, baseSha] = [await prHeadSha(cfg, branch), await remoteSha(cfg.repoPath, cfg.remote, base)];
    if (!headSha || !baseSha) return;
    const names = checks.map((c) => c.name);
    console.log(`[checks] ${t("lc.verifyStart", { sha: headSha.slice(0, 7) })}`);
    await store.setChecksVerify(featureId, { state: "verifying", headSha, baseSha, checks: names });
    // Si se cansa de esperar, aborta: los checks que deja no siguen vivos (ni sus emuladores ocupando puertos).
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => (abort.abort(), r(null)), VERIFY_TIMEOUT_MS)));
    // Sobre el PR mezclado con esta base (lo que se guarda, headSha + baseSha, es justo eso): el merge solo lo reutiliza si
    // ni el PR ni la base han cambiado.
    const combined = await withBase(cfg, headSha, baseRef, baseSha);
    const run = await Promise.race([runLocalChecks({ repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir, host, sha: combined, publishSha: headSha, checks, signal: abort.signal }).catch(() => null), timeout]).finally(() => clearTimeout(timer));
    const passed = run?.checks.state === "green";
    const failing = run ? run.checks.pending.filter((p) => p.endsWith(": fail")).map((p) => p.slice(0, -": fail".length).replace(LOCAL_CHECK_PREFIX, "")) : [];
    const summary = passed ? "" : run ? t("lc.verifyFail", { checks: failing.join(", ") || run.checks.state }) : t("lc.verifyTimeout");
    await store.setChecksVerify(featureId, { state: passed ? "passed" : "failed", headSha, baseSha, checks: names, ...(summary ? { summary: summary.slice(0, VERIFY_SUMMARY_MAX) } : {}) });
    const prUrl = run?.log ? await store.prUrlOf(featureId).catch(() => undefined) : undefined;
    if (prUrl && run) rememberPrLog(prUrl, run.log);
    await host?.setStatus?.(headSha, { name: VERIFY_STATUS, state: passed ? "ok" : "fail", description: passed ? t("lc.verifyOk") : summary.slice(0, 140) }).catch(() => undefined);
  } catch (e) {
    console.warn(`\x1b[33m⚠ [checks] ${(e as Error).message.split("\n")[0]}\x1b[0m`);
  }
}

/**
 * El commit del PR si sus checks en local ya se verificaron en verde al terminar la tarea y ni el PR ni la base han
 * cambiado desde entonces (verifiedChecksPlan = "reuse"); si no, "" (y se pasan como siempre).
 */
async function alreadyVerified(cfg: RunnerConfig, store: Store, featureId: string, branch: string | undefined, baseRef: string): Promise<string> {
  if (!branch) return "";
  const verification = await store.checksVerifyOf(featureId).catch(() => null);
  if (verification?.state !== "passed") return "";
  const base = taskBase(cfg.baseBranch);
  await gitIn(cfg.repoPath, ["fetch", "--quiet", cfg.remote, `${base}:refs/remotes/${baseRef}`]).catch(() => undefined);
  const headSha = await prHeadSha(cfg, branch);
  const baseSha = await remoteSha(cfg.repoPath, cfg.remote, base);
  if (!headSha || !baseSha) return "";
  const plan = verifiedChecksPlan({
    mode: "local",
    verification,
    headSha,
    baseSha,
    baseContained: await isAncestor(cfg.repoPath, baseSha, headSha),
    checks: (await localChecksAt(cfg.repoPath, baseRef)).map((c) => c.name),
    now: Date.now(),
  });
  return plan === "reuse" ? headSha : "";
}

/** Sha de la rama de un PR en el remoto (la trae antes). */
async function prHeadSha(cfg: RunnerConfig, branch: string): Promise<string> {
  await gitIn(cfg.repoPath, ["fetch", "--quiet", cfg.remote, `${branch}:refs/remotes/${cfg.remote}/${branch}`]).catch(() => undefined);
  return remoteSha(cfg.repoPath, cfg.remote, branch);
}

/** Bloqueo por checks locales: sin ninguno declarado, siempre (se eligieron checks en local); si no, como requireGreen. */
function requireLocalGreen(run: LocalRun, what: string): ActionResult | null {
  if (run.checks.state === "none") return { error: t("act.localNone", { what }) };
  const blocked = requireGreen(run.checks, what, true);
  return blocked ? { ...blocked, ...(run.log ? { log: run.log } : {}) } : null;
}

// «Reintentar automáticamente los despliegues fallidos por errores temporales» del proyecto (activado por defecto; 2
// reintentos y como mucho 3). Lo cambian los admins en la app y lo sigue index.ts.
let deployRetry = { on: true, retries: DEFAULT_DEPLOY_RETRIES };
export function setDeployRetry(settings: { on?: boolean; retries?: number }): void {
  deployRetry = { on: settings.on !== false, retries: clampDeployRetries(settings.retries) };
}

/** Solo se continúa con todo en verde (o sin checks configurados, si el proyecto no los exige). */
export function requireGreen(checks: Checks, what: string, strict = requireChecks): ActionResult | null {
  if (checks.state === "green" || (checks.state === "none" && !strict)) return null;
  if (checks.state === "none") return { error: t("act.checksRequired", { what }) };
  return { error: t("act.notGreen", { what, state: t(checks.state === "pending" ? "act.checksPending" : "act.checksFailing") }), checks: checks.pending };
}

/**
 * Checks de `what` esperando a que termine la CI si aún está en curso (ver wait-checks.ts). Con `noneGraceMs` (el repo
 * tiene CI), si aún no hay ningún check se espera también a que aparezcan.
 */
function checksWhenDone(read: () => Promise<Checks>, what: string, noneGraceMs = 0): Promise<Checks> {
  return waitForChecks(read, { noneGraceMs, onWait: () => console.log(`[action] ${t("act.waitingChecks", { what })}`) });
}

// La acción en curso pidió «Pasar los checks en local» (lo lee requireGreenBase sin pasarlo por todas las capas).
const actionScope = new AsyncLocalStorage<{ localChecks: boolean }>();

/** Checks del último commit de la rama base antes de publicar (OTA, builds y despliegues). */
async function requireGreenBase(cfg: RunnerConfig, host: PrHost | undefined, commit: string, branch = cfg.baseBranch): Promise<ActionResult | null> {
  const what = `${branch} (${commit.slice(0, 7)})`;
  // Proyecto «Sin CI»: se publica sin esperar checks (salvo con «Exigir checks», que sigue mandando).
  if (checksMode === "none" && !requireChecks) return null;
  // Checks en local: los del backcode.toml de ese mismo commit (ya está en la rama base), una vez por commit.
  if (await useLocal(cfg, commit)) return requireLocalGreen(await localChecks(cfg, host, commit, commit), what);
  if (!host) return requireChecks ? { error: t("act.checksNoHost") } : null;
  // Justo tras un push a la rama base sus checks pueden tardar unos segundos en aparecer: si hay CI, se les da margen.
  const grace = (await ciConfigAt(cfg.repoPath, commit)) ? BASE_CHECKS_APPEAR_MS : 0;
  const checks = await checksWhenDone(() => host.commitChecks(commit), what, grace);
  if (checks.state === "none" && grace && requireChecks) return { error: t("act.ciNoChecks", { what }) };
  const blocked = requireGreen(checks, what);
  if (!blocked || checks.state !== "failing") return blocked;
  // Checks de la rama que no llegaron a ejecutarse (GitHub Actions sin minutos o con un pago fallido): pasarlos en local si
  // la acción lo pidió; si no, decirlo (la app ofrece «Pasar los checks en local» junto al error).
  if (!(await onlyNotStartedIn(host.commitNotStarted ? () => host.commitNotStarted!(commit) : undefined, checks))) return blocked;
  if (ghActions && !ghActions.isPaused()) {
    ghActions.markOutOfMinutes();
    onActionsChange();
  }
  if (actionScope.getStore()?.localChecks) return requireLocalGreen(await localChecks(cfg, host, commit, commit), what);
  return { error: t("act.ciNotStartedBase", { what }), checks: checks.pending, blocked: "ciNotStarted" };
}

export async function runAction(cfg: RunnerConfig, store: Store, host: PrHost | undefined, action: Action): Promise<{ ok: boolean; result: ActionResult }> {
  return actionScope.run({ localChecks: action.localChecks === true && action.type !== "merge" }, () => runActionIn(cfg, store, host, action));
}

async function runActionIn(cfg: RunnerConfig, store: Store, host: PrHost | undefined, action: Action): Promise<{ ok: boolean; result: ActionResult }> {
  if (action.type === "merge") return merge(cfg, store, host, action.featureId ?? "", { confirmCi: action.confirmCi === true, localChecks: action.localChecks === true, skipChecks: action.skipChecks === true });
  if (action.type === "rerunChecks") return rerunChecks(store, host, action.featureId ?? "");
  if (action.type === "actionsPause" || action.type === "actionsResume") return pauseActions(action.type === "actionsPause", action.autoResume !== false);
  if (action.type === "openPr") return openPr(cfg, store, host, action.featureId ?? "");
  // OTA, build y despliegue publican la rama base del remoto (no tu copia local): después, tu copia se pone al día
  // para que lo que ves en local sea lo que se acaba de publicar (p. ej. un merge que hizo otro y aún no tenías).
  if (action.type === "install") return installOnDevice(cfg, store, action);
  // Versión de desarrollo: Metro con la rama principal o con una tarea (featureId).
  if (action.type === "devServe") return devServe(cfg, store, action.featureId);
  if (action.type === "devStop") return devStop(cfg, store);
  if (action.type === "closePr") return closePr(cfg, store, host, action);
  if (action.type === "promote") return promote(cfg, store, host);
  if (action.type === "syncPreview") return syncPreview(cfg, host);
  // «Prova aquest PR al teu mòbil»: OTA solo del PR de la tarea, en su propio canal de EAS Update (pr-<número>).
  if (action.type === "prOta") return publishPrOta(cfg, store, host, action.featureId ?? "");
  if (action.type === "mergePr") {
    const done = await mergeExternal(cfg, host, action.prUrl ?? "");
    if (done.ok) await syncLocal(cfg);
    return done;
  }
  if (action.type === "deployAll") {
    const done = await deployAll(cfg, store, host, action.steps ?? [], action.message ?? "", action.skipSmoke === true, action.id);
    await syncLocal(cfg);
    return done;
  }
  if (action.type === "build") {
    const built = await withAutoRetry("Build", "eas", () => publishBuild(cfg, host, action), singleRetryProgress(store, action.id, "build"));
    const done = await withBuiltTasks(cfg, store, action, await withTasks(cfg, store, "build", built));
    await syncLocal(cfg);
    return done;
  }
  // Despliegue u OTA sueltos: también de uno en uno en el proyecto (candado de despliegue), como cada paso de deployAll.
  const step = action.type === "deploy" ? `deploy:${action.target ?? ""}` : `ota:${action.channel ?? "preview"}`;
  const id = action.id ?? "";
  const since = Date.now();
  const progress = (waitingFor?: string) => (id ? store.actionProgress(id, { current: { id: step, index: 0, startedAt: since, ...(waitingFor ? { waitingFor } : {}) } }).catch(progressFailed(id)) : Promise.resolve());
  const onRetry = singleRetryProgress(store, id, step);
  // «Commit y publicar» escribe en la rama base: no se reintenta solo (se pide a mano otra vez si hace falta).
  const commitDirty = action.commitDirty === true && !action.commit;
  const done = await withDeployLock(deployLock(store), id || step, stepLabel(step), async () =>
    action.type === "deploy"
      ? withTasks(cfg, store, step, await deployWithRetry(cfg, store, host, action.target ?? "", onRetry))
      : withAutoRetry(stepLabel(step), "eas", () => publishOta(cfg, store, host, action.channel ?? "preview", action.message ?? "OTA", action.commit, commitDirty, action.skipSmoke === true, action.promote === true), onRetry, { noRetry: commitDirty }),
  {
    onWait: async (busy) => {
      console.log(`[action] ${t("deploy.waitLock", { step: busy })}`);
      await progress(busy);
    },
    onAcquired: () => progress(),
  });
  await syncLocal(cfg);
  return done;
}

/** Nombre corto de un paso para el log y el candado: `deploy:functions#functions` → functions, `ota:preview` → OTA preview. */
function stepLabel(id: string): string {
  return id.replace(/^deploy:[^#]*#/, "").replace(/^ota:/, "OTA ");
}

/** Lo que dura el candado de despliegue sin renovarse: si el runner se cae a medias, otro puede desplegar tras esto. */
const DEPLOY_LOCK_LEASE_MS = 5 * 60_000;
const deployLock = (store: Store): DeployLock => ({
  take: (action, step) => store.takeDeployLock(action, step, DEPLOY_LOCK_LEASE_MS),
  release: (action) => store.releaseDeployLock(action),
});

/**
 * Escritura del progreso en vivo que ha fallado: al log del runner (sin ella la app no ve avanzar los pasos) y sin parar
 * el despliegue.
 */
const progressFailed = (actionId: string) => (err: unknown) =>
  console.error(`[action] ${actionId}: progress write failed: ${err instanceof Error ? err.message : String(err)}`);

/** Aviso de reintento de un despliegue, OTA o build suelto: lo deja en `result.current` de la acción (la app lo enseña). */
type RetryNotice = (attempt: number, max: number, reason: string) => Promise<void>;
function singleRetryProgress(store: Store, actionId: string | undefined, step: string): RetryNotice {
  const since = Date.now();
  return (attempt, max, reason) =>
    actionId ? store.actionProgress(actionId, { current: { id: step, index: 0, startedAt: since, attempt, maxRetries: max, reason: reason.slice(0, 300) } }).catch(progressFailed(actionId)) : Promise.resolve();
}

/** Despliegue de un destino con los reintentos automáticos de los errores transitorios de su proveedor (withAutoRetry). */
async function deployWithRetry(cfg: RunnerConfig, store: Store, host: PrHost | undefined, targetId: string, onRetry?: RetryNotice) {
  const provider = store.capabilities.deploys.find((d) => d.id === targetId)?.provider;
  return withAutoRetry(stepLabel(`deploy:${targetId}`), provider, () => runDeploy(cfg, host, targetId), onRetry);
}

/**
 * Ejecuta un despliegue, OTA o build (solo comandos de despliegue: nunca un paso que use Claude) y, si falla por un error
 * transitorio (red, 429/5xx, API del proveedor, otro despliegue en curso: ver classifyDeployError), lo reintenta solo,
 * con espera creciente, hasta el máximo del proyecto (2 por defecto, nunca más de 3). Al llegar al límit queda fallido y
 * no se reintenta más. Los errores de código, compilación, tests, credenciales o configuración no se reintentan.
 * `noRetry` (o un resultado con `noRetry`, p. ej. una build que ya envió una plataforma): sin reintentos.
 * El motivo de cada intento queda en el log y en `result.autoRetry` (la app lo enseña).
 */
export async function withAutoRetry(
  label: string,
  provider: string | undefined,
  run: () => Promise<{ ok: boolean; result: ActionResult; noRetry?: boolean }>,
  onRetry?: RetryNotice,
  opts: { noRetry?: boolean; settings?: { on: boolean; retries: number }; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; result: ActionResult }> {
  const settings = opts.settings ?? deployRetry;
  const delays = settings.on && !opts.noRetry ? retryDelays(settings.retries) : [];
  const max = delays.length;
  const notes: string[] = [];
  const done = await retryTransient(run, {
    delays,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    transient: (error, d) => !d.noRetry && isTransientDeployError(error, provider),
    onRetry: async (attempt, waitMs, error) => {
      const reason = transientReason(error, provider);
      const line = t("deploy.retrying", { step: label, n: attempt, max, s: Math.round(waitMs / 1000), error: reason });
      console.log(`[action] ${line}`);
      notes.push(line);
      await onRetry?.(attempt, max, reason);
    },
  });
  const { attempts, reasons, ok } = done;
  const retries = attempts - 1;
  if (retries > 0) notes.push(t(ok ? "deploy.retried" : "deploy.gaveUp", { step: label, n: retries }));
  const result: ActionResult = { ...done.result };
  if (!ok) {
    const kind = classifyDeployError(String(result.error ?? ""), provider);
    result.autoRetry = { retries, max, reasons: reasons.map((r) => transientReason(r, provider)), transient: kind === "transient" || kind === "lock" };
  } else if (retries > 0) {
    result.autoRetry = { retries, max, reasons: reasons.map((r) => transientReason(r, provider)) };
  }
  if (!notes.length) return { ok, result };
  result.log = `${notes.join("\n")}\n${result.log ?? ""}`.slice(-2000);
  if (!ok && result.error) result.error = `${notes.join("\n")}\n${result.error}`.slice(-3000);
  return { ok, result };
}

/**
 * Añade al resultado de un build o despliegue hecho bien las tareas que entraron en él: las mergeadas que van en su
 * commit y no iban en el anterior del mismo destino (`key`, como en lastDeploys). Si falla, el resultado queda igual.
 * Un despliegue a staging o production (por el nombre del destino: channelOfTarget) además las deja «desplegadas» en
 * ese canal (staging = preview), como un OTA.
 */
async function withTasks(cfg: RunnerConfig, store: Store, key: string, done: { ok: boolean; result: ActionResult }): Promise<{ ok: boolean; result: ActionResult }> {
  const sha = done.result.sha;
  if (!done.ok || !sha) return done;
  const ancestor = (a: string, c: string) => isAncestor(cfg.repoPath, a, c);
  const channel = key.startsWith("deploy:") ? channelOfTarget(key.slice("deploy:".length), store.capabilities.deploys.map((d) => d.id)) : null;
  let features: DeployedTask[] | undefined;
  try {
    const previous = (await store.lastDeploys()).get(key);
    features = await includedTasks(await store.mergedFeatures(), sha, previous, ancestor);
  } catch {
    // sin la lista: el resultado queda igual
  }
  if (channel) {
    const marked = await markDeployedTasks(store, channel, sha, ancestor).catch(() => []);
    features = [...(features ?? []), ...marked.filter((m) => !features?.some((f) => f.id === m.id))].slice(0, MAX_DEPLOYED_TASKS);
  }
  return features ? { ...done, result: { ...done.result, features } } : done;
}

/**
 * Tras una build para testers hecha bien: apunta en cada tarea que entró en ella (por plataforma, frente a la última build
 * hecha bien de esa plataforma) la versión, la runtimeVersion y la acción. Si falla, la build sigue dándose por buena.
 */
async function withBuiltTasks(cfg: RunnerConfig, store: Store, action: Action, done: { ok: boolean; result: ActionResult }): Promise<{ ok: boolean; result: ActionResult }> {
  const sha = done.result.sha;
  const platforms = (["ios", "android"] as const).filter((p) => action.platforms?.includes(p));
  if (!done.ok || !sha || !action.id || !platforms.length) return done;
  try {
    const last = await store.lastDeploys();
    const previous: Partial<Record<(typeof platforms)[number], string>> = {};
    for (const p of platforms) previous[p] = last.get(`build:${p}`);
    const build = { version: action.version ?? "", runtimeVersion: action.runtimeVersion ?? "", actionId: action.id };
    await markBuiltTasks(store, platforms, build, sha, previous, (a, c) => isAncestor(cfg.repoPath, a, c));
  } catch {
    // sin marcar: la build ya salió
  }
  return done;
}

/** Pone al día tu copia local de la rama base (solo si es seguro: ver syncLocalBase) e instala si cambiaron dependencias. */
async function syncLocal(cfg: RunnerConfig): Promise<void> {
  const local = await syncLocalBase(cfg.repoPath, cfg.remote, cfg.baseBranch).catch((e: Error) => ({ status: "skipped" as const, reason: e.message }));
  logLocalSync(cfg, local);
  if (local.status === "updated" && "changed" in local) await installIfNeeded(cfg.repoPath, local.changed ?? []).catch(() => undefined);
}

/** Abre el PR de una tarea cuya rama ya está subida (p. ej. hecha en modo "solo rama"), sin ejecutar a Claude. */
async function openPr(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string) {
  if (!host) return { ok: false, result: { error: t("act.noHostOpen") } };
  const f = await store.featureInfo(featureId);
  if (f.prUrl?.startsWith("https://")) return { ok: true, result: { url: f.prUrl } };
  if (!f.branch) return { ok: false, result: { error: t("act.noBranch") } };
  const body = `${f.summary || f.refinedPrompt}\n\n---\n${t("pr.footerBranch", { id: featureId, branch: f.branch })}\n\n${t("pr.generated")}`;
  const url = await host.openOrUpdatePr({ cwd: cfg.repoPath, branch: f.branch, base: taskBase(cfg.baseBranch), title: f.title, body });
  await store.setPrUrl(featureId, url);
  return { ok: true, result: { url } };
}

/** Un PR externo solo se toca si de verdad está abierto en este repo (la URL no se usa tal cual llega de la app). */
async function openExternal(host: PrHost, prUrl: string) {
  return (await host.listOpen()).find((p) => p.url === prUrl && !p.branch.startsWith("backcode/"));
}

/**
 * Descartar un PR: el de una tarea (featureId; la app ya la ha pasado a rechazada) se cierra y se borra su rama y su copia
 * de trabajo; uno externo (prUrl) se cierra y, si se pide, se borra su rama.
 */
async function closePr(cfg: RunnerConfig, store: Store, host: PrHost | undefined, action: Action) {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  if (action.featureId) {
    const prUrl = await store.prUrlOf(action.featureId);
    if (prUrl?.startsWith("https://")) {
      const pr = await host.prState(prUrl).catch(() => null);
      if (pr?.state === "open") await host.close(prUrl, true);
    }
    await removeWorktree(cfg.repoPath, join(cfg.worktreesDir, action.featureId)).catch(() => undefined);
    return { ok: true, result: { url: prUrl } };
  }
  const pr = await openExternal(host, action.prUrl ?? "");
  if (!pr) return { ok: false, result: { error: t("act.prNotOpen") } };
  // La rama base y la de preview no se borran nunca (p. ej. al descartar la PR de promoción).
  await host.close(pr.url, action.deleteBranch === true && !protectedBranch(pr.branch, cfg.baseBranch));
  return { ok: true, result: { url: pr.url } };
}

/**
 * Mergear un PR externo: como el de una tarea (checks en verde, squash y borrar la rama). El que sale de la rama base o
 * de la de preview (la promoción a producción y la sincronización de vuelta) va con merge commit y sin borrar la rama:
 * así los commits de las tareas siguen siendo los mismos en las dos ramas y «Pendiente de desplegar» los reconoce.
 */
async function mergeExternal(cfg: RunnerConfig, host: PrHost | undefined, prUrl: string) {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  const pr = await openExternal(host, prUrl);
  if (!pr) return { ok: false, result: { error: t("act.prNotOpen") } };
  const blocked =
    (await useLocal(cfg, `${cfg.remote}/${pr.base}`))
      ? requireLocalGreen(await localChecks(cfg, host, await prHeadSha(cfg, pr.branch), `${cfg.remote}/${pr.base}`), "PR")
      : requireGreen(await checksWhenDone(() => host.prChecks(pr.url), "PR"), "PR");
  if (blocked) return { ok: false, result: blocked };
  const keep = protectedBranch(pr.branch, cfg.baseBranch);
  const merged = await mergeUnlessConflict(host, pr.url, keep ? { method: "merge", deleteBranch: false } : undefined);
  if (!merged) return { ok: false, result: { error: t("act.prConflictsExternal", { base: pr.base }), url: pr.url } };
  return { ok: true, result: { url: pr.url, sha: merged.sha } };
}

/**
 * Mergea el PR; si choca con la rama base (alguien mergeó antes algo que toca los mismos ficheros), devuelve null en vez
 * de lanzar: no es un fallo de Backcode, hay que poner la rama al día y se explica en la app.
 */
export async function mergeUnlessConflict(host: PrHost, prUrl: string, opts?: MergeOptions): Promise<{ sha?: string } | null> {
  try {
    return await (opts ? host.merge(prUrl, opts) : host.merge(prUrl));
  } catch (e) {
    if (isMergeConflictError(e)) return null;
    throw e;
  }
}

/**
 * «Promocionar a producción»: abre (o reutiliza) la PR de la rama de preview a la base con las tareas que entran (las
 * mergeadas que están en preview y aún no en la base). Se mergea luego desde la app (mergePr: merge commit, sin borrar).
 */
async function promote(cfg: RunnerConfig, store: Store, host: PrHost | undefined) {
  const from = previewBranch();
  if (!from) return { ok: false, result: { error: t("env.noPreview") } };
  if (!host) return { ok: false, result: { error: t("act.noHostOpen") } };
  await gitIn(cfg.repoPath, ["fetch", "--quiet", cfg.remote, cfg.baseBranch, from]);
  const [fromSha, toSha] = await Promise.all([remoteSha(cfg.repoPath, cfg.remote, from), remoteSha(cfg.repoPath, cfg.remote, cfg.baseBranch)]);
  const commits = await countBetween(cfg.repoPath, toSha, fromSha);
  if (!commits) return { ok: false, result: { error: t("env.nothingToPromote", { from, to: cfg.baseBranch }) } };
  // Las que van en preview y no en la base: includedTasks con la base como «despliegue anterior».
  const features = await includedTasks(await store.mergedFeatures(), fromSha, toSha, (a, c) => isAncestor(cfg.repoPath, a, c));
  const { title, body } = promotionPr(features, commits, from, cfg.baseBranch, t("pr.generated"));
  const url = await host.openOrUpdatePr({ cwd: cfg.repoPath, branch: from, base: cfg.baseBranch, title, body });
  return { ok: true, result: { url, sha: fromSha, features, log: t("env.promoted", { n: commits, from, to: cfg.baseBranch }) } };
}

/**
 * «Sincronizar»: lleva la base a la rama de preview (tras promocionar o tras un hotfix directo a la base). Fast-forward
 * si la de preview no tiene nada propio; si no, merge en una copia temporal. Sin forzar nunca: con conflictos o si el
 * push está protegido, abre (o reutiliza) una PR de la base a la de preview.
 */
async function syncPreview(cfg: RunnerConfig, host: PrHost | undefined) {
  const to = previewBranch();
  if (!to) return { ok: false, result: { error: t("env.noPreview") } };
  await gitIn(cfg.repoPath, ["fetch", "--quiet", cfg.remote, cfg.baseBranch, to]);
  const [baseSha, toSha] = await Promise.all([remoteSha(cfg.repoPath, cfg.remote, cfg.baseBranch), remoteSha(cfg.repoPath, cfg.remote, to)]);
  const mode = syncMode(await countBetween(cfg.repoPath, toSha, baseSha), await countBetween(cfg.repoPath, baseSha, toSha));
  if (mode === "uptodate") return { ok: true, result: { sha: toSha, log: t("env.syncUpToDate", { to, base: cfg.baseBranch }) } };
  let reason = "";
  if (mode === "fast-forward") {
    // Sin --force: el remoto solo lo acepta si de verdad es un fast-forward.
    const pushed = await withRemoteRetry(() => exec(["git", "push", "--no-verify", cfg.remote, `${baseSha}:refs/heads/${to}`], cfg.repoPath), { label: "git push" }).then(() => true, (e: Error) => ((reason = e.message.slice(-400)), false));
    if (pushed) return { ok: true, result: { sha: baseSha, log: t("env.synced", { to, base: cfg.baseBranch }) } };
  } else {
    const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_sync", toSha);
    try {
      const msg = `Merge ${cfg.baseBranch} into ${to} (Backcode)`;
      const merged = await exec(["git", "-c", "user.name=Backcode", "-c", "user.email=backcode@users.noreply.github.com", "merge", "--no-ff", "--no-edit", "-m", msg, baseSha], wt).then(() => true, async (e: Error) => {
        reason = e.message.slice(-400);
        await exec(["git", "merge", "--abort"], wt).catch(() => undefined);
        return false;
      });
      if (merged) {
        const ok = await withRemoteRetry(() => exec(["git", "push", "--no-verify", cfg.remote, `HEAD:refs/heads/${to}`], wt), { label: "git push" }).then(() => true, (e: Error) => ((reason = e.message.slice(-400)), false));
        if (ok) return { ok: true, result: { sha: (await exec(["git", "rev-parse", "HEAD"], wt)).trim(), log: t("env.synced", { to, base: cfg.baseBranch }) } };
      }
    } finally {
      await removeWorktree(cfg.repoPath, wt);
    }
  }
  if (!host) return { ok: false, result: { error: t("env.syncFailed", { to, base: cfg.baseBranch, reason }) } };
  const url = await host.openOrUpdatePr({ cwd: cfg.repoPath, branch: cfg.baseBranch, base: to, title: `Sincronizar ${cfg.baseBranch} → ${to}`, body: `${t("env.syncPrBody", { to, base: cfg.baseBranch })}\n\n${t("pr.generated")}` });
  return { ok: true, result: { url, log: t("env.syncPr", { to, base: cfg.baseBranch, reason }) } };
}

/** Ficheros de la rama de la tarea que chocan con la rama base (vacío si no chocan o no se pudo saber). */
async function conflictFiles(cfg: RunnerConfig, branch: string | undefined): Promise<string[]> {
  if (!branch) return [];
  return fetchBranches(cfg.repoPath, cfg.remote, taskBase(cfg.baseBranch), branch)
    .then(() => findConflicts(cfg.repoPath, cfg.worktreesDir, cfg.remote, taskBase(cfg.baseBranch), branch))
    .catch(() => [] as string[]);
}

/**
 * Pone al día con la base un PR que va por detrás (updateBehindPr) y espera a que el host vea el commit nuevo, para que
 * los checks que se lean luego sean los suyos. Devuelve los ficheros en conflicto si choca (no sube nada); si no, [].
 */
async function updateBehind(cfg: RunnerConfig, store: Store, host: PrHost, featureId: string, prUrl: string, branch: string): Promise<string[]> {
  const base = taskBase(cfg.baseBranch);
  const res = await updateBehindPr({ repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir, remote: cfg.remote, base, branch, name: featureId });
  if (res.status === "conflicts") return res.files.length ? res.files : await conflictFiles(cfg, branch);
  if (res.status !== "merged" || !res.sha) return [];
  console.log(`[action] ${t("act.updatedWithBase", { base: `${cfg.remote}/${base}`, sha: res.sha.slice(0, 7) })}`);
  await store.event(featureId, "merge", t("act.updatedWithBase", { base: `${cfg.remote}/${base}`, sha: res.sha.slice(0, 7) })).catch(() => undefined);
  await followLocalWorktree(cfg, featureId, branch).catch(() => undefined);
  await waitHostHead(host.prHeadSha ? () => host.prHeadSha!(prUrl) : undefined, res.sha);
  return [];
}

/** El PR choca con la base. Se marcan ya los ficheros en conflicto (sin esperar a la comprobación periódica) para que la app ofrezca «Arreglar con Claude». */
async function conflictsBlock(cfg: RunnerConfig, store: Store, featureId: string, prUrl: string, files: string[]): Promise<{ ok: false; result: ActionResult; blocked: MergeBlock }> {
  if (files.length) await store.setConflicts(featureId, files).catch(() => undefined);
  const error = files.length ? t("act.prConflictsFiles", { base: taskBase(cfg.baseBranch), files: files.join(", ") }) : t("act.prConflicts", { base: taskBase(cfg.baseBranch) });
  return { ok: false, result: { error, url: prUrl }, blocked: "conflicts" };
}

/** Por qué no se mergeó un PR (el modo auto lo usa para decidir si arregla y reintenta o se para: auto-merge.ts). */
export type MergeBlock = "ciTask" | "noHost" | "noPr" | "closed" | "noChecks" | "ciNoChecks" | "pending" | "checks" | "ciNotStarted" | "conflicts";

/**
 * Mergea (squash) el PR de una tarea si sus checks están en verde. `auto`: lo hace el modo auto del proyecto, que nunca
 * mergea sin checks (aunque el proyecto no los exija) y deja la marca `merged.auto` para el aviso.
 */
export async function merge(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string, opts: { auto?: boolean; confirmCi?: boolean; localChecks?: boolean; skipChecks?: boolean } = {}): Promise<{ ok: boolean; result: ActionResult; blocked?: MergeBlock }> {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") }, blocked: "noHost" };
  const prUrl = await store.prUrlOf(featureId);
  if (!prUrl?.startsWith("https://")) return { ok: false, result: { error: t("act.noPr") }, blocked: "noPr" };
  // Antes, el estado real del PR: puede haberse mergeado o cerrado a mano en GitHub/Bitbucket.
  const pr = await host.prState(prUrl).catch(() => null);
  if (pr?.state === "merged") {
    await store.markMerged(featureId, pr.sha, opts.auto);
    return { ok: true, result: { url: prUrl, sha: pr.sha } };
  }
  if (pr?.state === "closed") {
    return { ok: false, result: { error: t("act.prClosed", { host: host.kind === "github" ? "GitHub" : "Bitbucket" }), url: prUrl }, blocked: "closed" };
  }
  const info = await store.featureInfo(featureId).catch(() => null);
  // PR de una tarea de CI (ci-task.ts): define qué comprueba la CI y podría dejarse en verde a sí mismo, así que nunca se
  // mergea solo (modo auto, «Mergear todo»): solo un merge individual que la persona confirmó en la app viendo los
  // ficheros y el diff (confirmCi). Si ya se mergeó a mano en el host, lo de arriba lo marca como mergeado.
  const ciTask = info?.kind === "ci";
  if (ciTask && (opts.auto === true || opts.confirmCi !== true)) return { ok: false, result: { error: t("ci.noMerge", { host: host.kind === "github" ? "GitHub" : "Bitbucket" }), url: prUrl }, blocked: "ciTask" };
  const strict = requireChecks || opts.auto === true;
  const branch = info?.branch;
  const baseRef = `${cfg.remote}/${taskBase(cfg.baseBranch)}`;
  /** Pasa los checks locales en el último commit del PR (sha de su rama en el remoto); null si no se sabe cuál es. */
  const runLocal = async (): Promise<LocalRun | null> => {
    const sha = branch ? await prHeadSha(cfg, branch) : "";
    if (!sha) return null;
    const run = await localChecks(cfg, host, sha, baseRef);
    rememberPrLog(prUrl, run.log);
    return run;
  };
  // Dónde pasaron los checks (para decirlo si luego el merge falla por una caída de GitHub/Bitbucket).
  let greenWhere: "local" | "host" | "none" = "none";
  // «Sin CI» (proyecto) o «Merge sense CI» (solo ese merge): sin esperar ni pasar checks (ver mergeChecksPlan).
  const plan = mergeChecksPlan({ mode: checksMode, skipChecks: opts.skipChecks === true, auto: opts.auto === true, requireChecks, local: checksMode !== "none" && (await useLocal(cfg, baseRef)) });
  if (plan === "blocked") return { ok: false, result: { error: t("act.noneBlocked"), url: prUrl }, blocked: "noChecks" };
  if (plan === "skip") {
    // Sin checks, pero los conflictos se miran igual (el merge fallaría).
    const files = await conflictFiles(cfg, branch);
    if (files.length) return conflictsBlock(cfg, store, featureId, prUrl, files);
  } else if (plan === "local") {
    // Checks en local: los de la CI del host no cuentan. Antes, los conflictos (el merge fallaría igualmente).
    const files = await conflictFiles(cfg, branch);
    if (files.length) return conflictsBlock(cfg, store, featureId, prUrl, files);
    // Ya verificados en verde al terminar la tarea sobre este mismo commit del PR y esta misma base: no se repiten.
    const verified = await alreadyVerified(cfg, store, featureId, branch, baseRef);
    if (verified) {
      console.log(`[action] ${t("lc.verifySkip", { sha: verified.slice(0, 7) })}`);
      await store.event(featureId, "merge", t("lc.verifySkip", { sha: verified.slice(0, 7) })).catch(() => undefined);
    } else {
      const run = await runLocal();
      if (!run) return { ok: false, result: { error: t("act.localNoBranch"), url: prUrl }, blocked: "noChecks" };
      const blocked = requireLocalGreen(run, "PR");
      if (blocked) return { ok: false, result: { ...blocked, url: prUrl, checksWhere: "local" }, blocked: run.checks.state === "failing" ? "checks" : "noChecks" };
    }
    greenWhere = "local";
  } else {
    // Con CI en el repo, un PR sin checks no es «sin CI»: o GitHub aún no los ha registrado (se espera a que aparezcan) o
    // no los lanzó porque el PR choca con la base (no puede crear el merge ref), y entonces se trata como conflictos.
    const ciExpected =
      store.capabilities.ci === true ||
      (await ciConfigAt(cfg.repoPath, baseRef)) ||
      (!!branch && (await ciConfigAt(cfg.repoPath, `${cfg.remote}/${branch}`)));
    // Con «Exigir checks» o en modo auto, un PR que va por detrás de la base se pone al día antes (y la CI vuelve a correr
    // sobre el commit nuevo): sus checks en verde eran contra una base vieja, sin lo que se mergeó después.
    if (strict && branch) {
      const updated = await updateBehind(cfg, store, host, featureId, prUrl, branch);
      if (updated.length) return conflictsBlock(cfg, store, featureId, prUrl, updated);
    }
    const gate = await gatePrChecks({
      read: () => host.prChecks(prUrl),
      conflicts: () => conflictFiles(cfg, branch),
      ciExpected,
      wait: { onWait: () => console.log(`[action] ${t("act.waitingChecks", { what: "PR" })}`) },
    });
    if (gate.conflicts) return conflictsBlock(cfg, store, featureId, prUrl, gate.conflicts);
    const { checks } = gate;
    // Checks en rojo que no llegaron a ejecutarse (GitHub Actions sin minutos o con un pago fallido): la app ofrece pasarlos
    // en local en vez de quedarse bloqueado.
    const notStarted = checks.state === "failing" && (await onlyNotStarted(host, prUrl, checks));
    // Minutos de Actions agotados: la app ofrece pausar GitHub Actions hasta que se renueven.
    if (notStarted && ghActions && !ghActions.isPaused()) {
      ghActions.markOutOfMinutes();
      onActionsChange();
    }
    if (opts.localChecks && opts.auto !== true && (checks.state === "failing" || checks.state === "none")) {
      // «Pasar los checks en local»: sustituyen a los que no arrancaron; a los que fallaron de verdad, solo sin «Exigir checks».
      if (checks.state === "failing" && !notStarted && requireChecks) return { ok: false, result: { error: t("act.localOverrideRequired"), url: prUrl, checks: checks.pending }, blocked: "checks" };
      const run = await runLocal();
      if (!run) return { ok: false, result: { error: t("act.localNoBranch"), url: prUrl }, blocked: "checks" };
      const blocked = requireLocalGreen(run, "PR");
      if (blocked) return { ok: false, result: { ...blocked, url: prUrl, checksWhere: "local" }, blocked: run.checks.state === "failing" ? "checks" : "noChecks" };
      await store.event(featureId, "merge", t(notStarted ? "act.localReplacedNotStarted" : "act.localReplacedFailing", { checks: checks.pending.join(", ") }));
      greenWhere = "local";
    } else {
      if (gate.ciNoChecks && strict) return { ok: false, result: { error: t("act.ciNoChecks", { what: "PR" }), url: prUrl }, blocked: "ciNoChecks" };
      const blocked = requireGreen(checks, "PR", strict);
      if (notStarted && blocked) return { ok: false, result: { error: t("act.ciNotStarted"), url: prUrl, checks: checks.pending, blocked: "ciNotStarted", checksWhere: "host" }, blocked: "ciNotStarted" };
      const why: MergeBlock = checks.state === "failing" ? "checks" : checks.state === "pending" ? "pending" : "noChecks";
      // En rojo, con el final del log de lo que falla: la app lo enseña y lo devuelve a Claude Code (fix-checks.ts).
      if (blocked) return { ok: false, result: { ...blocked, checksWhere: "host", ...(checks.state === "failing" ? await failingLog(host, prUrl).then((log) => (log ? { log } : {})) : {}) }, blocked: why };
      if (checks.state === "green") greenWhere = "host";
    }
  }
  // Con los checks ya en verde, un merge que falla por una caída de GitHub/Bitbucket (ya reintentado) lo dice: los checks
  // están bien, solo falta volver a mergear cuando el host responda.
  const merged = await mergeUnlessConflict(host, prUrl).catch(async (e: Error) => {
    // Sin CI pero el host exige checks obligatorios (protección de rama): decirlo claro en vez del error crudo.
    if (plan === "skip" && isBranchProtectionError(e)) throw new Error(t("act.branchProtection", { host: host.kind === "github" ? "GitHub" : "Bitbucket" }));
    if (greenWhere === "none" || !isTransientRemoteError(e)) throw e;
    const why = await explainRemoteError(String(e.message ?? e), remoteTexts());
    throw new Error(`${t(greenWhere === "local" ? "act.greenLocalMergeFailed" : "act.greenHostMergeFailed")}\n\n${why}`);
  });
  if (!merged) return conflictsBlock(cfg, store, featureId, prUrl, await conflictFiles(cfg, branch));
  const { sha } = merged;
  await store.markMerged(featureId, sha, opts.auto, ciTask);
  if (plan === "skip") await store.event(featureId, "merge", t("act.skippedChecks"));
  // Quién confirmó el merge del PR de CI (el runner que ejecuta la acción es el de quien la pidió): queda en la tarea
  // (merged.by + merged.ciConfirmed) y en su log.
  if (ciTask) await store.event(featureId, "merge", t("ci.mergeConfirmed", { who: store.uid }));
  // Tu copia local se pone al día para que veas el cambio (solo si es seguro: ver syncLocalBase).
  await syncLocal(cfg);
  // La rama ya no existe: la copia de trabajo de la tarea sobra.
  await removeWorktree(cfg.repoPath, join(cfg.worktreesDir, featureId)).catch(() => undefined);
  return { ok: true, result: { url: prUrl, sha } };
}

/** «Pausar / Reactivar GitHub Actions» (solo admins): desactiva los workflows activos del repo o reactiva los que pausó. */
async function pauseActions(pause: boolean, autoResume: boolean): Promise<{ ok: boolean; result: ActionResult }> {
  if (!ghActions) return { ok: false, result: { error: t("ga.unsupported") } };
  try {
    if (pause) {
      const p = await ghActions.pause(autoResume);
      console.log(`[actions] ${t("ga.paused", { n: p.workflows.length, until: p.until.slice(0, 10) })}`);
    } else {
      const names = await ghActions.resume();
      console.log(`[actions] ${t("ga.resumed", { names: names.join(", ") || "-" })}`);
    }
    return { ok: true, result: {} };
  } finally {
    onActionsChange();
  }
}

/** «Relanzar los checks»: vuelve a ejecutar en el host los jobs en rojo del PR de una tarea (GitHub Actions). */
async function rerunChecks(store: Store, host: PrHost | undefined, featureId: string): Promise<{ ok: boolean; result: ActionResult }> {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  if (!host.rerunFailed) return { ok: false, result: { error: t("act.rerunUnsupported") } };
  const prUrl = await store.prUrlOf(featureId);
  if (!prUrl?.startsWith("https://")) return { ok: false, result: { error: t("act.noPr") } };
  const n = await host.rerunFailed(prUrl);
  if (!n) return { ok: false, result: { error: t("act.rerunNone"), url: prUrl } };
  return { ok: true, result: { url: prUrl } };
}

async function publishOta(cfg: RunnerConfig, store: Store, host: PrHost | undefined, channel: "preview" | "production", message: string, rollbackTo?: string, commitDirty = false, skipSmoke = false, promote = false) {
  if (promote) {
    if (channel !== "production" || !rollbackTo) return { ok: false, result: { error: t("act.promoteNoPreview") } };
    const last = await store.lastDeploys();
    const bad = promoteCheck(rollbackTo, { preview: last.get("ota:preview"), production: last.get("ota:production") });
    if (bad) return { ok: false, result: { error: t(bad.error, bad.vars) } };
  }
  // Cada canal publica su rama: production la base y preview la de preview, si el proyecto tiene (environments.ts).
  const branch = branchForChannel(cfg.baseBranch, channel);
  const head = await remoteHead(cfg.repoPath, cfg.remote, branch);
  // Rollback: solo commits que ya están en la rama del canal (revisados); no se puede publicar cualquier commit.
  if (rollbackTo && !(await isAncestor(cfg.repoPath, rollbackTo, head))) {
    return { ok: false, result: { error: t("act.notInBase", { sha: rollbackTo.slice(0, 7), base: `${cfg.remote}/${branch}` }) } };
  }
  let commit = rollbackTo ?? head;
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: t("act.notExpo") } };
  if (!app.ota) return { ok: false, result: { error: otaMissing() } };
  if (!app.channels.includes(channel)) return { ok: false, result: { error: t("act.noChannel", { channel }) } };
  // En un rollback no se esperan los checks: esa versión ya se publicó antes y hay prisa por deshacer.
  if (!rollbackTo) {
    const blocked = await requireGreenBase(cfg, host, commit, branch);
    if (blocked) return { ok: false, result: blocked };
  }

  const parsed = app.ota === "script" ? otaScriptArgs(app.otaScript ?? "", app.pm, channel, message) : null;
  if (parsed && "error" in parsed) return { ok: false, result: { error: t("act.otaFixedBranch", { fixed: parsed.fixed, channel }) } };
  let scriptArgs = parsed;

  const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_ota", commit);
  const dir = join(wt, app.appDir);
  const repoAppDir = join(cfg.repoPath, app.appDir);
  try {
    await installFrozen(app, wt, dir);
    // Los .env locales (ignorados por git): los usan la prueba de arranque y el script del repo.
    await copyLocalFiles(cfg.repoPath, wt, [".env", ".env.local", join(app.appDir, ".env"), join(app.appDir, ".env.local")]);

    // Archivos sin commitear (p. ej. el lockfile que reescribe la instalación): el script del repo se negaría a publicar,
    // así que se avisa ya, sin esperar a la build y la prueba de arranque. Con «Commit y publicar» se commitean en la rama
    // base y se publica ese commit.
    const dirty = await dirtyFiles(wt);
    if (dirty.length && !commitDirty) return { ok: false, result: { error: t("act.dirty", { files: dirty.slice(0, 20).join(", ") }), dirty: dirty.slice(0, 50), sha: commit } };
    if (dirty.length) {
      const pushed = await commitAndPush(cfg, wt, dirty, message, branch);
      if ("error" in pushed) return { ok: false, result: { error: pushed.error, sha: commit } };
      commit = pushed.sha;
    }

    // Prueba de arranque obligatoria: un OTA que cierra la app al arrancar no se puede arreglar con otro OTA (el móvil
    // no llega a descargarlo). Sin superarla, no se publica (tampoco un rollback). Si el script del repo sabe lanzarla
    // (BACKCODE_SMOKE_CLI), la hace él DESPUÉS de sus comprobaciones rápidas (árbol limpio, cambios nativos…): así un
    // fallo de esos se ve al momento y no tras la build. Si no, se hace aquí antes de llamarlo.
    // Con «Publicar sin comprobaciones» (lo pide un admin a sabiendas) no hay prueba de arranque, ni aquí ni en el script
    // (BACKCODE_SMOKE_DONE=1), y si el script tiene guarda de cambios nativos se le pasa --allow-native.
    if (skipSmoke && scriptArgs && scriptMentions(dir, app.otaScript ?? "", "--allow-native")) {
      const native = otaScriptArgs(app.otaScript ?? "", app.pm, channel, message, true);
      if (!("error" in native)) scriptArgs = native;
    }
    const scriptSmokes = !skipSmoke && !!scriptArgs && scriptMentions(dir, app.otaScript ?? "", "BACKCODE_SMOKE_CLI");
    const smoke = scriptSmokes || skipSmoke ? null : await smokeTest(dir, profileEnv(dir, channel), cfg.worktreesDir, repoAppDir);
    if (smoke && !smoke.ok) return { ok: false, result: { error: t("smoke.failed", { detail: smoke.detail }), sha: commit } };

    let out: string;
    if (scriptArgs) {
      // El script del repo (p. ej. xprem) recuerda la última publicación en .expo/ para su guarda de cambios nativos:
      // se copia a la copia limpia y se devuelve.
      copyLastPublish(repoAppDir, dir);
      // El script del repo puede tener su propia prueba de arranque: ya está hecha (arriba) con este mismo commit.
      const smokeEnv: Record<string, string> = scriptSmokes
        ? { BACKCODE_SMOKE_CLI: smokeCliPath(), BACKCODE_SMOKE_FROM: repoAppDir, BACKCODE_SMOKE_ENV: JSON.stringify(profileEnv(dir, channel)) }
        : { BACKCODE_SMOKE_DONE: "1" };
      // Si el script hace la prueba de arranque, cuenta su build (la primera vez, larga) en el tiempo máximo.
      out = await exec([app.pm, ...scriptArgs.args], dir, { env: smokeEnv, ...(scriptSmokes ? { timeoutMs: OTA_TIMEOUT_MS + 45 * 60_000 } : {}) }).catch(async (err: Error) => {
        throw new Error(`${err.message}${await publishedOffBase(cfg, repoAppDir, commit)}`);
      });
      copyLastPublish(dir, repoAppDir);
    } else {
      // Siempre al 100 % y para todas las plataformas (sin despliegue gradual).
      out = await exec(["npx", "--yes", "eas-cli@latest", "update", "--channel", channel, "--environment", channel, "--message", message.slice(0, 200), "--platform", "all", "--non-interactive"], dir);
    }
    const url = out.match(/https:\/\/expo\.dev\/accounts\/\S+/g)?.pop();
    // Las tareas cuyo merge va en este commit quedan "desplegadas" en el canal (no en un rollback, sí al promocionar) y constan en el OTA.
    const features = rollbackTo && !promote ? [] : await markDeployedTasks(store, channel, commit, (a, c) => isAncestor(cfg.repoPath, a, c));
    // Versión del OTA: la runtimeVersion que imprime EAS o, si no, la de la app (runtimeVersion = versión de la app).
    const ota = otaInfoFrom(out);
    const version = ota.runtimeVersion ?? (await readVersion(readFrom(dir), ""));
    return { ok: true, result: { url, sha: commit, ...(version ? { version } : {}), ...(ota.updateId ? { updateId: ota.updateId } : {}), features, log: `${smoke ? `${smoke.detail}\n` : skipSmoke ? `${t("smoke.skipped")}\n` : ""}${out.slice(-1400)}` } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(-3000), sha: commit } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
    // Por si git no pudo quitarla: la copia lleva los .env copiados.
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * «Prova aquest PR al teu mòbil»: publica por EAS Update SOLO el código del PR de una tarea (la punta de su rama) en un
 * canal propio del PR (`pr-<número>`, ver pr-ota.ts), con las variables de preview (mismo runtimeVersion que la build
 * de preview). Nunca toca production ni el canal preview compartido. Se puede repetir tras nuevos commits: publica la
 * versión nueva en el mismo canal. Si el PR cambia código nativo no se publica (no llegaría por OTA): se dice cuáles.
 */
async function publishPrOta(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string): Promise<{ ok: boolean; result: ActionResult }> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(featureId)) return { ok: false, result: { error: t("git.badFeatureId", { id: featureId }) } };
  const [f, status] = await Promise.all([store.featureInfo(featureId), store.featureStatus(featureId)]);
  const n = prNumberOf(f.prUrl);
  if (status !== "done" || !f.branch || !f.prUrl || n === null) return { ok: false, result: { error: t("act.prOtaNotReady") } };
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  // Solo un PR abierto: ni mergeado ni cerrado.
  const pr = await host.prState(f.prUrl).catch(() => null);
  if (pr?.state !== "open") return { ok: false, result: { error: t("act.prOtaNotReady"), url: f.prUrl } };
  const channel = prChannel(n);

  await gitIn(cfg.repoPath, ["fetch", "--quiet", cfg.remote, f.branch]);
  const commit = await gitIn(cfg.repoPath, ["rev-parse", "FETCH_HEAD"]);
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: t("act.notExpo") } };
  if (!app.ota) return { ok: false, result: { error: otaMissing() } };
  if (app.ota !== "eas" && app.otaProvider !== "eas") return { ok: false, result: { error: t("act.prOtaEasOnly") } };
  // Cambios nativos del PR respecto a la rama base: no pueden llegar por OTA (la app ofrece la versión de desarrollo).
  const base = `${cfg.remote}/${taskBase(cfg.baseBranch)}`;
  const changed = (await gitIn(cfg.repoPath, ["diff", "--name-only", `${base}...${commit}`]).catch(() => "")).split("\n").filter(Boolean);
  const native = nativeFiles(changed);
  if (native.length) return { ok: false, result: { error: t("act.prOtaNative", { files: native.slice(0, 10).join(", ") }), native: native.slice(0, 50), channel, sha: commit, url: f.prUrl } };

  const message = `PR #${n}: ${f.title}`.slice(0, 200);
  const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_prota", commit);
  const dir = join(wt, app.appDir);
  const repoAppDir = join(cfg.repoPath, app.appDir);
  try {
    await installFrozen(app, wt, dir);
    await copyLocalFiles(cfg.repoPath, wt, [".env", ".env.local", join(app.appDir, ".env"), join(app.appDir, ".env.local")]);
    const env = profileEnv(dir, "preview");
    // Prueba de arranque obligatoria, como en cualquier OTA: un PR que cierra la app al arrancar no se publica.
    const smoke = await smokeTest(dir, env, cfg.worktreesDir, repoAppDir);
    if (!smoke.ok) return { ok: false, result: { error: t("smoke.failed", { detail: smoke.detail }), sha: commit, channel } };
    const scheme = appScheme((await appConfig(dir, env)) as { scheme?: unknown } | null);
    const out = await exec(prOtaArgs(channel, message), dir);
    const url = out.match(/https:\/\/expo\.dev\/accounts\/\S+/g)?.pop();
    const ota = otaInfoFrom(out);
    const version = ota.runtimeVersion ?? (await readVersion(readFrom(dir), ""));
    const links = scheme ? { link: prOtaLink(scheme, channel), backLink: prOtaLink(scheme, "") } : {};
    return { ok: true, result: { url, sha: commit, channel, ...links, ...(version ? { version } : {}), ...(ota.updateId ? { updateId: ota.updateId } : {}), log: `${smoke.detail}\n${out.slice(-1400)}` } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(-3000), sha: commit, channel } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
    // Por si git no pudo quitarla: la copia lleva los .env copiados.
    rmSync(wt, { recursive: true, force: true });
  }
}

// La tienda rechaza un número de build repetido: App Store Connect (-19232, «already been used», «must be higher than
// the previously uploaded version») y Google Play («Version code N has already been used»).
const IOS_DUPLICATE_RE = /-19232|attribute with a value that has already been used|must be (higher|greater) than the previously uploaded|debe ser posterior a la versión cargada/i;
const ANDROID_DUPLICATE_RE = /version code \d+ has already been used|versionCode.{0,40}already (been )?used/i;

/**
 * Aviso cuando la tienda rechaza el número de build por repetido. Con `appVersionSource: remote` + `autoIncrement`, EAS
 * lleva su propio contador y solo cuenta sus builds: si otra build llegó a la tienda por otro camino (Transporter, Xcode,
 * otro proyecto con el mismo bundle id), la tienda va por delante. Se arregla subiendo el contador de EAS a mano.
 */
export function buildNumberHint(platform: "ios" | "android", output: string, appDir: string): string {
  const dir = appDir && appDir !== "." ? appDir : ".";
  if (platform === "ios" && IOS_DUPLICATE_RE.test(output)) return t("build.duplicateIos", { dir }) + "\n";
  if (platform === "android" && ANDROID_DUPLICATE_RE.test(output)) return t("build.duplicateAndroid", { dir }) + "\n";
  return "";
}

/**
 * Build LOCAL con EAS (`eas build --local`, en este ordenador) y envío a testers con `eas submit`: iOS va a TestFlight
 * y Android al track `internal` de Google Play (Internal Testing). Usa el perfil `production` de eas.json y la sesión
 * de EAS de quien lo pide (credenciales gestionadas por EAS); no se toca `ios/` ni `android/`.
 * La versión y la runtimeVersion llegan como APP_VERSION y RUNTIME_VERSION: la configuración de la app (app.config.js)
 * tiene que leerlas. Antes de compilar se comprueba con `expo config` que de verdad se aplican.
 */
async function publishBuild(cfg: RunnerConfig, host: PrHost | undefined, action: Action): Promise<{ ok: boolean; result: ActionResult; noRetry?: boolean }> {
  const platforms = (["ios", "android"] as const).filter((p) => action.platforms?.includes(p));
  const version = action.version ?? "";
  const runtimeVersion = action.runtimeVersion ?? "";
  if (!platforms.length) return { ok: false, result: { error: t("build.noPlatform") } };
  if (!VERSION_RE.test(version)) return { ok: false, result: { error: t("build.badVersion", { v: version }) } };
  if (!RUNTIME_VERSION_RE.test(runtimeVersion)) return { ok: false, result: { error: t("build.badRuntime", { v: runtimeVersion }) } };
  if (platforms.includes("ios") && process.platform !== "darwin") return { ok: false, result: { error: t("build.needMac") } };

  // Builds para testers (TestFlight / Internal Testing): de la rama de preview si el proyecto tiene (environments.ts).
  const branch = branchForChannel(cfg.baseBranch, "preview");
  const commit = await remoteHead(cfg.repoPath, cfg.remote, branch);
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: t("build.notExpo") } };
  if (!app.buildProfiles.includes(BUILD_PROFILE)) return { ok: false, result: { error: t("build.noProfile", { p: BUILD_PROFILE }) } };
  const blocked = await requireGreenBase(cfg, host, commit, branch);
  if (blocked) return { ok: false, result: blocked };

  const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_build", commit);
  const dir = join(wt, app.appDir);
  const env = { APP_VERSION: version, RUNTIME_VERSION: runtimeVersion };
  const done: string[] = [];
  let url: string | undefined;
  try {
    await installFrozen(app, wt, dir);
    // Sin esto, una app que no lea las variables saldría con la versión de app.json sin que nadie se entere.
    const resolved = parseJson(await exec(["npx", "expo", "config", "--json", "--type", "public"], dir, { env })) as {
      version?: unknown;
      runtimeVersion?: unknown;
      ios?: { googleServicesFile?: unknown };
      android?: { googleServicesFile?: unknown };
    } | null;
    if (resolved?.version !== version || resolved?.runtimeVersion !== runtimeVersion) {
      const got = `version=${JSON.stringify(resolved?.version)}, runtimeVersion=${JSON.stringify(resolved?.runtimeVersion)}`;
      return { ok: false, result: { sha: commit, error: t("build.versionNotApplied", { got }) } };
    }
    // Los ficheros de Firebase (GoogleService-Info.plist / google-services.json) suelen estar ignorados por git: sin
    // copiarlos, el prebuild de la copia limpia falla con ENOENT. Solo estos: un .env local de desarrollo no debe
    // acabar dentro del binario de la tienda.
    const services = [resolved?.ios?.googleServicesFile, resolved?.android?.googleServicesFile].filter((f): f is string => typeof f === "string");
    await copyLocalFiles(cfg.repoPath, wt, services.map((f) => join(app.appDir, f)));
    // Las claves de las tiendas del perfil de submit (fastlane/AuthKey_*.p8, play-service-account.json) también están
    // ignoradas por git: sin ellas `eas submit` pide la ruta y falla. Se enlazan (no se copian) a las del repo.
    await linkLocalFiles(cfg.repoPath, wt, submitKeyPaths(dir).map((f) => join(app.appDir, f)));
    let log = "";
    for (const platform of platforms) {
      const artifact = join(wt, `backcode-build.${platform === "ios" ? "ipa" : "aab"}`);
      try {
        log += await exec(["npx", "--yes", "eas-cli@latest", "build", "--local", "--platform", platform, "--profile", BUILD_PROFILE, "--output", artifact, "--non-interactive"], dir, { env, timeoutMs: BUILD_TIMEOUT_MS });
        // Perfil de submit por defecto de EAS (`production` si existe). iOS → TestFlight; Android → su track
        // (`internal`, el de EAS por defecto).
        const out = await exec(["npx", "--yes", "eas-cli@latest", "submit", "--platform", platform, "--path", artifact, "--non-interactive"], dir, { env });
        log += out;
        url = out.match(/https:\/\/expo\.dev\/accounts\/\S+/g)?.pop() ?? url;
        done.push(platform);
      } catch (err) {
        const before = done.length ? t("build.alreadySent", { list: done.join(", ") }) : "";
        const message = String((err as Error).message);
        // El aviso va delante: el error se recorta por el final y no debe perderse.
        const hint = buildNumberHint(platform, message, app.appDir);
        // Si ya se envió alguna plataforma, no se reintenta sola: se volvería a compilar y enviar la que salió bien.
        return { ok: false, noRetry: done.length > 0 || !!hint, result: { url, sha: commit, error: `${hint}${before}${platform}: ${message}`.slice(0, hint.length + before.length + 3000) } };
      }
    }
    const buildNumber = buildNumberFrom(log);
    return { ok: true, result: { url, sha: commit, version, ...(buildNumber ? { buildNumber } : {}), log: `${done.join(" + ")} · ${version}${buildNumber ? ` (${buildNumber})` : ""} (runtime ${runtimeVersion})\n${log.slice(-1400)}` } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(-3000), sha: commit } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

const INSTALL_TIMEOUT_MS = 60 * 60_000;
const STEP_RE = /^(ota:(production|preview)|deploy:[A-Za-z0-9._/@-]{0,200}#[a-z0-9][a-z0-9-]{0,39})$/;

/**
 * «Desplegarlo todo»: los pasos pedidos, en el orden del plan (reglas → functions → resto → OTA), cada uno como si se
 * hubiera pedido suelto (mismos checks y la prueba de arranque de la OTA). Al primer fallo se para: no tiene sentido
 * publicar la app nueva si sus reglas o sus functions no han salido. skipSmoke (perfil «sin comprobaciones por defecto»)
 * solo afecta al paso OTA.
 */
export async function deployAll(cfg: RunnerConfig, store: Store, host: PrHost | undefined, requested: string[], message: string, skipSmoke = false, actionId?: string, run: DeployAllRunner = {}): Promise<{ ok: boolean; result: ActionResult }> {
  const wanted = [...new Set(requested)].filter((s) => STEP_RE.test(s)).slice(0, 10);
  if (!wanted.length) return { ok: false, result: { error: t("plan.noSteps") } };
  const order = (store.plan?.steps ?? []).map((s) => s.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : 100 + (id.startsWith("ota:") ? 1 : 0));
  const steps = wanted.sort((a, b) => rank(a) - rank(b));
  const log: string[] = [];
  const features: DeployedTask[] = [];
  // Progreso en vivo en el documento de la acción (paso actual y pasos hechos): la app lo ve avanzar.
  // Si una escritura falla (p. ej. la deniegan las reglas), queda en el log y el despliegue sigue.
  const progress = new DeployProgress<StepResult>(steps, (r) => (actionId ? store.actionProgress(actionId, r as unknown as Record<string, unknown>) : Promise.resolve()), Date.now, {
    onError: progressFailed(actionId ?? "-"),
  });
  // Cada paso con sus reintentos automáticos (withAutoRetry); `run.step` (tests) sustituye solo el comando del paso.
  const providerOf = (id: string) => (id.startsWith("ota:") ? "eas" : store.capabilities?.deploys.find((d) => `deploy:${d.id}` === id)?.provider);
  const command = (id: string) =>
    run.step
      ? run.step(id)
      : id.startsWith("ota:")
        ? publishOta(cfg, store, host, id.slice(4) as "production" | "preview", message || "Backcode", undefined, false, skipSmoke)
        : runDeploy(cfg, host, id.slice("deploy:".length));
  const runStep = (id: string, onRetry: RetryNotice) =>
    withAutoRetry(stepLabel(id), providerOf(id), () => command(id), onRetry, { ...(run.retry ? { settings: run.retry } : {}), ...(run.sleep ? { sleep: run.sleep } : {}) }).then((done) =>
      !run.step && id.startsWith("deploy:") ? withTasks(cfg, store, id, done) : done,
    );
  const lock = run.lock ?? deployLock(store);
  const finalResult = async (r: { ok: boolean; result: ActionResult }) => {
    await progress.settled();
    return r;
  };
  for (const [i, id] of steps.entries()) {
    const label = `${i + 1}. ${stepLabel(id)}`;
    console.log(`[action] deployAll ${label}`);
    await progress.start(id);
    // Antes de cada paso, el candado de despliegue del proyecto: si otro runner (u otra acción) despliega, se espera.
    const startedAt = Date.now();
    const done = withDeployLock(
      lock,
      actionId ?? id,
      stepLabel(id),
      async () => {
        const began = Date.now();
        const out = await runStep(id, (attempt, max, reason) => progress.retrying(id, attempt, max, reason));
        return { ...out, began };
      },
      {
        onWait: async (busy) => {
          console.log(`[action] ${t("deploy.waitLock", { step: busy })}`);
          await progress.start(id, busy);
        },
        onAcquired: () => progress.running(id),
        ...(run.sleep ? { sleep: run.sleep } : {}),
      },
    );
    const { ok, result, began } = await done.catch((err: Error) => ({ ok: false, result: { error: err.message } as ActionResult, began: startedAt }));
    for (const f of result.features ?? []) if (features.length < MAX_DEPLOYED_TASKS && !features.some((g) => g.id === f.id)) features.push(f);
    await progress.finish({ id, ok, startedAt: began, durationMs: Date.now() - began, ...(result.sha ? { sha: result.sha } : {}), ...(result.version ? { version: result.version } : {}), ...(result.updateId ? { updateId: result.updateId } : {}), ...(result.url ? { url: result.url } : {}), ...(result.autoRetry ? { autoRetry: result.autoRetry } : {}), ...(ok ? {} : { error: String(result.error ?? "").slice(-1500) }) });
    log.push(`${ok ? "✓" : "✗"} ${label}${result.url ? ` · ${result.url}` : ""}`);
    if (!ok) {
      const skipped = steps.slice(i + 1).map((s, j) => `${i + j + 2}. ${stepLabel(s)}`);
      return finalResult({ ok: false, result: { order: steps, steps: progress.steps, ...(result.blocked === "ciNotStarted" ? { blocked: "ciNotStarted" as const } : {}), ...(features.length ? { features } : {}), ...(result.autoRetry ? { autoRetry: result.autoRetry } : {}), error: t("plan.stepFailed", { step: label, skipped: skipped.join(", ") || "—", error: String(result.error ?? "").slice(-2000) }), log: log.join("\n") } });
    }
  }
  return finalResult({ ok: true, result: { order: steps, steps: progress.steps, sha: progress.steps.at(-1)?.sha, features, log: log.join("\n") } });
}

/** Para los tests: cómo se hace cada paso, el candado y las esperas (por defecto, los de verdad). */
export interface DeployAllRunner {
  /** El comando de un paso (sin reintentos: los pone deployAll). */
  step?: (id: string) => Promise<{ ok: boolean; result: ActionResult; noRetry?: boolean }>;
  /** Reintentos automáticos (por defecto, los del proyecto). */
  retry?: { on: boolean; retries: number };
  lock?: DeployLock;
  sleep?: (ms: number) => Promise<void>;
}

/** Tras instalar la versión de desarrollo, Metro con la rama principal si no estaba en marcha (para que la app arranque). */
async function afterDevInstall(cfg: RunnerConfig, store: Store, dev: boolean, deviceId: string): Promise<string> {
  recordDevInstall(cfg.projectId, deviceId, dev);
  if (!dev || devServerRunning()) return "";
  const served = await devServe(cfg, store);
  return served.ok ? `${served.result.log}\n` : `${served.result.error}\n`;
}
const TEAM_RE = /^[A-Z0-9]{10}$/;

/**
 * Equipo de Apple para firmar la build de «Instalar en mi móvil»: el de la config de Expo (ios.appleTeamId); si no, el
 * de eas.json (submit › ios › appleTeamId); si no, el único equipo de empresa que tenga Xcode (un Personal Team no puede
 * registrar los bundle ids de la empresa). Sin ninguno claro, undefined: decide Expo.
 */
export async function signingTeam(dir: string, fromConfig?: string): Promise<string | undefined> {
  if (fromConfig && TEAM_RE.test(fromConfig)) return fromConfig;
  try {
    const eas = JSON.parse(readFileSync(join(dir, "eas.json"), "utf8")) as { submit?: Record<string, { ios?: { appleTeamId?: string } }> };
    const team = Object.values(eas.submit ?? {}).map((p) => p.ios?.appleTeamId).find((t): t is string => !!t && TEAM_RE.test(t));
    if (team) return team;
  } catch {
    // sin eas.json o no válido
  }
  const teams = await new Promise<string>((resolve) => execFile("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"], { timeout: 10_000 }, (_e, out) => resolve(out ?? "")));
  const company = new Set<string>();
  for (const block of teams.split("}")) {
    const id = /teamID = "?([A-Z0-9]{10})"?;/.exec(block)?.[1];
    if (id && !/teamType = "?Personal Team"?;/.test(block)) company.add(id);
  }
  return company.size === 1 ? [...company][0] : undefined;
}

/** Fija DEVELOPMENT_TEAM en todas las configuraciones del proyecto de Xcode generado (no en el de Pods). */
export function setDevelopmentTeam(iosDir: string, team: string): void {
  const project = readdirSync(iosDir).find((f) => f.endsWith(".xcodeproj") && f !== "Pods.xcodeproj");
  if (!project) return;
  const file = join(iosDir, project, "project.pbxproj");
  const text = readFileSync(file, "utf8")
    .replace(/^(\s*)DEVELOPMENT_TEAM = [^;]*;\n/gm, "")
    .replace(/^(\s*)buildSettings = \{\n/gm, (m, indent: string) => `${m}${indent}\tDEVELOPMENT_TEAM = ${team};\n`);
  writeFileSync(file, text);
}
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

/**
 * «Instalar en mi móvil»: compila la app en Release con lo último de la rama base y la instala directamente en uno de tus
 * móviles (el que eliges en la app entre los que este ordenador ve listos), por cable o por wifi. Sin tiendas ni
 * TestFlight y sin checks: solo llega a tu móvil. iOS: `expo run:ios` firma con tu equipo de Xcode e instala con
 * devicectl. Android: APK release con Gradle (firma de la plantilla) e `adb install`.
 */
async function installOnDevice(cfg: RunnerConfig, store: Store, action: Action): Promise<{ ok: boolean; result: ActionResult }> {
  const platform = action.platform;
  const dev = action.variant === "dev";
  const port = devPort(cfg.projectId);
  const deviceId = action.deviceId ?? "";
  if ((platform !== "ios" && platform !== "android") || !DEVICE_ID_RE.test(deviceId)) return { ok: false, result: { error: t("install.badDevice") } };
  if (platform === "ios" && process.platform !== "darwin") return { ok: false, result: { error: t("build.needMac") } };
  const device = (await listDevices()).find((d) => d.platform === platform && d.id === deviceId);
  if (!device) return { ok: false, result: { error: t("install.deviceGone") } };
  if (device.state !== "ready") return { ok: false, result: { error: t(`install.state.${device.state}`, { name: device.name }) } };

  // iPhone: antes de compilar (minutos), que esté desbloqueado y con la imagen de desarrollador montada; si no, Xcode
  // acaba con «Timed out waiting for all destinations» tras la build entera.
  if (platform === "ios") {
    const notReady = await prepareIosDevice(device.id);
    if (notReady) return { ok: false, result: { error: notReady === "locked" ? t("install.locked", { name: device.name }) : t("install.ddi", { name: device.name, log: notReady }) } };
  }

  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: t("build.notExpo") } };
  // Copia que se conserva entre instalaciones (dependencias, ios/android, Pods y la caché de Xcode por su ruta): solo se
  // mueve al commit nuevo, y así la segunda instalación compila lo que ha cambiado y no todo (de ~10 min a 1-2).
  const wt = await installWorktree(cfg, commit);
  const dir = join(wt, app.appDir);
  // Las variables del perfil de tienda de eas.json (EXPO_PUBLIC_…): la app se comporta como la publicada.
  const env = { ...profileEnv(dir, "production"), CI: "1" };
  const label = `${device.name}${device.model && device.model !== device.name ? ` (${device.model})` : ""}`;
  try {
    await depsIfChanged(app, wt, dir);
    // Los ficheros locales (ignorados por git) se copian de nuevo cada vez: en la copia que se conserva podrían ser viejos.
    const locals = [".env", ".env.local", join(app.appDir, ".env"), join(app.appDir, ".env.local")];
    for (const f of locals) rmSync(join(wt, f), { force: true });
    await copyLocalFiles(cfg.repoPath, wt, locals);
    const config = await appConfig(dir, env);
    const services = [config?.ios?.googleServicesFile, config?.android?.googleServicesFile].filter((f): f is string => typeof f === "string");
    await copyLocalFiles(cfg.repoPath, wt, services.map((f) => join(app.appDir, f)));

    if (platform === "ios") {
      // refresh: el ios/ que se conserva se pone al día con la config de Expo de este commit (sin --clean: rápido).
      const failed = await prepareNativeProject(dir, env, { refresh: true });
      if (failed) return { ok: false, result: { sha: commit, error: failed.detail } };
      // Equipo con el que se firma: si no se fija, Expo coge el primero que tenga Xcode (a menudo el Personal Team, que no
      // puede registrar el bundle id de la empresa: «Failed Registering Bundle Identifier»).
      const team = await signingTeam(dir, config?.ios?.appleTeamId);
      if (team) setDevelopmentTeam(join(dir, "ios"), team);
      // --no-install: los pods ya los ha dejado listos prepareNativeProject (como en la prueba de arranque de los OTA).
      // Versión de desarrollo: Debug con el puerto de Metro de este proyecto (React Native lo compila dentro). En Debug, Expo
      // arranca siempre su propio servidor y no termina: se da por hecho cuando la app ya está abierta en el móvil («Logs
      // for your project…») y ha descargado su código («iOS Bundled…», hasta 2 min) y se cierra; después arranca el Metro del
      // runner (afterDevInstall) en ese mismo puerto.
      if (dev) stopDevServer();
      const out = await exec(
        ["npx", "expo", "run:ios", "--configuration", dev ? "Debug" : "Release", "--device", device.id, "--no-install", ...(dev ? ["--port", String(port)] : ["--no-bundler"])],
        dir,
        { env: dev ? { ...env, RCT_METRO_PORT: String(port) } : env, timeoutMs: INSTALL_TIMEOUT_MS, ...(dev ? { doneWhen: /Logs for your project will appear below/, settleWhen: /Bundled \d+ms/, settleMs: 120_000 } : {}) },
      ).catch((err: Error) => {
        throw new Error(t("install.iosFailed", { log: buildErrors(err.message) }));
      });
      return { ok: true, result: { sha: commit, log: `${await afterDevInstall(cfg, store, dev, device.id)}${t("install.done", { device: label })}\n${out.slice(-1200)}` } };
    }

    const adb = adbPath();
    const sdk = androidSdk();
    if (!adb || !sdk) return { ok: false, result: { sha: commit, error: t("install.noAndroidSdk") } };
    const pkg = config?.android?.package;
    if (!pkg) return { ok: false, result: { sha: commit, error: t("install.noPackage") } };
    const androidEnv = { ...env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
    let log = await exec(["npx", "expo", "prebuild", "--platform", "android", "--no-install"], dir, { env: androidEnv, timeoutMs: INSTALL_TIMEOUT_MS });
    log += await exec(["./gradlew", dev ? "assembleDebug" : "assembleRelease", "--console=plain", ...(dev ? [`-PreactNativeDevServerPort=${port}`] : [])], join(dir, "android"), { env: androidEnv, timeoutMs: INSTALL_TIMEOUT_MS }).catch((err: Error) => {
      throw new Error(t("install.androidFailed", { log: buildErrors(err.message) }));
    });
    const apkDir = join(dir, "android", "app", "build", "outputs", "apk", dev ? "debug" : "release");
    const apk = existsSync(apkDir) ? readdirSync(apkDir).find((f) => f.endsWith(".apk")) : undefined;
    if (!apk) return { ok: false, result: { sha: commit, error: t("install.noApk") } };
    // -r: reinstala conservando los datos. Si la instalada es de la tienda (otra firma), Android no deja: se explica.
    await exec([adb, "-s", device.id, "install", "-r", join(apkDir, apk)], dir, { timeoutMs: 10 * 60_000 }).catch((err: Error) => {
      throw new Error(/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(err.message) ? t("install.otherSignature", { pkg }) : err.message);
    });
    if (dev) await adbReverse(adb, device.id, port);
    await exec([adb, "-s", device.id, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], dir).catch(() => undefined);
    return { ok: true, result: { sha: commit, log: `${await afterDevInstall(cfg, store, dev, device.id)}${t("install.done", { device: label })}\n${log.slice(-1200)}` } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(-3000), sha: commit } };
  } finally {
    // Se conserva para la próxima instalación, pero ya no está en uso (la limpieza periódica la borra tras días sin usar).
    releaseWorktree(wt);
  }
}

/** La copia de «Instalar en mi móvil» (_install): se crea una vez y después solo se mueve al commit pedido. */
async function installWorktree(cfg: RunnerConfig, commit: string): Promise<string> {
  const path = join(cfg.worktreesDir, "_install");
  if (!existsSync(join(path, ".git"))) return createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_install", commit);
  holdWorktree(path);
  try {
    await gitIn(path, ["checkout", "--detach", "--force", "--quiet", commit]);
    // Fuera lo que no es del repo, salvo lo que se quiere conservar (las carpetas ignoradas, como node_modules, ya se quedan).
    await gitIn(path, ["clean", "-fdq", "-e", "ios", "-e", "android", "-e", ".expo"]);
    return path;
  } catch {
    releaseWorktree(path);
    return createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_install", commit);
  }
}

/** Instala dependencias solo si faltan o cambió el lockfile desde la última vez en esta copia. */
async function depsIfChanged(app: Pick<ExpoApp, "pm">, wt: string, dir: string): Promise<void> {
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].flatMap((f) => [join(dir, f), join(wt, f)]).find((f) => existsSync(f));
  const hash = lock ? createHash("sha256").update(readFileSync(lock)).digest("hex") : "";
  const stamp = join(wt, "node_modules", ".backcode-lock");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === hash && (dir === wt || existsSync(join(dir, "node_modules")) || existsSync(join(wt, "node_modules")))) return;
  await installFrozen(app, wt, dir);
  mkdirSync(join(wt, "node_modules"), { recursive: true });
  writeFileSync(stamp, hash);
}

/**
 * Despliegue de un destino del repo (web, api, scripts…): ejecuta su script `backcode:deploy:<nombre>` en una copia
 * limpia de la rama base, con los checks en verde, sin interacción y con los .env locales (ignorados por git) de quien
 * lo pide. El destino se vuelve a buscar en el repo: la app solo elige entre los que el propio repo declara.
 */
async function runDeploy(cfg: RunnerConfig, host: PrHost | undefined, targetId: string) {
  // Con rama de preview, los destinos de staging/preview salen de ella y el resto de la rama base (environments.ts).
  const head = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const targets = await findDeployTargets(cfg.repoPath, head);
  const branch = branchForTarget(cfg.baseBranch, targetId, targets.map((d) => d.id));
  const commit = branch === cfg.baseBranch ? head : await remoteHead(cfg.repoPath, cfg.remote, branch);
  const target = (branch === cfg.baseBranch ? targets : await findDeployTargets(cfg.repoPath, commit)).find((d) => d.id === targetId);
  if (!target) return { ok: false, result: { error: t("deploy.unknown", { target: targetId }) } };
  const blocked = await requireGreenBase(cfg, host, commit, branch);
  if (blocked) return { ok: false, result: blocked };
  const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_deploy", commit);
  const dir = join(wt, target.dir);
  try {
    // Script de package.json: sus dependencias. Detectado: solo si esa carpeta es un paquete (p. ej. un Worker que importa
    // librerías). De backcode.toml: nunca (es para repos sin Node).
    if (!target.auto || (target.auto.install && existsSync(join(dir, "package.json")))) await installFrozen(target, wt, dir);
    for (const dep of target.auto?.deps ?? []) await installFrozen(dep, wt, join(wt, dep.dir));
    const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"];
    await copyLocalFiles(cfg.repoPath, wt, [...envFiles, ...(target.dir ? envFiles.map((f) => join(target.dir, f)) : []), ...(target.auto?.local ?? []).map((f) => join(target.dir, f))]);
    const out = await exec(target.auto ? target.auto.cmd : [target.pm, "run", `${DEPLOY_PREFIX}${target.name}`], dir, { timeoutMs: DEPLOY_TIMEOUT_MS });
    // El enlace que suelen imprimir (URL de la web, del servicio…): el último que aparezca.
    const url = out.match(/https:\/\/[^\s"'<>)\]]+/g)?.pop();
    // Versión de lo desplegado (runner 1.0.78, web la de la app); reglas, functions o una landing: ninguna.
    const vdir = versionDir(target, scopeOf(target).rank);
    const version = vdir === null ? undefined : await readVersion(readFrom(wt), vdir);
    return { ok: true, result: { url, sha: commit, ...(version ? { version } : {}), log: out.slice(-1400) } };
  } catch (err) {
    const error = String((err as Error).message);
    const hint = deployHint(error,target.auto?.deps?.length ? target.auto.deps.map((d) => d.dir) : [target.dir]);
    return { ok: false, result: { error: hint ? `${hint}\n${error.slice(-(3000 - hint.length - 1))}` : error.slice(-3000), sha: commit } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * Pista para un despliegue que falló por módulos que faltan: casi siempre es que las dependencias de esas carpetas no
 * se instalaron antes del predeploy. Vacía si la salida no va de eso.
 */
export function missingModulesHint(error: string, dirs: string[]): string {
  if (!MISSING_MODULES.test(error)) return "";
  const list = [...new Set(dirs.map((d) => d || "."))].join(", ");
  return t("deploy.missingModules", { dir: list });
}

/**
 * Pista para un despliegue de Firebase que falló porque el proyecto nunca activó Storage en la consola (firebase.json
 * declara `storage` pero el bucket no existe). Incluye el enlace a la consola si viene en el error. Vacía si no va de eso.
 */
export function storageNotSetUpHint(error: string): string {
  if (!/Firebase Storage has not been set up/i.test(error)) return "";
  const url = error.match(/https:\/\/console\.firebase\.google\.com\/project\/[^\s"'<>)\]]+?\/storage\b/)?.[0];
  const hint = t("deploy.storageNotSetUp");
  return url ? `${hint} ${url}` : hint;
}

/** Las pistas de un despliegue fallido (módulos que faltan, Storage sin activar), unidas; vacía si no aplica ninguna. */
export function deployHint(error: string, dirs: string[]): string {
  return [missingModulesHint(error, dirs), storageNotSetUpHint(error)].filter(Boolean).join("\n");
}

/** Variables `env` del perfil de build de eas.json del canal (las que lleva el bundle publicado). */
export function profileEnv(dir: string, channel: string): Record<string, string> {
  try {
    const eas = JSON.parse(readFileSync(join(dir, "eas.json"), "utf8")) as { build?: Record<string, { env?: Record<string, string>; channel?: string }> };
    const profiles = eas.build ?? {};
    const profile = profiles[channel] ?? Object.values(profiles).find((p) => p.channel === channel);
    return profile?.env ?? {};
  } catch {
    return {};
  }
}

/** Rutas (relativas a la app) de las claves de tienda del perfil de submit `production` de eas.json. */
function submitKeyPaths(dir: string): string[] {
  try {
    const eas = JSON.parse(readFileSync(join(dir, "eas.json"), "utf8")) as {
      submit?: Record<string, { ios?: { ascApiKeyPath?: unknown }; android?: { serviceAccountKeyPath?: unknown } }>;
    };
    const profile = eas.submit?.[BUILD_PROFILE];
    return [profile?.ios?.ascApiKeyPath, profile?.android?.serviceAccountKeyPath].filter(
      (f): f is string => typeof f === "string" && !isAbsolute(f) && !normalize(f).startsWith(".."),
    );
  } catch {
    return [];
  }
}

/** Primer objeto JSON de una salida que puede llevar avisos antes o después. */
function parseJson(out: string): unknown {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Dependencias con el gestor del repo (lockfile en la app o en la raíz del monorepo). */
export async function installFrozen(app: Pick<ExpoApp, "pm">, wt: string, dir: string): Promise<void> {
  const has = (f: string) => existsSync(join(dir, f)) || existsSync(join(wt, f));
  const frozen = { pnpm: ["pnpm", "install", "--frozen-lockfile"], yarn: ["yarn", "install", "--frozen-lockfile"], bun: ["bun", "install", "--frozen-lockfile"], npm: ["npm", "ci"] }[app.pm];
  // Donde está el lockfile: la carpeta del paquete o, en un monorepo (workspaces), la raíz.
  const lockfile = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: has("bun.lockb") ? "bun.lockb" : "bun.lock", npm: "package-lock.json" }[app.pm];
  const installDir = installDirFor(wt, dir, lockfile);
  await exec(installCommand(app.pm, frozen, installDir), installDir);
}

/**
 * Dónde instalar las dependencias de `dir` (dentro del worktree `wt`). En la propia carpeta si es un paquete
 * (`package.json`) que no forma parte de un workspace de la raíz, tenga o no lockfile: p. ej. unas functions de Firebase
 * sin package-lock.json en un repo cuya raíz tiene su propio package.json. En la raíz si la carpeta no es un paquete o si
 * es un monorepo de verdad: pnpm-workspace.yaml, o `workspaces` del package.json raíz que la incluyen (salvo que la
 * carpeta traiga su propio lockfile, como hasta ahora).
 */
export function installDirFor(wt: string, dir: string, lockfile = "package-lock.json"): string {
  if (resolve(dir) === resolve(wt) || !existsSync(join(dir, "package.json"))) return wt;
  if (existsSync(join(wt, "pnpm-workspace.yaml")) || existsSync(join(dir, "pnpm-workspace.yaml"))) return wt;
  if (existsSync(join(dir, lockfile))) return dir;
  return inRootWorkspaces(wt, relative(wt, dir)) ? wt : dir;
}

/** ¿La carpeta `rel` (relativa a la raíz) está en los `workspaces` del package.json raíz (array u objeto con `packages`)? */
function inRootWorkspaces(wt: string, rel: string): boolean {
  let ws: unknown;
  try {
    ws = (JSON.parse(readFileSync(join(wt, "package.json"), "utf8")) as { workspaces?: unknown }).workspaces;
  } catch {
    return false;
  }
  const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list)) return false;
  const path = rel.split(sep).join("/");
  return list.some((p) => typeof p === "string" && !p.startsWith("!") && workspaceGlob(p).test(path));
}

/** Patrón de workspace (`packages/*`, `apps/**`, `./functions`) como expresión regular sobre rutas con «/». */
function workspaceGlob(pattern: string): RegExp {
  const segs = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  const body = segs.map((seg) => (seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))).join("/");
  return new RegExp(`^${body}$`);
}

/**
 * `npm ci` solo funciona con package-lock.json (o npm-shrinkwrap.json): sin él falla siempre (p. ej. unas functions de
 * Firebase que no suben el lockfile). Ahí se instala con `npm install`, como haría cualquiera a mano.
 */
export function installCommand(pm: ExpoApp["pm"], frozen: string[], installDir: string): string[] {
  if (pm !== "npm" || existsSync(join(installDir, "package-lock.json")) || existsSync(join(installDir, "npm-shrinkwrap.json"))) return frozen;
  return ["npm", "install", "--no-audit", "--no-fund"];
}

/**
 * Quita la ayuda de uso que npm imprime tras un error de uso (p. ej. `npm ci` con el lockfile desfasado): son cientos de
 * líneas que, al recortar la salida, se comen el mensaje que explica el fallo.
 */
export function stripNpmUsage(out: string): string {
  return out.replace(/^npm (?:error|ERR!) Usage:\r?\n[\s\S]*?^npm (?:error|ERR!) Run "npm help [\w-]+" for more info\r?\n?/gm, "");
}

/**
 * Causa de un fallo de Gradle: el bloque «* What went wrong:» (hasta «* Try:» o similar). En `eas build --local` sale
 * mucho antes de la traza final de @expo/build-tools, así que al recortar la salida por el final se perdía. Las líneas
 * pueden llevar prefijo (p. ej. `[RUN_GRADLEW]`). Vacío si no hay ninguno.
 */
export function gradleFailure(out: string, max = 1200): string {
  const blocks: string[] = [];
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("* What went wrong:")) continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && block.length < 15; j++) {
      if (/\* (?:Try|Exception is|Get more help(?: at)?)\b:?|BUILD FAILED|What went wrong:/.test(lines[j])) break;
      if (lines[j].trim()) block.push(lines[j].trimEnd());
    }
    const text = block.join("\n");
    if (text && !blocks.includes(text)) blocks.push(text);
  }
  return blocks.join("\n").slice(0, max);
}

/** Últimas `max` letras de la salida de un comando fallido; si hay un error de Gradle que se perdería, va delante. */
export function failureOutput(out: string, max = 2800): string {
  const clean = stripNpmUsage(out);
  const tail = clean.slice(-max);
  const cause = gradleFailure(clean);
  if (!cause || tail.includes(cause)) return tail;
  const head = `${t("act.gradleCause")}\n${cause}\n…\n`;
  return head + clean.slice(-Math.max(0, max - head.length));
}

export const otaMissing = () => t("act.otaMissing");

/** Copia ficheros locales ignorados por git (p. ej. .env con el token del servidor de OTA) a la copia limpia. */
export async function copyLocalFiles(repo: string, wt: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const from = join(repo, p);
    if (!existsSync(from) || existsSync(join(wt, p))) continue;
    const ignored = await new Promise<boolean>((resolve) => spawn("git", ["check-ignore", "-q", p], { cwd: repo }).on("close", (code) => resolve(code === 0)));
    if (!ignored) continue;
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    copyFileSync(from, join(wt, p));
    chmodSync(join(wt, p), 0o600);
  }
}

/**
 * Como copyLocalFiles, pero deja un enlace simbólico al fichero real (las claves compartidas en ~/apps/.store-credentials):
 * las claves no se duplican y al borrar la copia limpia solo se va el enlace.
 */
async function linkLocalFiles(repo: string, wt: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const from = join(repo, p);
    if (!existsSync(from) || existsSync(join(wt, p))) continue;
    const ignored = await new Promise<boolean>((resolve) => spawn("git", ["check-ignore", "-q", p], { cwd: repo }).on("close", (code) => resolve(code === 0)));
    if (!ignored) continue;
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    symlinkSync(realpathSync(from), join(wt, p));
  }
}

/**
 * Si la última publicación que recuerda el script del repo salió de un commit que no está en lo que se publica ahora (p. ej.
 * se publicó a mano desde una rama sin mergear), publicar la rama base desharía esa versión: se explica en el error.
 */
async function publishedOffBase(cfg: RunnerConfig, appDir: string, commit: string): Promise<string> {
  const dir = join(appDir, ".expo");
  if (!existsSync(dir)) return "";
  const notes: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.startsWith("eoas-last-publish-"))) {
    const sha = readFileSync(join(dir, f), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(sha) && !(await isAncestor(cfg.repoPath, sha, commit).catch(() => true))) {
      notes.push(t("act.publishedOffBase", { channel: f.slice("eoas-last-publish-".length), sha: sha.slice(0, 7), base: `${cfg.remote}/${cfg.baseBranch}` }));
    }
  }
  return notes.length ? `\n\n${notes.join("\n")}` : "";
}

/**
 * ¿El script de publicación (el .sh al que llama `ota:publish`) contiene este texto? P. ej. BACKCODE_SMOKE_CLI (lanza él
 * mismo la prueba de arranque) o --allow-native (tiene guarda de cambios nativos que se puede saltar).
 */
function scriptMentions(appDir: string, script: string, text: string): boolean {
  const file = script.split(/\s+/).find((t) => /\.(sh|bash|mjs|js|ts)$/.test(t));
  if (!file) return false;
  const path = normalize(join(appDir, file));
  if (!path.startsWith(normalize(appDir))) return false;
  try {
    return readFileSync(path, "utf8").includes(text);
  } catch {
    return false;
  }
}

/** Archivos con cambios o nuevos (sin ignorar) en una copia: lo mismo que mira `git status` en los scripts de publicación. */
async function dirtyFiles(dir: string): Promise<string[]> {
  const out = await exec(["git", "status", "--porcelain"], dir).catch(() => "");
  return out.split("\n").filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean);
}

/**
 * «Commit y publicar»: commitea en la rama base los archivos sin commitear de la copia que se va a publicar y lo sube (sin
 * forzar: si la rama avanzó entretanto, falla). Nunca .env ni nada que parezca un secreto.
 */
async function commitAndPush(cfg: RunnerConfig, wt: string, files: string[], message: string, branch = cfg.baseBranch): Promise<{ sha: string } | { error: string }> {
  const risky = files.filter((f) => /(^|\/)\.env(\.|$)|\.(pem|p8|p12|key|keystore|jks)$|google-services|GoogleService-Info/i.test(f));
  if (risky.length) return { error: t("act.dirtyRisky", { files: risky.join(", ") }) };
  try {
    await exec(["git", "add", "--", ...files], wt);
    const secrets = await scanStagedForSecrets(wt);
    if (secrets.length) return { error: t("act.dirtyRisky", { files: secrets.join("; ") }) };
    await exec(["git", "-c", "user.name=Backcode", "-c", "user.email=backcode@users.noreply.github.com", "commit", "-m", t("act.dirtyCommit", { message: message.slice(0, 120), n: files.length })], wt);
    await withRemoteRetry(() => exec(["git", "push", cfg.remote, `HEAD:refs/heads/${branch}`], wt), { label: "git push" });
    return { sha: (await exec(["git", "rev-parse", "HEAD"], wt)).trim() };
  } catch (err) {
    return { error: t("act.dirtyPushFailed", { error: String((err as Error).message).slice(-800) }) };
  }
}

function copyLastPublish(fromAppDir: string, toAppDir: string): void {
  const from = join(fromAppDir, ".expo");
  if (!existsSync(from)) return;
  for (const f of readdirSync(from).filter((n) => n.startsWith("eoas-last-publish-"))) {
    mkdirSync(join(toAppDir, ".expo"), { recursive: true });
    copyFileSync(join(from, f), join(toAppDir, ".expo", f));
  }
}

/** Ejecuta un comando y devuelve su salida; falla con las últimas líneas si el código no es 0. */
/**
 * `doneWhen`: el comando no acaba solo (p. ej. `expo run:ios` en Debug se queda con su servidor de desarrollo abierto):
 * en cuanto su salida lo cumple, se da por terminado bien y se cierra (con sus hijos).
 */
export function exec([cmd, ...args]: string[], cwd: string, opts: { env?: Record<string, string>; timeoutMs?: number; doneWhen?: RegExp; settleWhen?: RegExp; settleMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...opts.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: !!opts.doneWhen });
    let out = "";
    let finished = false;
    const killGroup = () => {
      try {
        if (opts.doneWhen && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    // Tras `doneWhen`, si hay `settleWhen`, se espera a verlo (o a `settleMs`) antes de cerrar: p. ej. que la app ya haya
    // descargado su código del servidor de Expo, para no dejarla sin él («No script URL provided»).
    let settling: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(settling);
      killGroup();
      resolve(out);
    };
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-200_000);
      if (!opts.doneWhen || finished) return;
      const done = out.search(opts.doneWhen);
      if (done < 0) return;
      if (!opts.settleWhen || opts.settleWhen.test(out.slice(done))) return finish();
      settling ??= setTimeout(finish, opts.settleMs ?? 120_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(killGroup, opts.timeoutMs ?? OTA_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!finished) reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (finished) return;
      if (code === 0) resolve(out);
      else reject(new Error(t("act.execFailed", { cmd: `${cmd} ${args.slice(0, 2).join(" ")}`, code: String(code), out: failureOutput(out) })));
    });
  });
}

export function logLocalSync(cfg: RunnerConfig, r: { status: string; reason?: string; commits?: number }): void {
  if (r.status === "updated") console.log(`[backcode] ${t("act.localUpdated", { base: cfg.baseBranch, n: r.commits ?? 0 })}`);
  else if (r.status === "skipped") console.warn(`\x1b[33m⚠ ${t("act.localSkipped", { base: cfg.baseBranch, remote: cfg.remote, reason: r.reason ?? "" })}\x1b[0m`);
}

const LOCKFILES: Record<string, string[]> = {
  "pnpm-lock.yaml": ["pnpm", "install", "--frozen-lockfile"],
  "yarn.lock": ["yarn", "install", "--frozen-lockfile"],
  "bun.lock": ["bun", "install", "--frozen-lockfile"],
  "bun.lockb": ["bun", "install", "--frozen-lockfile"],
  "package-lock.json": ["npm", "install"],
};

/**
 * Tras poner al día tu copia: si cambiaron dependencias (package.json o lockfile), instala con el gestor del repo en
 * cada carpeta con lockfile afectada (en un monorepo, la raíz). Es lo mismo que harías tú tras un git pull.
 */
export async function installIfNeeded(repoPath: string, changed: string[]): Promise<void> {
  const deps = changed.filter((f) => /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json|pnpm-workspace\.yaml)$/.test(f));
  if (!deps.length) return;
  const dirs = new Set<string>();
  for (const f of deps) {
    // Sube desde la carpeta del fichero hasta encontrar un lockfile (la raíz en un monorepo).
    let dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    for (;;) {
      if (Object.keys(LOCKFILES).some((l) => existsSync(join(repoPath, dir, l)))) {
        dirs.add(dir);
        break;
      }
      if (!dir) break;
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  }
  for (const dir of dirs) {
    const lock = Object.keys(LOCKFILES).find((l) => existsSync(join(repoPath, dir, l)))!;
    const cmd = LOCKFILES[lock];
    console.log(`[backcode] ${t("act.depsChanged", { cmd: cmd.join(" "), dir: dir || t("act.root") })}`);
    await exec(cmd, join(repoPath, dir)).then(
      () => console.log(`[backcode] ${t("act.depsOk")}`),
      (e: Error) => console.warn(`\x1b[33m⚠ ${t("act.depsFail", { error: e.message.split("\n")[0], dir: dir || t("act.root") })}\x1b[0m`),
    );
  }
}
