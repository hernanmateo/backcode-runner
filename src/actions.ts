import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { type RunnerConfig } from "./config.js";
import { smokeCliPath } from "./paths.js";
import { createDetachedWorktree, DEPLOY_PREFIX, git as gitIn, type ExpoApp, findDeployTargets, findExpoApp, isAncestor, remoteHead, removeWorktree, scanStagedForSecrets, syncLocalBase } from "./git.js";
import type { Checks, PrHost } from "./hosts.js";
import { t } from "./i18n.js";
import { adbPath, androidSdk, listDevices, prepareIosDevice, type DevicePlatform } from "./devices.js";
import { adbReverse, devPort, devServe, devServerRunning, devStop, recordDevInstall, stopDevServer } from "./dev-server.js";
import { appConfig, buildErrors, prepareNativeProject, smokeTest } from "./smoke.js";
import { otaScriptArgs } from "./ota.js";
import { type DeployedTask, includedTasks, MAX_DEPLOYED_TASKS } from "./deploy-tasks.js";
import type { Store } from "./store.js";

// Acciones que pide un admin desde la app y ejecuta su runner con sus credenciales (gh / Bitbucket / EAS):
// mergear el PR de una tarea, publicar un OTA de Expo (EAS Update o el script `ota:publish` del repo, p. ej. xprem) o
// hacer una build local con EAS y enviarla a testers (TestFlight / Internal Testing). Los comandos son fijos: nunca los
// decide Claude.

