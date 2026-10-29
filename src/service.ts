import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PACKAGE_NAME, VERSION } from "./autoupdate.js";
import { KIT_DIR } from "./config.js";
import { APP_DIR, FROM_NPM, IS_BINARY, LOGS_DIR, MANAGED } from "./paths.js";

// «Arrancar al iniciar sesión»: el panel (con un runner por proyecto) como servicio del usuario, sin terminal abierta.
// macOS: LaunchAgent (~/Library/LaunchAgents). Linux: unidad de systemd --user. Se reinicia solo si se cae.
// El servicio no hereda tu PATH de la terminal: se guarda el de ahora para que encuentre git, gh, claude, eas…

const exec = promisify(execFile);
const LABEL = "com.backcode.runner";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", "backcode-runner.service");
export const SERVICE_LOG = join(LOGS_DIR, "service.log");

export const serviceSupported = () => process.platform === "darwin" || process.platform === "linux";

export function serviceInstalled(): boolean {
  return process.platform === "darwin" ? existsSync(PLIST) : process.platform === "linux" ? existsSync(UNIT) : false;
}

/** ¿Somos el proceso del servicio? (lo marca la propia definición del servicio). */
export const isService = () => process.env.BACKCODE_SERVICE === "1";

/**
 * Carpeta del runner que usará el servicio. Una copia de git o la instalación propia valen tal cual; desde npx (una caché
 * que npm puede borrar) o una instalación global, primero se instala esta misma versión en ~/.backcode/app, que además
 * se puede actualizar sola sin permisos de administrador.
 */
async function stableKitDir(): Promise<string> {
  if (IS_BINARY || !FROM_NPM || MANAGED) return KIT_DIR;
  mkdirSync(APP_DIR, { recursive: true });
  await exec("npm", ["install", "--prefix", APP_DIR, `${PACKAGE_NAME}@${VERSION}`, "--no-audit", "--no-fund"], { cwd: APP_DIR, timeout: 10 * 60_000 });
  return join(APP_DIR, "node_modules", ...PACKAGE_NAME.split("/"));
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * `executable`: el ejecutable sin Node que debe lanzar el servicio (la app de Mac pasa su copia de ~/.backcode/bin).
 * `keepRunning`: lo pide el propio servicio (volver a activar «Arrancar al iniciar sesión»): solo se deja la definición
 * para el próximo inicio de sesión, sin pararlo ni volverlo a lanzar.
 */
export async function installService(opts: { executable?: string; keepRunning?: boolean } = {}): Promise<void> {
  const kit = await stableKitDir();
  // El ejecutable sin Node ya está en un sitio fijo (~/.backcode/bin) y se lanza tal cual.
  const program = opts.executable ? [opts.executable, "serve"] : IS_BINARY ? [process.execPath, "serve"] : [process.execPath, join(kit, "dist", "cli.js"), "serve"];
  // El PATH de ahora más las rutas habituales: abierta desde el Finder, la app no trae el PATH de tu terminal.
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".backcode", "bin")];
  const path = [...new Set([...extra, ...(process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":")])].filter(Boolean).join(":");
  const env: Record<string, string> = { BACKCODE_SERVICE: "1", PATH: path, HOME: homedir() };
  for (const key of ["LANG", "LC_ALL", "BACKCODE_HOME", "BACKCODE_PANEL_PORT", "BACKCODE_LANG"]) if (process.env[key]) env[key] = process.env[key]!;
  mkdirSync(LOGS_DIR, { recursive: true });

  if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${program.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>WorkingDirectory</key><string>${xml(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(SERVICE_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(SERVICE_LOG)}</string>
</dict>
</plist>
`;
    mkdirSync(dirname(PLIST), { recursive: true });
    const domain = `gui/${userInfo().uid}`;
    if (opts.keepRunning) return writeFileSync(PLIST, plist);
    await exec("launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => undefined);
    writeFileSync(PLIST, plist);
    await exec("launchctl", ["bootstrap", domain, PLIST]);
    // RunAtLoad no basta: macOS 27 puede dejar el arranque en espera («speculative») y no lanzarlo nunca.
    await kickService();
    return;
  }
  if (process.platform === "linux") {
    const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const unit = `[Unit]
Description=Backcode runner
After=network-online.target

[Service]
ExecStart=${program.map(quote).join(" ")}
WorkingDirectory=${homedir()}
${Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=30
StandardOutput=append:${SERVICE_LOG}
StandardError=append:${SERVICE_LOG}

[Install]
WantedBy=default.target
`;
    mkdirSync(dirname(UNIT), { recursive: true });
    writeFileSync(UNIT, unit);
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", ...(opts.keepRunning ? [] : ["--now"]), "backcode-runner.service"]);
    return;
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

/** Arranca el servicio ya instalado si no está en marcha (sin -k: si ya corre, no lo toca). Solo macOS. */
export async function kickService(): Promise<void> {
  if (process.platform !== "darwin") return;
  await exec("launchctl", ["kickstart", `gui/${userInfo().uid}/${LABEL}`]).catch(() => undefined);
}

/**
 * Desactiva «Arrancar al iniciar sesión» sin parar nada: el servicio sigue en marcha (y relanzándose si se cae) hasta
 * que cierres sesión o lo apagues, y al próximo inicio de sesión ya no arranca.
 */
export async function disableAutostart(): Promise<void> {
  if (process.platform === "darwin") rmSync(PLIST, { force: true });
  else if (process.platform === "linux") {
    await exec("systemctl", ["--user", "disable", "backcode-runner.service"]).catch(() => undefined);
    rmSync(UNIT, { force: true });
  }
}

/** Quita el servicio. Si este proceso es el servicio, el sistema lo para (hay que responder antes de llamar aquí). */
export async function uninstallService(): Promise<void> {
  if (process.platform === "darwin") {
    rmSync(PLIST, { force: true });
    await exec("launchctl", ["bootout", `gui/${userInfo().uid}/${LABEL}`]).catch(() => undefined);
  } else if (process.platform === "linux") {
    await exec("systemctl", ["--user", "disable", "--now", "backcode-runner.service"]).catch(() => undefined);
    rmSync(UNIT, { force: true });
    await exec("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
}
