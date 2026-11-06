import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Remote Control de la sesión de una tarea: un Claude Code interactivo (`claude --resume <sesión> --remote-control`) en
 * el worktree, que se abre en la app de Claude o en claude.ai/code. Necesita un terminal: se le da uno simulado con
 * `script` (macOS y Linux). Corre con los permisos normales de Claude Code de la persona, fuera del sandbox del runner.
 */
export interface RemoteSession {
  /** Enlace de la sesión (https://claude.ai/code/session_…): abre la app de Claude si está instalada. */
  url: string;
  /** Proceso del shell que la lleva (líder de su grupo, `detached`): para adoptarla tras un reinicio del runner. */
  pid: number;
  /** Se resuelve cuando el proceso termina (la persona sale de la sesión o se para). */
  exited: Promise<void>;
  stop(): void;
}

// Secuencias de terminal (OSC, CSI y guardar/restaurar cursor) fuera, para buscar texto en la salida.
const clean = (s: string) =>
  s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, " ")
    .replace(/\x1b[78]/g, "");

const ARG_VAR = "BC_RC_ARG_";

/** Variables que no deben pasar a la sesión: las del propio runner y las que marcarían a Claude como sesión hija. */
function sessionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("BACKCODE_") || k.startsWith(ARG_VAR) || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_CHILD")) continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  return env;
}

/** Argumentos de Claude Code: retomar la sesión de una tarea o una sesión nueva (con un primer mensaje opcional). */
export function remoteArgs(opts: { bin: string; name: string; sessionId?: string; prompt?: string }): string[] {
  const args = [opts.bin, ...(opts.sessionId ? ["--resume", opts.sessionId] : []), "--remote-control", opts.name];
  // `--`: un prompt que empiece por «-» nunca se lee como una opción.
  return opts.prompt ? [...args, "--", opts.prompt] : args;
}

/** Marca de la orden: así se reconoce una sesión nuestra al adoptarla (y no otro proceso con el mismo pid). */
export const SESSION_MARK = "sleep 2147483647";

/**
 * La orden de `sh -c` es siempre fija: cada argumento va en una variable de entorno y se usa como "$BC_RC_ARG_n" (el
 * shell no vuelve a interpretar lo expandido), así que ningún texto (el nombre, el prompt de la app) entra en la orden.
 * En Linux, `script -c` pasa su orden (fija, entre comillas simples) a otro shell, que expande las mismas variables.
 * `cat |`: script necesita que su entrada sea una tubería de verdad (con la de Node, un socket, falla en macOS).
 * `persistent` (la sesión directa de un proyecto): con las tuberías de keepAlive, para que sobreviva al runner. La de
 * una tarea, no: si el runner muere, se cierra con él (como siempre).
 */
export function remoteCommand(args: string[], platform: NodeJS.Platform = process.platform, persistent = false): { cmd: string; env: Record<string, string> } {
  const refs = args.map((_, i) => `"$${ARG_VAR}${i}"`).join(" ");
  const env = Object.fromEntries(args.map((a, i) => [`${ARG_VAR}${i}`, a]));
  const inner = platform === "darwin" ? `script -q /dev/null ${refs}` : `script -qfc '${refs}' /dev/null`;
  return { cmd: persistent ? keepAlive(inner) : `cat | ${inner}`, env };
}

/**
 * Tuberías que no dependen del runner, para que la sesión sobreviva a un reinicio o una actualización (que las cierran):
 * - Entrada: una tubería de verdad (con un FIFO, `script` también falla en macOS: allí van sobre sockets). `cat` le
 *   pasa lo que mande el runner (aceptar «trust this folder») y, si el runner desaparece, `sleep` deja la tubería
 *   abierta: `script` nunca ve el fin de la entrada.
 * - Salida: el primer `cat` se la pasa al runner; si este ya no está, muere al escribir y el segundo la tira, así Claude
 *   no se bloquea con la tubería llena. Cuando `script` termina (Claude sale), `kill 0` cierra el grupo entero (el
 *   `sleep` incluido) y el shell termina.
 */
export const keepAlive = (inner: string) => `{ cat; exec ${SESSION_MARK}; } | ${inner} 2>&1 | { cat; cat >/dev/null; kill 0; }`;

/**
 * Bajo systemd (el servicio en Linux), `systemctl restart` mata todo el grupo de control aunque el proceso vaya aparte:
 * la sesión directa se lanza en su propio scope (orden fija). Sin systemd-run, como siempre.
 */
export function launcher(cmd: string, persistent: boolean, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (persistent && platform === "linux" && env.INVOCATION_ID && hasBin("systemd-run", env)) return ["systemd-run", ["--user", "--scope", "--collect", "--quiet", "sh", "-c", cmd]];
  return ["sh", ["-c", cmd]];
}

const hasBin = (bin: string, env: NodeJS.ProcessEnv) => (env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));

/**
 * ¿Sigue viva la sesión con ese pid y es nuestra? Líder de su grupo de procesos y con la orden de remoteCommand (tras
 * reiniciar el ordenador, el pid puede ser de otro proceso). `false` si no se puede saber.
 */
