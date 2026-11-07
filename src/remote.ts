import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Remote Control de la sesión de una tarea: un Claude Code interactivo (`claude --resume <sesión> --remote-control`) en
 * el worktree, que se abre en la app de Claude o en claude.ai/code. Necesita un terminal: se le da uno simulado con
 * `script` (macOS y Linux). Corre con los permisos normales de Claude Code de la persona, fuera del sandbox del runner.
 */
export interface RemoteSession {
  /**
   * Enlace de la sesión (https://claude.ai/code/session_…): abre la app de Claude si está instalada. Sin él, la sesión
   * está viva y trabajando pero Claude Code no lo ha dado a tiempo («abierta sin enlace»): sale en la lista de sesiones
   * de la app de Claude, y si llega más tarde se avisa con `onUrl`.
   */
  url?: string;
  /** Proceso del shell que la lleva (líder de su grupo, `detached`): para adoptarla tras un reinicio del runner. */
  pid: number;
  /** Se resuelve cuando el proceso termina (la persona sale de la sesión o se para). */
  exited: Promise<void>;
  stop(): void;
  /** El enlace, cuando llega (en seguida si ya lo tenía). */
  onUrl?(cb: (url: string) => void): void;
}

const LINK_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;
const ID_CHAR = /[A-Za-z0-9]/;
/** Lo que se vuelve a mirar del trozo anterior (una URL partida entre dos trozos) y lo que se guarda de texto. */
const OVERLAP = 1024;
const KEEP = 20_000;
/** Una secuencia de escape sin terminar más larga que esto no se espera más: se tira. */
const MAX_PENDING = 8192;
/** Sin salida nueva durante esto, una URL que acababa al final de lo recibido se da por entera. */
const QUIET_MS = 1500;

/**
 * Quita las secuencias de terminal de un trozo de salida. `compact`: para buscar la URL (los colores, SGR, se quitan sin
 * dejar nada, así no parten la URL; los movimientos de cursor dejan un espacio). `spaced`: para buscar texto («trust this
 * folder») y el diagnóstico (todo CSI deja un espacio). `links`: las URL de los hipervínculos OSC 8, que llevan el
 * enlace completo aunque lo visible salga recortado o partido. `rest`: una secuencia a medias al final, para el próximo.
 */
export function stripTerminal(raw: string): { compact: string; spaced: string; links: string[]; rest: string } {
  let compact = "";
  let spaced = "";
  const links: string[] = [];
  let i = 0;
  const pending = (from: number) => (raw.length - from > MAX_PENDING ? "" : raw.slice(from));
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "\x1b") {
      compact += ch;
      spaced += ch;
      i++;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) return { compact, spaced, links, rest: raw.slice(i) };
    if (next === "]") {
      // OSC: hasta BEL o ESC \.
      const bel = raw.indexOf("\x07", i + 2);
      const st = raw.indexOf("\x1b\\", i + 2);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) return { compact, spaced, links, rest: pending(i) };
      const body = raw.slice(i + 2, end);
      const link = /^8;[^;]*;(.+)$/s.exec(body)?.[1];
      if (link) links.push(link);
      i = end + (end === bel ? 1 : 2);
      continue;
    }
    if (next === "[") {
      const m = /^[0-9;?<>=:]*[ -/]*/.exec(raw.slice(i + 2, i + 2 + 64))![0];
      const final = raw[i + 2 + m.length];
      if (final === undefined) return { compact, spaced, links, rest: pending(i) };
      if (final >= "@" && final <= "~") {
        if (final !== "m") compact += " ";
        spaced += " ";
        i += 3 + m.length;
      } else i += 2;
      continue;
    }
    if (next === "(" || next === ")") {
      if (raw[i + 2] === undefined) return { compact, spaced, links, rest: raw.slice(i) };
      i += 3;
      continue;
    }
    // ESC 7 / ESC 8 (guardar/restaurar cursor) y el resto de secuencias de dos caracteres.
    i += 2;
  }
  return { compact, spaced, links, rest: "" };
}

/**
 * La URL de la sesión en un texto ya sin secuencias, o null. Una que acaba justo al final del texto no vale aún (puede
 * venir el resto en el próximo trozo) salvo con `final`. Si la TUI la envuelve (acaba en un salto de línea y la línea
 * siguiente sigue con letras y números, tras espacios o bordes │), se juntan los dos trozos.
 */
export function findLink(text: string, final = false): string | null {
  for (const m of text.matchAll(LINK_RE)) {
    let url = m[0];
    let end = m.index + url.length;
    while (true) {
      const wrap = /^\r*\n[\r\n]*[ \t│┃|]*/.exec(text.slice(end));
      if (!wrap) break;
      const cont = /^[A-Za-z0-9]+/.exec(text.slice(end + wrap[0].length))?.[0];
      if (!cont) {
        // El salto de línea y nada más: puede que la continuación aún no haya llegado.
        if (end + wrap[0].length >= text.length && !final) return null;
        break;
      }
      url += cont;
      end += wrap[0].length + cont.length;
    }
    if (end >= text.length && !final) return null;
    if (end < text.length && ID_CHAR.test(text[end])) continue;
    return url;
  }
  return null;
}

