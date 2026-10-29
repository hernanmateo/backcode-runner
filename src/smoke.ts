import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "./i18n.js";

/**
 * Prueba de arranque antes de publicar un OTA. Un OTA que cierra la app al arrancar no tiene arreglo por OTA: el móvil se
 * cierra antes de descargar el siguiente (y la recuperación de expo-updates no cubre cierres nativos). Por eso, sin esta
 * prueba superada, no se publica.
 *
 * Se compila la app en Release, con el JavaScript incrustado como en la tienda (`expo run:ios --configuration Release`),
 * desde la misma copia limpia que se va a publicar; se instala en un simulador propio («Backcode OTA test», no toca los
 * de quien publica), se abre y se comprueba que sigue viva unos segundos. Sin Metro ni enlaces: lo mismo que verá un móvil.
 * Requisito: Xcode (solo en Mac). La primera vez tarda (compilación nativa); después la caché de Xcode la acelera.
 */
export interface SmokeResult {
  ok: boolean;
  /** Qué ha pasado (para el log de la publicación o el error). */
  detail: string;
  /** Captura del simulador al final de la prueba. */
  screenshot?: string;
}

const SIMULATOR = "Backcode OTA test";
const BUILD_MS = 45 * 60_000;
const PREBUILD_MS = 10 * 60_000;
const PODS_MS = 20 * 60_000;
/** Tras abrirla, cuánto tiene que seguir viva la app (los cierres al arrancar pasan en los primeros segundos). */
const ALIVE_MS = 15_000;

export async function smokeTest(appDir: string, env: Record<string, string>, screenshotDir: string, sourceAppDir?: string): Promise<SmokeResult> {
  if (process.platform !== "darwin") return { ok: false, detail: t("smoke.needMac") };
  const config = await appConfig(appDir, env);
  const bundleId = config?.ios?.bundleIdentifier;
  if (!bundleId) return { ok: false, detail: t("smoke.noBundleId") };
  // Ficheros de Firebase que pide la config y no están en git (p. ej. GoogleService-Info.plist): de la copia de quien
  // publica, como los .env. Sin ellos la build nativa no se puede generar.
  if (sourceAppDir) {
    for (const file of [config?.ios?.googleServicesFile, config?.android?.googleServicesFile]) {
      if (file && !existsSync(join(appDir, file)) && existsSync(join(sourceAppDir, file))) {
        mkdirSync(dirname(join(appDir, file)), { recursive: true });
        copyFileSync(join(sourceAppDir, file), join(appDir, file));
      }
    }
  }
  let udid: string;
  try {
    udid = await testSimulator();
  } catch (err) {
    return { ok: false, detail: t("smoke.noSimulator", { error: (err as Error).message.slice(0, 300) }) };
  }

  // Genera el proyecto nativo, instala los pods y compila en Release; instala en el simulador de pruebas y abre la app
  // (sin Metro: JS incrustado). Generar el proyecto toca ficheros del repo (p. ej. los scripts ios/android de
  // package.json): se deshacen al acabar, para que lo que se publica sea exactamente el commit (y el script del repo no
  // lo vea «sucio»).
  const touchedBefore = await changedTracked(appDir);
  const untrackedBefore = await untracked(appDir);
  let failed: SmokeResult | undefined;
  try {
    failed = await prepareNativeProject(appDir, env);
    if (!failed) {
      const build = await runLong(["npx", "expo", "run:ios", "--configuration", "Release", "--device", udid, "--no-bundler", "--no-install"], appDir, { ...env, CI: "1" }, BUILD_MS);
      if (!build.ok) failed = { ok: false, detail: t("smoke.build", { log: buildErrors(build.out, keepXcodeLog(appDir, screenshotDir)) }) };
    }
  } finally {
    await restoreTracked(appDir, touchedBefore);
    await removeNewUntracked(appDir, untrackedBefore);
  }
  if (failed) return failed;

  // Por si run:ios no llegó a abrirla.
  if (!(await isRunning(udid, bundleId))) await run("xcrun", ["simctl", "launch", udid, bundleId]).catch(() => undefined);
  await sleep(ALIVE_MS);
  const screenshot = join(screenshotDir, `smoke-${Date.now()}.png`);
  await run("xcrun", ["simctl", "io", udid, "screenshot", screenshot]).catch(() => undefined);
  const alive = await isRunning(udid, bundleId);
  await run("xcrun", ["simctl", "terminate", udid, bundleId]).catch(() => undefined);
  if (!alive) return { ok: false, detail: t("smoke.crashed"), screenshot };
  return { ok: true, detail: t("smoke.ok", { seconds: ALIVE_MS / 1000 }), screenshot };
}