export interface Action {
  type: "merge" | "ota" | "openPr" | "build" | "deploy" | "install" | "devServe" | "devStop" | "deployAll" | "closePr" | "mergePr" | "knowledge";
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
  /** OTA «Publicar sin comprobaciones»: sin prueba de arranque (ni la del runner ni la del script) y con --allow-native si el script lo admite. */
  skipSmoke?: boolean;
}
export interface StepResult {
  id: string;
  ok: boolean;
  sha?: string;
  url?: string;
  error?: string;
}
export interface ActionResult {
  /** «Desplegarlo todo»: cómo fue cada paso (los que no llegaron a ejecutarse no aparecen). */
  steps?: StepResult[];
  url?: string;
  sha?: string;
  error?: string;
  /** Checks que no están en verde (si se rechaza por eso). */
  checks?: string[];
  log?: string;
  /** OTA: archivos sin commitear que impidieron publicar (la app ofrece «Commit y publicar»). */
  dirty?: string[];
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

/** Solo se continúa con todo en verde (o sin checks configurados). */
function requireGreen(checks: Checks, what: string): ActionResult | null {
  if (checks.state === "green" || checks.state === "none") return null;
  return { error: t("act.notGreen", { what, state: t(checks.state === "pending" ? "act.checksPending" : "act.checksFailing") }), checks: checks.pending };
}

export async function runAction(cfg: RunnerConfig, store: Store, host: PrHost | undefined, action: Action): Promise<{ ok: boolean; result: ActionResult }> {
  if (action.type === "merge") return merge(cfg, store, host, action.featureId ?? "");
  if (action.type === "openPr") return openPr(cfg, store, host, action.featureId ?? "");
  // OTA, build y despliegue publican la rama base del remoto (no tu copia local): después, tu copia se pone al día
  // para que lo que ves en local sea lo que se acaba de publicar (p. ej. un merge que hizo otro y aún no tenías).
  if (action.type === "install") return installOnDevice(cfg, store, action);
  // Versión de desarrollo: Metro con la rama principal o con una tarea (featureId).
  if (action.type === "devServe") return devServe(cfg, store, action.featureId);
  if (action.type === "devStop") return devStop(cfg, store);
  if (action.type === "closePr") return closePr(cfg, store, host, action);
  if (action.type === "mergePr") {
    const done = await mergeExternal(host, action.prUrl ?? "");
    if (done.ok) await syncLocal(cfg);
    return done;
  }
  if (action.type === "deployAll") {
    const done = await deployAll(cfg, store, host, action.steps ?? [], action.message ?? "");
    await syncLocal(cfg);
    return done;
  }
  const done =
    action.type === "build"
      ? await withTasks(cfg, store, "build", await publishBuild(cfg, host, action))
      : action.type === "deploy"
        ? await withTasks(cfg, store, `deploy:${action.target ?? ""}`, await runDeploy(cfg, host, action.target ?? ""))
        : await publishOta(cfg, store, host, action.channel ?? "preview", action.message ?? "OTA", action.commit, action.commitDirty === true && !action.commit, action.skipSmoke === true);
  await syncLocal(cfg);
  return done;
}

/**
 * Añade al resultado de un build o despliegue hecho bien las tareas que entraron en él: las mergeadas que van en su
 * commit y no iban en el anterior del mismo destino (`key`, como en lastDeploys). Si falla, el resultado queda igual.
 */
async function withTasks(cfg: RunnerConfig, store: Store, key: string, done: { ok: boolean; result: ActionResult }): Promise<{ ok: boolean; result: ActionResult }> {
  const sha = done.result.sha;
  if (!done.ok || !sha) return done;
  try {
    const previous = (await store.lastDeploys()).get(key);
    const features = await includedTasks(await store.mergedFeatures(), sha, previous, (a, c) => isAncestor(cfg.repoPath, a, c));
    return { ...done, result: { ...done.result, features } };
  } catch {
    return done;
  }
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
  const url = await host.openOrUpdatePr({ cwd: cfg.repoPath, branch: f.branch, base: cfg.baseBranch, title: f.title, body });
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
  await host.close(pr.url, action.deleteBranch === true);
  return { ok: true, result: { url: pr.url } };
}

/** Mergear un PR externo: como el de una tarea (checks en verde, squash y borrar la rama). */
async function mergeExternal(host: PrHost | undefined, prUrl: string) {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  const pr = await openExternal(host, prUrl);
  if (!pr) return { ok: false, result: { error: t("act.prNotOpen") } };
  const blocked = requireGreen(await host.prChecks(pr.url), "PR");
  if (blocked) return { ok: false, result: blocked };
  const { sha } = await host.merge(pr.url);
  return { ok: true, result: { url: pr.url, sha } };
}

async function merge(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string) {
  if (!host) return { ok: false, result: { error: t("act.noHostMerge") } };
  const prUrl = await store.prUrlOf(featureId);
  if (!prUrl?.startsWith("https://")) return { ok: false, result: { error: t("act.noPr") } };
  // Antes, el estado real del PR: puede haberse mergeado o cerrado a mano en GitHub/Bitbucket.
  const pr = await host.prState(prUrl).catch(() => null);
  if (pr?.state === "merged") {
    await store.markMerged(featureId, pr.sha);
    return { ok: true, result: { url: prUrl, sha: pr.sha } };
  }
  if (pr?.state === "closed") {
    return { ok: false, result: { error: t("act.prClosed", { host: host.kind === "github" ? "GitHub" : "Bitbucket" }), url: prUrl } };
  }
  const blocked = requireGreen(await host.prChecks(prUrl), "PR");
  if (blocked) return { ok: false, result: blocked };
  const { sha } = await host.merge(prUrl);
  await store.markMerged(featureId, sha);
  // Tu copia local se pone al día para que veas el cambio (solo si es seguro: ver syncLocalBase).
  await syncLocal(cfg);
  // La rama ya no existe: la copia de trabajo de la tarea sobra.
  await removeWorktree(cfg.repoPath, join(cfg.worktreesDir, featureId)).catch(() => undefined);
  return { ok: true, result: { url: prUrl, sha } };
}

async function publishOta(cfg: RunnerConfig, store: Store, host: PrHost | undefined, channel: "preview" | "production", message: string, rollbackTo?: string, commitDirty = false, skipSmoke = false) {
  const head = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  // Rollback: solo commits que ya están en la rama base (revisados); no se puede publicar cualquier commit.
  if (rollbackTo && !(await isAncestor(cfg.repoPath, rollbackTo, head))) {
    return { ok: false, result: { error: t("act.notInBase", { sha: rollbackTo.slice(0, 7), base: `${cfg.remote}/${cfg.baseBranch}` }) } };
  }
  let commit = rollbackTo ?? head;
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: t("act.notExpo") } };
  if (!app.ota) return { ok: false, result: { error: otaMissing() } };
  if (!app.channels.includes(channel)) return { ok: false, result: { error: t("act.noChannel", { channel }) } };
  // En un rollback no se esperan los checks: esa versión ya se publicó antes y hay prisa por deshacer.
  if (host && !rollbackTo) {
    const blocked = requireGreen(await host.commitChecks(commit), `${cfg.baseBranch} (${commit.slice(0, 7)})`);
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
      const pushed = await commitAndPush(cfg, wt, dirty, message);
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
    // Las tareas cuyo merge va en este commit quedan "desplegadas" en el canal (no en un rollback) y constan en el OTA.
    const features: DeployedTask[] = [];
    for (const f of rollbackTo ? [] : await store.mergedNotDeployed(channel).catch(() => [])) {
      if (!(await isAncestor(cfg.repoPath, f.sha, commit))) continue;
      await store.markDeployed(f.id, channel, commit).catch(() => undefined);
      if (features.length < MAX_DEPLOYED_TASKS) features.push({ id: f.id, title: f.title.slice(0, 120) });
    }
    return { ok: true, result: { url, sha: commit, features, log: `${smoke ? `${smoke.detail}\n` : skipSmoke ? `${t("smoke.skipped")}\n` : ""}${out.slice(-1400)}` } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(-3000), sha: commit } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
    // Por si git no pudo quitarla: la copia lleva los .env copiados.
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * Build LOCAL con EAS (`eas build --local`, en este ordenador) y envío a testers con `eas submit`: iOS va a TestFlight
 * y Android al track `internal` de Google Play (Internal Testing). Usa el perfil `production` de eas.json y la sesión
 * de EAS de quien lo pide (credenciales gestionadas por EAS); no se toca `ios/` ni `android/`.
 * La versión y la runtimeVersion llegan como APP_VERSION y RUNTIME_VERSION: la configuración de la app (app.config.js)
 * tiene que leerlas. Antes de compilar se comprueba con `expo config` que de verdad se aplican.
 */
async function publishBuild(cfg: RunnerConfig, host: PrHost | undefined, action: Action) {
  const platforms = (["ios", "android"] as const).filter((p) => action.platforms?.includes(p));
  const version = action.version ?? "";
  const runtimeVersion = action.runtimeVersion ?? "";
  if (!platforms.length) return { ok: false, result: { error: t("build.noPlatform") } };
  if (!VERSION_RE.test(version)) return { ok: false, result: { error: t("build.badVersion", { v: version }) } };
  if (!RUNTIME_VERSION_RE.test(runtimeVersion)) return { ok: false, result: { error: t("build.badRuntime", { v: runtimeVersion }) } };
  if (platforms.includes("ios") && process.platform !== "darwin") return { ok: false, result: { error: t("build.needMac") } };

  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: t("build.notExpo") } };
  if (!app.buildProfiles.includes(BUILD_PROFILE)) return { ok: false, result: { error: t("build.noProfile", { p: BUILD_PROFILE }) } };
  if (host) {
    const blocked = requireGreen(await host.commitChecks(commit), `${cfg.baseBranch} (${commit.slice(0, 7)})`);
    if (blocked) return { ok: false, result: blocked };
  }

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
        return { ok: false, result: { url, sha: commit, error: `${before}${platform}: ${String((err as Error).message)}`.slice(-3000) } };
      }
    }
    return { ok: true, result: { url, sha: commit, log: `${done.join(" + ")} · ${version} (runtime ${runtimeVersion})\n${log.slice(-1400)}` } };
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
 * publicar la app nueva si sus reglas o sus functions no han salido.
 */