/**
 * Lee la salida de la TUI trozo a trozo y busca el enlace solo en lo nuevo (con solapamiento con lo anterior): da igual
 * cuánto redibuje la TUI, y una secuencia o una URL partida entre dos trozos se junta.
 */
export function createLinkScanner() {
  let rest = "";
  let overlap = "";
  let text = "";
  let visible = false;
  return {
    /** Un trozo de salida: devuelve la URL si ya está entera. */
    push(chunk: string): string | null {
      const r = stripTerminal(rest + chunk);
      rest = r.rest;
      text = (text + r.spaced).slice(-KEEP);
      if (!visible && /\S/.test(r.spaced)) visible = true;
      const link = r.links.map((l) => /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.exec(l)?.[0]).find(Boolean);
      if (link) return link;
      const window = overlap + r.compact;
      overlap = window.slice(-OVERLAP);
      return findLink(window);
    },
    /** Al acabarse la espera: una URL que acabe justo al final también vale. */
    flush(): string | null {
      return findLink(overlap, true);
    },
    /** Texto añadido que no es de la TUI (stderr): solo para el diagnóstico. */
    note(s: string) {
      text = (text + stripTerminal(s).spaced).slice(-KEEP);
    },
    /** Las últimas líneas (sin secuencias), para «trust this folder» y el diagnóstico. */
    text: (last = KEEP) => text.slice(-last),
    /** ¿Ha sacado algo visible? (una sesión que trabaja). */
    visible: () => visible,
  };
}

const DIAG_RE = /error|log ?in|logged|auth|unauthori[sz]ed|forbidden|denied|failed|unavailable|not available|not found|not permitted|no conversation|invalid|expired|exit|couldn't|cannot|can't|unable|permission/i;

/**
 * Lo que se cuenta del final de la salida al fallar: solo las líneas con pinta de diagnóstico (errores, login…) y
 * recortado, nunca la pantalla entera (sería el texto de la conversación).
 */
export function diagnostic(text: string): string {
  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && DIAG_RE.test(l));
  return [...new Set(lines)].slice(-2).join(" · ").slice(-200);
}

/** Errores que dicen que la sesión no ha arrancado de verdad aunque el proceso siga vivo (sin login, sin Remote Control). */
const NOT_STARTED_RE = /not logged in|please (run )?\/login|must be logged in|invalid api key|unauthori[sz]ed|remote control is not (available|enabled)|remote control (is )?disabled/i;
export const notStarted = (text: string) => NOT_STARTED_RE.test(text);

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
  return watchRemoteControl(child, opts.timeoutMs);
}

/**
 * Espera el enlace de una sesión ya lanzada (en su propio grupo de procesos). Aparte de startRemoteControl para poder
 * probarlo con cualquier proceso, sin terminal simulado.
 */
export function watchRemoteControl(child: ChildProcessWithoutNullStreams, timeoutMs = 90_000): Promise<RemoteSession> {
  // Escribir cuando la sesión ya ha terminado (EPIPE) no debe tumbar el runner.
  child.stdin.on("error", () => undefined);
  const stop = () => {
    if (child.pid) stopGroup(child.pid);
  };
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  let alive = true;
  child.on("exit", () => (alive = false));

  return new Promise((resolve, reject) => {
    const scanner = createLinkScanner();
    let trusted = false;
    let settled = false;
    let quiet: NodeJS.Timeout | undefined;
    let url: string | null = null;
    const listeners: ((url: string) => void)[] = [];
    const session = (link?: string): RemoteSession => ({
      ...(link ? { url: link } : {}),
      pid: child.pid ?? 0,
      exited,
      stop,
      onUrl: (cb) => (url ? cb(url) : void listeners.push(cb)),
    });
    function found(link: string) {
      if (url) return;
      url = link;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(session(link));
      }
      for (const cb of listeners.splice(0)) cb(link);
    }
    // Sin enlace a tiempo: si la sesión está viva y trabajando no se mata nunca (queda abierta sin enlace); solo falla
    // si no ha sacado nada o dice que no ha arrancado (sin login…).
    const timer = setTimeout(() => {
      if (settled) return;
      const late = scanner.flush();
      if (late) return found(late);
      if (alive && scanner.visible() && !notStarted(scanner.text())) {
        settled = true;
        resolve(session());
        return;
      }
      fail("timeout");
    }, timeoutMs);
    function fail(reason: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      const diag = diagnostic(scanner.text());
      reject(new Error(`${reason}${diag ? `: ${diag}` : ""}`));
    }
    // La salida se sigue leyendo hasta el final: si nadie la lee, el proceso se bloquea al llenarse la tubería.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (url) return;
      const link = scanner.push(d);
      // Carpeta (worktree) en la que aún no se ha confiado: se acepta (la tarea es de la persona y ella lo ha pedido).
      if (!trusted && /trust\s+this\s+folder/i.test(scanner.text(4000))) {
        trusted = true;
        setTimeout(() => child.stdin.write("\x1b[B\r"), 400);
      }
      if (link) return found(link);
      // Una URL al final de lo recibido (puede seguir en la línea siguiente si la TUI la envuelve): si en un momento no
      // llega nada más, vale tal cual.
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        const late = url ? null : scanner.flush();
        if (late) found(late);
      }, QUIET_MS);
      quiet.unref?.();
    });
    child.stderr.on("data", (d: string) => {
      if (!url) scanner.note(d);
    });
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