/**
 * Proyecto iOS listo para compilar: `ios/` generado (si no existe) y CocoaPods instalado y en sync. Se hace a mano, paso
 * a paso, en vez de dejar que `expo run:ios` lo haga por dentro: ahí `pod install` corre en silencio y, si falla (red,
 * `pod` que no está en el PATH del runner, locale sin UTF-8, una versión que no resuelve…), el CLI solo avisa y sigue
 * con xcodebuild, que muere con «The sandbox is not in sync with the Podfile.lock» y el código 65, sin el motivo real.
 * Devuelve el fallo (con su causa) o undefined si todo está listo.
 */
export async function prepareNativeProject(appDir: string, env: Record<string, string>): Promise<SmokeResult | undefined> {
  const iosDir = join(appDir, "ios");
  // Copia limpia (el runner) o repo que ignora ios/: se genera desde la config de Expo. Si ya existe (p. ej. el script
  // lanzado a mano en un repo con ios/ versionado), se respeta tal cual, como hace run:ios.
  if (!existsSync(join(iosDir, "Podfile"))) {
    const prebuild = await runLong(["npx", "expo", "prebuild", "--platform", "ios", "--no-install"], appDir, { ...env, CI: "1" }, PREBUILD_MS);
    if (!prebuild.ok) return { ok: false, detail: t("smoke.prebuild", { log: buildErrors(prebuild.out) }) };
    if (!existsSync(join(iosDir, "Podfile"))) return { ok: false, detail: t("smoke.prebuild", { log: buildErrors(prebuild.out) }) };
  }
  if (podsInSync(iosDir)) return undefined;
  // CocoaPods exige un locale UTF-8 (como servicio, el runner puede no traer LANG). Sin terminal: nada de colores ni spinners.
  const podEnv = { ...env, CI: "1", LANG: /utf-?8/i.test(process.env.LANG ?? "") ? (process.env.LANG as string) : "en_US.UTF-8", COCOAPODS_DISABLE_STATS: "1" };
  const pods = await runLong(["pod", "install"], iosDir, podEnv, PODS_MS);
  if (!pods.ok) {
    if (/ENOENT|spawn pod/.test(pods.out) && !pods.out.includes("Analyzing dependencies")) return { ok: false, detail: t("smoke.noPod") };
    return { ok: false, detail: t("smoke.pods", { log: buildErrors(pods.out) }) };
  }
  if (!podsInSync(iosDir)) return { ok: false, detail: t("smoke.podsOutOfSync") };
  return undefined;
}

/** Lo que comprueba la fase «[CP] Check Pods Manifest.lock» de Xcode: Podfile.lock y Pods/Manifest.lock iguales. */
export function podsInSync(iosDir: string): boolean {
  const lock = join(iosDir, "Podfile.lock");
  const manifest = join(iosDir, "Pods", "Manifest.lock");
  if (!existsSync(lock) || !existsSync(manifest)) return false;
  try {
    return readFileSync(lock, "utf8") === readFileSync(manifest, "utf8");
  } catch {
    return false;
  }
}

/**
 * Las líneas que explican un fallo (errores de xcodebuild, de CocoaPods y del CLI de Expo) y el final de la salida. Solo
 * el final no vale: el motivo real suele estar cientos de líneas antes del «exited with error code 65».
 */
export function buildErrors(out: string, logPath?: string): string {
  const lines = out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trimEnd());
  const relevant = lines.filter((l) => /(^|\s)(error|fatal error):|❌|\[!\]|Something went wrong|CommandError|Could not find|could not find|No such file|Unable to/.test(l));
  const unique = [...new Set(relevant.map((l) => l.trim()))].slice(0, 12);
  const end = lines.filter(Boolean).slice(-8);
  const text = [...(unique.length ? [...unique, "…"] : []), ...end].join("\n").slice(-2500);
  return logPath ? `${text}\n${t("smoke.buildLog", { path: logPath })}` : text;
}

/**
 * El log completo de xcodebuild (`.expo/xcodebuild.log`) se va con la copia limpia al acabar: se guarda una copia donde
 * quedan las capturas, para poder mirar el motivo con calma. Devuelve la ruta o undefined si no hay log.
 */
function keepXcodeLog(appDir: string, dir: string): string | undefined {
  const log = join(appDir, ".expo", "xcodebuild.log");
  if (!existsSync(log)) return undefined;
  const copy = join(dir, `smoke-xcodebuild-${Date.now()}.log`);
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(log, copy);
    return copy;
  } catch {
    return undefined;
  }
}

