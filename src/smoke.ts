import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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

  // Compila en Release, instala en el simulador de pruebas y abre la app (sin Metro: JS incrustado).
  const build = await runLong(["npx", "expo", "run:ios", "--configuration", "Release", "--device", udid, "--no-bundler"], appDir, { ...env, CI: "1" }, BUILD_MS);
  if (!build.ok) return { ok: false, detail: t("smoke.build", { log: tail(build.out) }) };

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
async function appConfig(dir: string, env: Record<string, string>): Promise<{ ios?: { bundleIdentifier?: string; googleServicesFile?: string }; android?: { googleServicesFile?: string } } | null> {
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
const tail = (s: string) => s.trim().split("\n").slice(-15).join("\n").slice(-2000);
