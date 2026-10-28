import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { type RunnerConfig } from "./config.js";
import { smokeCliPath } from "./paths.js";
import { createDetachedWorktree, DEPLOY_PREFIX, type ExpoApp, findDeployTargets, findExpoApp, isAncestor, remoteHead, removeWorktree, scanStagedForSecrets, syncLocalBase } from "./git.js";
import type { Checks, PrHost } from "./hosts.js";
import { t } from "./i18n.js";
import { smokeTest } from "./smoke.js";
import { otaScriptArgs } from "./ota.js";
import type { Store } from "./store.js";

// Acciones que pide un admin desde la app y ejecuta su runner con sus credenciales (gh / Bitbucket / EAS):
// mergear el PR de una tarea, publicar un OTA de Expo (EAS Update o el script `ota:publish` del repo, p. ej. xprem) o
// hacer una build local con EAS y enviarla a testers (TestFlight / Internal Testing). Los comandos son fijos: nunca los
// decide Claude.

export interface Action {
  type: "merge" | "ota" | "openPr" | "build" | "deploy";
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
}
export interface ActionResult {
  url?: string;
  sha?: string;
  error?: string;
  /** Checks que no están en verde (si se rechaza por eso). */
  checks?: string[];
  log?: string;
  /** OTA: archivos sin commitear que impidieron publicar (la app ofrece «Commit y publicar»). */
  dirty?: string[];
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
  const done =
    action.type === "build"
      ? await publishBuild(cfg, host, action)
      : action.type === "deploy"
        ? await runDeploy(cfg, host, action.target ?? "")
        : await publishOta(cfg, store, host, action.channel ?? "preview", action.message ?? "OTA", action.commit, action.commitDirty === true && !action.commit);
  await syncLocal(cfg);
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
  const url = await host.openOrUpdatePr({ cwd: cfg.repoPath, branch: f.branch, base: cfg.baseBranch, title: f.title, body });
  await store.setPrUrl(featureId, url);
  return { ok: true, result: { url } };
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

async function publishOta(cfg: RunnerConfig, store: Store, host: PrHost | undefined, channel: "preview" | "production", message: string, rollbackTo?: string, commitDirty = false) {
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

  const scriptArgs = app.ota === "script" ? otaScriptArgs(app.otaScript ?? "", app.pm, channel, message) : null;
  if (scriptArgs && "error" in scriptArgs) return { ok: false, result: { error: t("act.otaFixedBranch", { fixed: scriptArgs.fixed, channel }) } };

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
    const scriptSmokes = !!scriptArgs && scriptRunsSmoke(dir, app.otaScript ?? "");
    const smoke = scriptSmokes ? null : await smokeTest(dir, profileEnv(dir, channel), cfg.worktreesDir, repoAppDir);
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
    // Las tareas cuyo merge va en este commit quedan "desplegadas" en el canal (no en un rollback).
    for (const f of rollbackTo ? [] : await store.mergedNotDeployed(channel).catch(() => [])) {
      if (await isAncestor(cfg.repoPath, f.sha, commit)) await store.markDeployed(f.id, channel, commit).catch(() => undefined);
    }
    return { ok: true, result: { url, sha: commit, log: `${smoke ? `${smoke.detail}\n` : ""}${out.slice(-1400)}` } };
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
    await installFrozen(target, wt, dir);
    const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"];
    await copyLocalFiles(cfg.repoPath, wt, [...envFiles, ...(target.dir ? envFiles.map((f) => join(target.dir, f)) : [])]);
    const out = await exec([target.pm, "run", `${DEPLOY_PREFIX}${target.name}`], dir, { timeoutMs: DEPLOY_TIMEOUT_MS });
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
function profileEnv(dir: string, channel: string): Record<string, string> {
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
async function installFrozen(app: Pick<ExpoApp, "pm">, wt: string, dir: string): Promise<void> {
  const has = (f: string) => existsSync(join(dir, f)) || existsSync(join(wt, f));
  const frozen = { pnpm: ["pnpm", "install", "--frozen-lockfile"], yarn: ["yarn", "install", "--frozen-lockfile"], bun: ["bun", "install", "--frozen-lockfile"], npm: ["npm", "ci"] }[app.pm];
  // Donde está el lockfile: la carpeta del paquete o, en un monorepo (workspaces), la raíz.
  const lockfile = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: existsSync(join(dir, "bun.lockb")) || existsSync(join(wt, "bun.lockb")) ? "bun.lockb" : "bun.lock", npm: "package-lock.json" }[app.pm];
  const installDir = existsSync(join(dir, "package.json")) && existsSync(join(dir, lockfile)) && !has("pnpm-workspace.yaml") ? dir : wt;
  await exec(frozen, installDir);
}

export const otaMissing = () => t("act.otaMissing");

/** Copia ficheros locales ignorados por git (p. ej. .env con el token del servidor de OTA) a la copia limpia. */
async function copyLocalFiles(repo: string, wt: string, paths: string[]): Promise<void> {
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

/** ¿El script de publicación (el .sh al que llama `ota:publish`) lanza él mismo la prueba de arranque con BACKCODE_SMOKE_CLI? */
function scriptRunsSmoke(appDir: string, script: string): boolean {
  const file = script.split(/\s+/).find((t) => /\.(sh|bash|mjs|js|ts)$/.test(t));
  if (!file) return false;
  const path = normalize(join(appDir, file));
  if (!path.startsWith(normalize(appDir))) return false;
  try {
    return readFileSync(path, "utf8").includes("BACKCODE_SMOKE_CLI");
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
function exec([cmd, ...args]: string[], cwd: string, opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...opts.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-200_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? OTA_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
