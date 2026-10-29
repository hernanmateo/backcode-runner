import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Móviles de quien usa este ordenador, para «Instalar en mi móvil»: los iPhone emparejados con el Mac (devicectl, de
// Xcode) y los Android con depuración por USB o inalámbrica (adb). Solo se mira: emparejar la primera vez lo hace la
// persona (cable y «Confiar» en iOS; código de la depuración inalámbrica en Android). Los inalámbricos de Android ya
// emparejados se reconectan solos (su puerto cambia cada vez que se activa la depuración inalámbrica).

const exec = promisify(execFile);

export type DevicePlatform = "ios" | "android";
/**
 * ready: se puede instalar ya. unreachable: emparejado pero no está a la vista (otra wifi, bloqueado, apagado).
 * devMode: iPhone sin el Modo desarrollador. unauthorized: Android que aún no aceptó este ordenador.
 */
export type DeviceState = "ready" | "unreachable" | "devMode" | "unauthorized";

export interface Device {
  /** UDID (iOS) o serie de adb (Android): lo que se pasa al instalar. */
  id: string;
  platform: DevicePlatform;
  name: string;
  model?: string;
  os?: string;
  connection?: "wired" | "network";
  state: DeviceState;
}

/** Ruta de adb: la del SDK de Android (ANDROID_HOME o la de Android Studio) o la del PATH. */
export function adbPath(): string | null {
  const sdk = androidSdk();
  if (sdk && existsSync(join(sdk, "platform-tools", "adb"))) return join(sdk, "platform-tools", "adb");
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "adb"))) return join(dir, "adb");
  return null;
}

export function androidSdk(): string | null {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk"), join(homedir(), "Android", "Sdk")];
  return candidates.find((d): d is string => !!d && existsSync(d)) ?? null;
}

/** ¿Este ordenador puede instalar en esa plataforma? iOS: Mac con Xcode. Android: adb. */
export async function installPlatforms(): Promise<DevicePlatform[]> {
  const out: DevicePlatform[] = [];
  if (process.platform === "darwin" && (await exec("xcrun", ["--find", "devicectl"], { timeout: 10_000 }).then(() => true, () => false))) out.push("ios");
  if (adbPath()) out.push("android");
  return out;
}

export async function listDevices(): Promise<Device[]> {
  const [ios, android] = await Promise.all([iosDevices().catch(() => []), androidDevices().catch(() => [])]);
  return [...ios, ...android];
}

interface DevicectlDevice {
  identifier?: string;
  connectionProperties?: { pairingState?: string; transportType?: string; tunnelState?: string };
  deviceProperties?: { name?: string; osVersionNumber?: string; developerModeStatus?: string };
  hardwareProperties?: { platform?: string; marketingName?: string; udid?: string; deviceType?: string; reality?: string };
}