async function deployAll(cfg: RunnerConfig, store: Store, host: PrHost | undefined, requested: string[], message: string): Promise<{ ok: boolean; result: ActionResult }> {
  const wanted = [...new Set(requested)].filter((s) => STEP_RE.test(s)).slice(0, 10);
  if (!wanted.length) return { ok: false, result: { error: t("plan.noSteps") } };
  const order = (store.plan?.steps ?? []).map((s) => s.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : 100 + (id.startsWith("ota:") ? 1 : 0));
  const steps = wanted.sort((a, b) => rank(a) - rank(b));
  const results: StepResult[] = [];
  const log: string[] = [];
  const features: DeployedTask[] = [];
  for (const [i, id] of steps.entries()) {
    const label = `${i + 1}. ${id.replace(/^deploy:[^#]*#/, "").replace(/^ota:/, "OTA ")}`;
    console.log(`[action] deployAll ${label}`);
    const done = id.startsWith("ota:")
      ? await publishOta(cfg, store, host, id.slice(4) as "production" | "preview", message || "Backcode")
      : await withTasks(cfg, store, id, await runDeploy(cfg, host, id.slice("deploy:".length)));
    const { ok, result } = await Promise.resolve(done).catch((err: Error) => ({ ok: false, result: { error: err.message } as ActionResult }));
    for (const f of result.features ?? []) if (features.length < MAX_DEPLOYED_TASKS && !features.some((g) => g.id === f.id)) features.push(f);
    results.push({ id, ok, ...(result.sha ? { sha: result.sha } : {}), ...(result.url ? { url: result.url } : {}), ...(ok ? {} : { error: String(result.error ?? "").slice(-1500) }) });
    log.push(`${ok ? "✓" : "✗"} ${label}${result.url ? ` · ${result.url}` : ""}`);
    if (!ok) {
      const skipped = steps.slice(i + 1).map((s, j) => `${i + j + 2}. ${s.replace(/^deploy:[^#]*#/, "").replace(/^ota:/, "OTA ")}`);
      return { ok: false, result: { steps: results, ...(features.length ? { features } : {}), error: t("plan.stepFailed", { step: label, skipped: skipped.join(", ") || "—", error: String(result.error ?? "").slice(-2000) }), log: log.join("\n") } };
    }
  }
  return { ok: true, result: { steps: results, sha: results.at(-1)?.sha, features, log: log.join("\n") } };
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
  }
}

