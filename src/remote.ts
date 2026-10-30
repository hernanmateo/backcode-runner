import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
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

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Variables que no deben pasar a la sesión: las del propio runner y las que marcarían a Claude como sesión hija. */
function sessionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("BACKCODE_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_CHILD")) continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  return env;
}

export function startRemoteControl(opts: { bin: string; cwd: string; sessionId: string; name: string; timeoutMs?: number }): Promise<RemoteSession> {
  const args = [opts.bin, "--resume", opts.sessionId, "--remote-control", opts.name];
  // `cat |`: script necesita que su entrada sea una tubería de verdad (con la de Node, un socket, falla en macOS).
  const cmd =
    process.platform === "darwin" ? `cat | script -q /dev/null ${args.map(quote).join(" ")}` : `cat | script -qfc ${quote(args.map(quote).join(" "))} /dev/null`;
  const child = spawn("sh", ["-c", cmd], { cwd: opts.cwd, env: sessionEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // ya había terminado
    }
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
        resolve({ url, exited, stop });
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

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
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