export function isRemoteSession(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const out = execFileSync("ps", ["-o", "pgid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim();
    const [pgid, ...command] = out.split(/\s+/);
    return Number(pgid) === pid && command.join(" ").includes(SESSION_MARK);
  } catch {
    return false;
  }
}

/** ¿Sigue vivo el proceso? (señal 0: solo comprueba). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH, o EPERM: existe pero es de otro usuario (el pid ya no es el nuestro).
    return false;
  }
}

/** Cierra la sesión: todo su grupo de procesos (script y, con él, Claude Code y lo que tenga en marcha). */
export function stopGroup(pid: number): void {
  try {
    if (pid > 1) process.kill(-pid, "SIGTERM");
  } catch {
    // ya había terminado
  }
}

/**
 * `persistent`: la sesión directa de un proyecto (project-session.ts), que debe sobrevivir a un reinicio del servicio.
 * Todas van en su propio grupo de procesos (`detached`) y sin depender de las tuberías del runner (keepAlive).
 */
export function startRemoteControl(opts: { bin: string; cwd: string; sessionId?: string; prompt?: string; name: string; timeoutMs?: number; persistent?: boolean }): Promise<RemoteSession> {
  const { cmd, env } = remoteCommand(remoteArgs(opts), process.platform, !!opts.persistent);
  const [bin, args] = launcher(cmd, !!opts.persistent);
  const child = spawn(bin, args, { cwd: opts.cwd, env: { ...sessionEnv(), ...env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  // Escribir cuando la sesión ya ha terminado (EPIPE) no debe tumbar el runner.
  child.stdin.on("error", () => undefined);
  const stop = () => {
    if (child.pid) stopGroup(child.pid);
  };
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  return new Promise((resolve, reject) => {
    let out = "";
    let trusted = false;
    let found = false;
    const timer = setTimeout(() => fail("timeout"), opts.timeoutMs ?? 90_000);
    function fail(reason: string) {
      if (found) return;
      found = true;
      clearTimeout(timer);
      stop();
      const tail = clean(out).replace(/\s+/g, " ").trim().slice(-300);
      reject(new Error(`${reason}${tail ? `: ${tail}` : ""}`));
    }
    // La salida se sigue leyendo hasta el final: si nadie la lee, el proceso se bloquea al llenarse la tubería.
    child.stdout.on("data", (d: Buffer) => {
      if (found) return;
      out = (out + d.toString()).slice(-20_000);
      const text = clean(out);
      // Carpeta (worktree) en la que aún no se ha confiado: se acepta (la tarea es de la persona y ella lo ha pedido).
      if (!trusted && /trust\s+this\s+folder/i.test(text)) {
        trusted = true;
        setTimeout(() => child.stdin.write("\x1b[B\r"), 400);
      }
      const url = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(text)?.[0];
      if (url) {
        found = true;
        clearTimeout(timer);
        resolve({ url, pid: child.pid ?? 0, exited, stop });
      }
    });
    child.stderr.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
    child.on("exit", (code) => fail(`exit ${code}`));
    child.on("error", (err) => fail(err.message));
  });
}

/**
 * Sigue el transcript de la sesión (~/.claude/projects/<cwd>/<sesión>.jsonl) mientras está en Remote Control, para que
 * la actividad de la tarea muestre lo que hace Claude. Es lo que escribe Claude Code en disco: si cambia el formato o
 * no está, simplemente no se ve nada.
 */
export function followTranscript(cwd: string, sessionId: string, onEntry: (entry: Record<string, unknown>) => void): () => void {
  const file = transcriptPath(cwd, sessionId);
  // Solo lo nuevo: lo que ya había es la parte de la conversación que hizo el runner.
  let offset = existsSync(file) ? statSync(file).size : 0;
  let partial = "";
  const timer = setInterval(() => {
    try {
      const size = statSync(file).size;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      const fd = openSync(file, "r");
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      const lines = (partial + buf.toString()).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        try {
          if (line.trim()) onEntry(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // línea a medias o no JSON
        }
      }
    } catch {
      // aún no existe
    }
  }, 3000);
  return () => clearInterval(timer);
}

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const projectsDir = () => join(claudeDir(), "projects");

/** Días que Claude Code guarda el historial de las sesiones si no se cambia `cleanupPeriodDays`. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Cuántos días guarda Claude Code las sesiones en este ordenador: `cleanupPeriodDays` del settings.json de Claude Code
 * de la persona (o 30). Solo se lee ese ajuste, y el runner no lo cambia nunca.
 */
export function retentionDays(): number {
  try {
    const value = (JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf8")) as { cleanupPeriodDays?: unknown }).cleanupPeriodDays;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return Math.min(value, 36500);
  } catch {
    // Sin settings.json o no es JSON: el valor por defecto.
  }
  return DEFAULT_RETENTION_DAYS;
}

/** El error de Claude Code al retomar una sesión cuyo transcript ya no está. */
export const isSessionGoneError = (message: string) => /no conversation found/i.test(message);

/**
 * Si la sesión de una tarea sigue en este ordenador (en la carpeta del worktree o en cualquier otra de
 * ~/.claude/projects, como la busca adoptTranscript), sin copiar nada.
 */
export function hasTranscript(cwd: string, sessionId: string): boolean {
  if (existsSync(transcriptPath(cwd, sessionId))) return true;
  try {
    return readdirSync(projectsDir()).some((dir) => existsSync(join(projectsDir(), dir, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}
/** Dónde guarda Claude Code la conversación de una sesión: por carpeta de trabajo. */
export function transcriptPath(cwd: string, sessionId: string): string {
  return join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/**
 * Una sesión empezada en otra carpeta (p. ej. la de una tarea hecha con Claude Code desde el repo, que luego pasó a su
 * worktree): se copia a la carpeta del worktree para poder retomarla allí. La original no se toca. Devuelve si está.
 */
export function adoptTranscript(cwd: string, sessionId: string): boolean {
  const target = transcriptPath(cwd, sessionId);
  if (existsSync(target)) return true;
  try {
    for (const dir of readdirSync(projectsDir())) {
      const source = join(projectsDir(), dir, `${sessionId}.jsonl`);
      if (!existsSync(source)) continue;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      return true;
    }
  } catch {
    // Sin carpeta de sesiones: no hay nada que copiar.
  }
  return false;
}
