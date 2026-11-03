import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sanitize } from "./diagnostics.js";
import { PANEL_PORT } from "./panel-client.js";
import { BIN_DIR } from "./paths.js";
import { launchesExecutable, SERVICE_LABEL, SERVICE_LOG, serviceProgram } from "./service.js";

// Por qué no responde el panel cuando la app de Mac (`backcode app-url`) lo ha esperado en vano: el servicio de launchd
// sin cargar o en espera, bloqueado en Ítems de inicio, el puerto en manos de otro proceso o un servicio que se cae al
// arrancar. El resultado lo enseña la app (mac/BackcodeRunner.swift) en su aviso: textos en inglés, como el resto de la app.

const exec = promisify(execFile);

/** Pantalla de Configuración del Sistema › General › Ítems de inicio (la abre la app con un botón). */
export const LOGIN_ITEMS_URL = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

export type DiagnosisKind = "port-busy" | "blocked" | "not-loaded" | "stale-service" | "not-running" | "crashed" | "no-panel" | "unknown";

export interface Diagnosis {
  kind: DiagnosisKind;
  /** Qué pasa, en una frase. */
  message: string;
  /** Qué hacer. */
  hint: string;
  /** La app ofrece el botón «Open Login Items». */
  loginItems?: boolean;
  /** Últimas líneas relevantes de service.log, ya sin secretos. */
  log?: string[];
}

/** Lo que interesa de `launchctl print gui/<uid>/com.backcode.runner`. */
export interface ServiceInfo {
  state?: string;
  pid?: number;
  lastExitCode?: string;
}

/** Proceso que escucha en el puerto del panel (`lsof`). */
export interface PortOwner {
  pid: number;
  command: string;
}

export function parseLaunchctlPrint(text: string): ServiceInfo {
  const info: ServiceInfo = {};
  // Solo el primer nivel del servicio (un tabulador): los bloques anidados (endpoints, spawn…) llevan más sangría.
  for (const line of text.split("\n")) {
    const m = /^\t(state|pid|last exit code) = (.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === "state" && info.state === undefined) info.state = m[2];
    else if (m[1] === "pid" && info.pid === undefined && /^\d+$/.test(m[2])) info.pid = Number(m[2]);
    else if (m[1] === "last exit code" && info.lastExitCode === undefined) info.lastExitCode = m[2];
  }
  return info;
}

/** ¿`launchctl print-disabled gui/<uid>` marca el servicio como desactivado? (lo que hace «Permitir en segundo plano» apagado). */
export function parseDisabled(text: string, label = SERVICE_LABEL): boolean {
  const m = new RegExp(`"${label.replace(/\./g, "\\.")}"\\s*=>\\s*(\\w+)`).exec(text);
  return !!m && (m[1] === "disabled" || m[1] === "true");
}

/** Primer proceso en escucha de `lsof -nP -iTCP:<puerto> -sTCP:LISTEN -Fpc` (p<pid>, c<orden>). */
export function parseLsof(text: string): PortOwner | null {
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p") && pid === undefined) pid = Number(line.slice(1));
    else if (line.startsWith("c") && pid !== undefined) return { pid, command: line.slice(1).trim() };
  }
  return pid ? { pid, command: "" } : null;
}

/** ¿La salida de launchd es un fallo? (`0`, `(never exited)` o vacío, no). */
export function failedExit(code?: string): boolean {
  if (!code) return false;
  const n = /^-?\d+/.exec(code.trim());
  return !!n && Number(n[0]) !== 0;
}

/** Un proceso de launchd que está pero no corre: en espera, sin lanzar o lanzándose aún. */
const WAITING = /not running|waiting|spawn scheduled|speculative|xpcproxy/i;
const RELEVANT = /error|fail|exception|cannot|can't|unable|denied|EADDRINUSE|EACCES|EPERM|ENOENT|killed|abort|crash/i;

/**
 * Últimas líneas útiles del registro del servicio, sin secretos: las que hablan de errores si las hay (con la última
 * línea, que suele ser la causa) y, si no, las últimas. La línea que aún parece un secreto tras limpiarla se oculta.
 */