/** La copia de «Instalar en mi móvil» (_install): se crea una vez y después solo se mueve al commit pedido. */
async function installWorktree(cfg: RunnerConfig, commit: string): Promise<string> {
  const path = join(cfg.worktreesDir, "_install");
  if (!existsSync(join(path, ".git"))) return createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_install", commit);
  try {
    await gitIn(path, ["checkout", "--detach", "--force", "--quiet", commit]);
    // Fuera lo que no es del repo, salvo lo que se quiere conservar (las carpetas ignoradas, como node_modules, ya se quedan).
    await gitIn(path, ["clean", "-fdq", "-e", "ios", "-e", "android", "-e", ".expo"]);
    return path;
  } catch {
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
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const target = (await findDeployTargets(cfg.repoPath, commit)).find((d) => d.id === targetId);
  if (!target) return { ok: false, result: { error: t("deploy.unknown", { target: targetId }) } };
  if (host) {
    const blocked = requireGreen(await host.commitChecks(commit), `${cfg.baseBranch} (${commit.slice(0, 7)})`);
    if (blocked) return { ok: false, result: blocked };
  }
  const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_deploy", commit);
  const dir = join(wt, target.dir);
  try {
    // Script de package.json: sus dependencias. Detectado: solo si esa carpeta es un paquete (p. ej. un Worker que importa
    // librerías). De backcode.toml: nunca (es para repos sin Node).
    if (!target.auto || (target.auto.install && existsSync(join(dir, "package.json")))) await installFrozen(target, wt, dir);
    const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"];
    await copyLocalFiles(cfg.repoPath, wt, [...envFiles, ...(target.dir ? envFiles.map((f) => join(target.dir, f)) : []), ...(target.auto?.local ?? []).map((f) => join(target.dir, f))]);
    const out = await exec(target.auto ? target.auto.cmd : [target.pm, "run", `${DEPLOY_PREFIX}${target.name}`], dir, { timeoutMs: DEPLOY_TIMEOUT_MS });
    // El enlace que suelen imprimir (URL de la web, del servicio…): el último que aparezca.
    const url = out.match(/https:\/\/[^\s"'<>)\]]+/g)?.pop();
    return { ok: true, result: { url, sha: commit, log: out.slice(-1400) } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(-3000), sha: commit } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
    rmSync(wt, { recursive: true, force: true });
  }
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
  const lockfile = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: existsSync(join(dir, "bun.lockb")) || existsSync(join(wt, "bun.lockb")) ? "bun.lockb" : "bun.lock", npm: "package-lock.json" }[app.pm];
  const installDir = existsSync(join(dir, "package.json")) && existsSync(join(dir, lockfile)) && !has("pnpm-workspace.yaml") ? dir : wt;
  await exec(frozen, installDir);
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
async function commitAndPush(cfg: RunnerConfig, wt: string, files: string[], message: string): Promise<{ sha: string } | { error: string }> {
  const risky = files.filter((f) => /(^|\/)\.env(\.|$)|\.(pem|p8|p12|key|keystore|jks)$|google-services|GoogleService-Info/i.test(f));
  if (risky.length) return { error: t("act.dirtyRisky", { files: risky.join(", ") }) };
  try {
    await exec(["git", "add", "--", ...files], wt);
    const secrets = await scanStagedForSecrets(wt);
    if (secrets.length) return { error: t("act.dirtyRisky", { files: secrets.join("; ") }) };
    await exec(["git", "-c", "user.name=Backcode", "-c", "user.email=backcode@users.noreply.github.com", "commit", "-m", t("act.dirtyCommit", { message: message.slice(0, 120), n: files.length })], wt);
    await exec(["git", "push", cfg.remote, `HEAD:refs/heads/${cfg.baseBranch}`], wt);
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
      else reject(new Error(t("act.execFailed", { cmd: `${cmd} ${args.slice(0, 2).join(" ")}`, code: String(code), out: out.slice(-2800) })));
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