/** Ficheros versionados con cambios en la copia (los que ya lo estaban antes no se tocan). */
async function changedTracked(dir: string): Promise<Set<string>> {
  const out = await run("git", ["status", "--porcelain", "--untracked-files=no"], dir).catch(() => "");
  return new Set(out.split("\n").filter(Boolean).map((l) => l.slice(3)));
}

/** Archivos y carpetas nuevos sin ignorar (rutas relativas a la raíz del repo, como las da git status). */
async function untracked(dir: string): Promise<Set<string>> {
  const out = await run("git", ["status", "--porcelain", "--untracked-files=normal"], dir).catch(() => "");
  return new Set(out.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)));
}

/** Borra lo que la build haya creado sin estar ignorado (p. ej. ios/ en un repo que no lo ignora). */
async function removeNewUntracked(dir: string, before: Set<string>): Promise<void> {
  const root = (await run("git", ["rev-parse", "--show-toplevel"], dir).catch(() => "")).trim();
  if (!root) return;
  for (const p of await untracked(dir)) if (!before.has(p)) rmSync(join(root, p), { recursive: true, force: true });
}

/** Deshace lo que la build haya cambiado en ficheros versionados del repo. */
async function restoreTracked(dir: string, before: Set<string>): Promise<void> {
  const root = (await run("git", ["rev-parse", "--show-toplevel"], dir).catch(() => "")).trim();
  if (!root) return;
  const changed = [...(await changedTracked(dir))].filter((f) => !before.has(f));
  if (changed.length) await run("git", ["checkout", "--", ...changed], root).catch(() => undefined);
}

/** El simulador de pruebas: se crea la primera vez (último iOS, un iPhone) y se deja encendido para las siguientes. */
async function testSimulator(): Promise<string> {
  type Device = { udid: string; name: string; state: string };
  const devices = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "-j"])) as { devices: Record<string, Device[]> };
  let device = Object.values(devices.devices).flat().find((d) => d.name === SIMULATOR);
  if (!device) {
    type Runtime = { identifier: string; platform?: string; isAvailable: boolean; version: string; supportedDeviceTypes?: { identifier: string; name: string; productFamily?: string }[] };
    const all = JSON.parse(await run("xcrun", ["simctl", "list", "runtimes", "-j"])) as { runtimes: Runtime[] };
    const runtime = all.runtimes.filter((r) => r.isAvailable && (r.platform === "iOS" || r.identifier.includes("iOS"))).sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).pop();
    if (!runtime) throw new Error("no iOS runtime");
    // Un iPhone que esa versión de iOS admita (si no, simctl create falla con «Incompatible device»).
    const iphones = (runtime.supportedDeviceTypes ?? []).filter((d) => d.productFamily === "iPhone" || d.name.startsWith("iPhone"));
    const type = iphones.find((d) => / Pro$/.test(d.name)) ?? iphones.pop();
    if (!type) throw new Error("no iPhone device type");
    const udid = (await run("xcrun", ["simctl", "create", SIMULATOR, type.identifier, runtime.identifier])).trim();
    device = { udid, name: SIMULATOR, state: "Shutdown" };
  }
  if (device.state !== "Booted") await run("xcrun", ["simctl", "boot", device.udid]).catch(() => undefined);
  await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], undefined, undefined, 300_000);
  return device.udid;
}

/** Config pública de Expo tal como la verá la build. */
export async function appConfig(dir: string, env: Record<string, string>): Promise<{ name?: string; ios?: { bundleIdentifier?: string; googleServicesFile?: string; appleTeamId?: string }; android?: { package?: string; googleServicesFile?: string } } | null> {
  const outText = await run("npx", ["expo", "config", "--json", "--type", "public"], dir, env).catch(() => "");
  const start = outText.indexOf("{");
  try {
    return start >= 0 ? JSON.parse(outText.slice(start)) : null;
  } catch {
    return null;
  }
}

async function isRunning(udid: string, bundleId: string): Promise<boolean> {
  const list = await run("xcrun", ["simctl", "spawn", udid, "launchctl", "list"]).catch(() => "");
  return list.includes(`UIKitApplication:${bundleId}`);
}

function runLong(cmd: string[], cwd: string, env: Record<string, string>, ms: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-200_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGTERM"), ms);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: `${out}\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
  });
}

function run(cmd: string, args: string[], cwd?: string, env?: Record<string, string>, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 20 * 1024 * 1024, timeout }, (err, stdout, stderr) => (err ? reject(new Error(`${stderr || err.message}`.trim())) : resolve(stdout)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