async function iosDevices(): Promise<Device[]> {
  if (process.platform !== "darwin") return [];
  const dir = mkdtempSync(join(tmpdir(), "backcode-devices-"));
  try {
    const file = join(dir, "devices.json");
    await exec("xcrun", ["devicectl", "list", "devices", "--quiet", "--json-output", file], { timeout: 30_000 });
    const list = (JSON.parse(readFileSync(file, "utf8")) as { result?: { devices?: DevicectlDevice[] } }).result?.devices ?? [];
    return list
      .filter((d) => d.hardwareProperties?.reality === "physical" && d.hardwareProperties.platform === "iOS" && d.connectionProperties?.pairingState === "paired" && d.hardwareProperties.udid)
      .map((d): Device => {
        const transport = d.connectionProperties?.transportType;
        // Sin transporte (o con el túnel «unavailable»), el Mac no lo ve ahora mismo: otra red, apagado o bloqueado hace rato.
        const reachable = !!transport && d.connectionProperties?.tunnelState !== "unavailable";
        return {
          id: d.hardwareProperties!.udid!,
          platform: "ios",
          name: d.deviceProperties?.name ?? d.hardwareProperties?.marketingName ?? "iPhone",
          model: d.hardwareProperties?.marketingName,
          os: d.deviceProperties?.osVersionNumber ? `iOS ${d.deviceProperties.osVersionNumber}` : undefined,
          connection: transport === "wired" ? "wired" : transport ? "network" : undefined,
          state: !reachable ? "unreachable" : d.deviceProperties?.developerModeStatus !== "enabled" ? "devMode" : "ready",
        };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function androidDevices(): Promise<Device[]> {
  const adb = adbPath();
  if (!adb) return [];
  // Los ya emparejados por wifi se anuncian por mDNS con un puerto nuevo cada vez: se conectan (si no lo están).
  const mdns = await exec(adb, ["mdns", "services"], { timeout: 10_000 }).then((r) => r.stdout, () => "");
  const listed = await exec(adb, ["devices"], { timeout: 10_000 }).then((r) => r.stdout, () => "");
  for (const m of mdns.matchAll(/^(\S+)\s+_adb-tls-connect\._tcp\.?\s+(\d+\.\d+\.\d+\.\d+:\d+)/gm)) {
    if (!listed.includes(m[1]) && !listed.includes(m[2])) await exec(adb, ["connect", m[2]], { timeout: 10_000 }).catch(() => undefined);
  }
  const { stdout } = await exec(adb, ["devices", "-l"], { timeout: 10_000 });
  const devices: Device[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const m = /^(\S+)\s+(device|unauthorized|offline)\b(.*)$/.exec(line.trim());
    if (!m || m[1].startsWith("emulator-")) continue;
    const [, serial, status, rest] = m;
    const model = /\bmodel:(\S+)/.exec(rest)?.[1]?.replace(/_/g, " ");
    const network = serial.includes(":") || serial.includes("._adb-tls-connect.");
    let name = model ?? "Android";
    let os: string | undefined;
    if (status === "device") {
      const props = await Promise.all([
        exec(adb, ["-s", serial, "shell", "settings", "get", "global", "device_name"], { timeout: 10_000 }).then((r) => r.stdout.trim(), () => ""),
        exec(adb, ["-s", serial, "shell", "getprop", "ro.build.version.release"], { timeout: 10_000 }).then((r) => r.stdout.trim(), () => ""),
      ]);
      if (props[0] && props[0] !== "null") name = props[0];
      if (props[1]) os = `Android ${props[1]}`;
    }
    devices.push({ id: serial, platform: "android", name, model, os, connection: network ? "network" : "wired", state: status === "device" ? "ready" : status === "unauthorized" ? "unauthorized" : "unreachable" });
  }
  return devices;
}

/**
 * Deja el iPhone listo para instalar: monta la imagen de desarrollador (Developer Disk Image), sin la que Xcode no lo
 * acepta como destino («Timed out waiting for all destinations…»). Solo se puede con el iPhone desbloqueado: si está
 * bloqueado, se reintenta durante `waitMs` (para que dé tiempo a desbloquearlo) y luego se avisa. Devuelve null si está
 * listo, "locked" si siguió bloqueado o el error de devicectl.
 */
export async function prepareIosDevice(udid: string, waitMs = 120_000): Promise<null | "locked" | string> {
  const until = Date.now() + waitMs;
  for (;;) {
    const res = await exec("xcrun", ["devicectl", "device", "info", "ddiServices", "--device", udid], { timeout: 90_000 }).then(
      () => null,
      (err: { stdout?: string; stderr?: string; message?: string }) => `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`,
    );
    if (res === null) return null;
    // Bloqueado, dormido (por wifi, con la pantalla apagada deja de responder) o un corte de la conexión por wifi: se
    // reintenta hasta que responda o se acabe la espera.
    if (!/DeviceLocked|device is locked|acquire assertion|disconnected immediately|not connected|tunnel|timed out|connection reset|ControlChannelConnection|invalidated|NWError/i.test(res)) return res.replace(/\s+\n/g, "\n").trim().slice(-800);
    if (Date.now() > until) return "locked";
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