export function logExcerpt(text: string, max = 8): string[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-200);
  const relevant = lines.filter((l) => RELEVANT.test(l));
  const picked = relevant.length ? relevant.slice(-max) : lines.slice(-max);
  return picked.map((l) => {
    // El token del panel va en el fragmento de su dirección (#t=…): no lo detecta looksSecret.
    const clean = sanitize(l.replace(/#t=[^\s"']+/g, "#t=<token>"));
    return clean === null ? "[hidden: looked like a secret]" : clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
  });
}

export interface DiagnoseDeps {
  /** ¿Se usa el servicio de launchd? (false: BACKCODE_APP_NO_SERVICE o «Arrancar al iniciar sesión» apagado). */
  service: boolean;
  /** `launchctl print` del servicio; null si launchd no lo tiene cargado. */
  launchctlPrint: () => Promise<string | null>;
  /** `launchctl print-disabled gui/<uid>`. */
  printDisabled: () => Promise<string>;
  /** Quién escucha en el puerto del panel. */
  portOwner: () => Promise<PortOwner | null>;
  /** Final de service.log (vacío si no existe). */
  readLog: () => string;
  port?: number;
  /** ProgramArguments del plist del servicio (null si no se puede leer). */
  program?: () => Promise<string[] | null>;
  /** El ejecutable que debe lanzar el servicio (la copia de ~/.backcode/bin). */
  executable?: string;
}

const LOG_HINT = "Check ~/.backcode/logs/service.log for details.";

/** El motivo más concreto que se pueda dar de por qué el panel no ha respondido. */
export async function diagnose(d: DiagnoseDeps): Promise<Diagnosis> {
  const port = d.port ?? PANEL_PORT;
  const [print, disabledText, owner, program] = await Promise.all([
    d.service ? d.launchctlPrint().catch(() => null) : Promise.resolve(null),
    d.service ? d.printDisabled().catch(() => "") : Promise.resolve(""),
    d.portOwner().catch(() => null),
    d.service && d.program && d.executable ? d.program().catch(() => null) : Promise.resolve(null),
  ]);
  const info = print ? parseLaunchctlPrint(print) : {};
  const excerpt = logExcerpt(safeRead(d.readLog));
  const log = excerpt.length ? excerpt : undefined;

  // Alguien tiene el puerto y no contesta como el panel: otro programa, o un runner viejo o colgado.
  if (owner) {
    const who = `${owner.command || "a process"} (PID ${owner.pid})`;
    const ours = owner.pid === info.pid || /backcode|node/i.test(owner.command);
    return {
      kind: "port-busy",
      message: ours
        ? `Port ${port} is held by ${who}, an older or stuck Backcode process that isn't answering.`
        : `Port ${port} is taken by ${who}, which isn't the Backcode panel.`,
      hint: ours
        ? `Retry restarts the service. If it keeps happening, quit it with \`kill ${owner.pid}\` and retry.`
        : `Quit that program (or run \`kill ${owner.pid}\`) and retry, or set BACKCODE_PANEL_PORT to use another port.`,
      log,
    };
  }

  if (!d.service) {
    return {
      kind: "no-panel",
      message: "The runner's panel didn't start in the background.",
      hint: `${LOG_HINT} You can also run \`backcode\` in Terminal to see what happens.`,
      log,
    };
  }

  if (parseDisabled(disabledText)) {
    return {
      kind: "blocked",
      message: "macOS is blocking the Backcode service from running in the background.",
      hint: "Open System Settings › General › Login Items, turn on Backcode under «Allow in the Background», then Retry.",
      loginItems: true,
      log,
    };
  }

  if (!print) {
    return {
      kind: "not-loaded",
      message: "The Backcode service isn't loaded in launchd (com.backcode.runner).",
      hint: "Retry installs it again. If it still doesn't load, check that Backcode is allowed in System Settings › General › Login Items › Allow in the Background.",
      loginItems: true,
      log,
    };
  }

  // El servicio lanza otro ejecutable (node + cli.js de una instalación antigua, npx, una ruta vieja): corre una versión vieja.
  if (program && d.executable && !launchesExecutable(program, d.executable)) {
    return {
      kind: "stale-service",
      message: `The Backcode service runs an old or different executable (${program.join(" ")}) instead of the app's runner.`,
      hint: `Retry reinstalls the service with the new version. By hand: \`${d.executable} service install\`.`,
      log,
    };
  }

  const running = info.pid !== undefined && !/not running/i.test(info.state ?? "");
  if (!running && failedExit(info.lastExitCode)) {
    return {
      kind: "crashed",
      message: `The Backcode service exits with an error when it starts (last exit code ${info.lastExitCode}).`,
      hint: log ? "See the last lines of the log below. Retry restarts it." : `${LOG_HINT} Retry restarts it.`,
      log,
    };
  }

  if (!running) {
    return {
      kind: "not-running",
      message: `The Backcode service is loaded but not running (state: ${info.state ?? "unknown"}).`,
      hint: "macOS may be holding it back: check System Settings › General › Login Items › Allow in the Background, then Retry.",
      loginItems: true,
      log,
    };
  }

  return {
    kind: failedExit(info.lastExitCode) ? "crashed" : "unknown",
    message: `The Backcode service is running (PID ${info.pid}) but its panel isn't answering on port ${port}.`,
    hint: `Retry restarts the service. ${LOG_HINT}`,
    log,
  };
}

function safeRead(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

/** Final (64 KB) de un fichero, sin leerlo entero. */
export function readTail(file: string, bytes = 64 * 1024): string {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

/** Las dependencias de verdad (macOS; en Linux, solo puerto y registro). Cada comando, con un tiempo máximo corto. */
export function systemDiagnoseDeps(service: boolean): DiagnoseDeps {
  const uid = userInfo().uid;
  const mac = process.platform === "darwin";
  return {
    service: service && mac,
    launchctlPrint: () => exec("launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`], { timeout: 5000 }).then((r) => r.stdout, () => null),
    printDisabled: () => exec("launchctl", ["print-disabled", `gui/${uid}`], { timeout: 5000 }).then((r) => r.stdout, () => ""),
    portOwner: () =>
      exec("lsof", ["-nP", `-iTCP:${PANEL_PORT}`, "-sTCP:LISTEN", "-Fpc"], { timeout: 5000 }).then(
        (r) => parseLsof(r.stdout),
        () => null, // lsof sale con 1 si no hay nadie
      ),
    readLog: () => readTail(SERVICE_LOG),
    program: serviceProgram,
    executable: join(BIN_DIR, "backcode"),
  };
}
