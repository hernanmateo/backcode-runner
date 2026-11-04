// Checks en local: en vez de (o además de) la CI de GitHub/Bitbucket, el runner ejecuta en este ordenador los comandos de
// comprobación del repo sobre un commit y publica cada resultado en él como un estado «Backcode · <nombre>» (sale en el
// PR como un check más). Son comandos de shell fijos, sin Claude: no gastan tokens.
//
//   [check.app]
//   run = "npm run typecheck && npm run lint"   # el comando (con sh -c) o una lista ["make", "test"] (sin shell)
//   dir = "app"                                 # opcional: carpeta, relativa a la raíz; por defecto la raíz
//   install = true                              # opcional: instalar antes las dependencias de esa carpeta (por defecto sí)
//   timeout = 20                                # opcional: minutos (1-60, por defecto 20)
//   idle = 5                                    # opcional: minutos sin escribir nada antes de darlo por colgado (1-60, por defecto 5)
//   paths = ["app", "firestore.rules"]          # opcional: de qué depende (carpetas o ficheros); por defecto, todo el repo
//   description = "Tipos y lint de la app"      # opcional
//
// Rápidos: se ejecutan a la vez, y un check que ya pasó con el mismo contenido de sus `paths` (el mismo commit, el squash
// de un PR ya comprobado o un PR que no los toca) no se repite: checks-cache.ts lo recuerda en este ordenador.
//
// Los comandos se leen del backcode.toml de la rama base (no del PR): un PR no puede rebajar lo que se comprueba.
// Se usan en dos casos: el proyecto tiene «Checks en local» (checksMode = "local") o, con la CI del host, alguien pide
// «Pasar los checks en local» porque los checks de GitHub no llegaron a ejecutarse (Actions sin minutos o pago fallido).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksSecret } from "./diagnostics.js";
import { parseToml } from "./deploy-config.js";
import { checkKey, type ChecksCache, fileChecksCache } from "./checks-cache.js";
import { createDetachedWorktree, git, removeWorktree } from "./git.js";
import { type Checks, type CheckItem, type PrHost, summarize } from "./hosts.js";
import { t } from "./i18n.js";
import { HOME_DIR, LOGS_DIR } from "./paths.js";
import { takeSlot } from "./slots.js";

/** Prefijo de los estados que publica el runner: así se distinguen de los de la CI del host. */
export const LOCAL_CHECK_PREFIX = "Backcode · ";
/** Dónde se pasan los checks del proyecto: la CI del host (por defecto), el runner o ninguno (sin CI). */
export type ChecksMode = "host" | "local" | "none";

/** El modo del documento del proyecto: sin campo o con un valor desconocido, la CI del host. */
export function parseChecksMode(v: unknown): ChecksMode {
  return v === "local" || v === "none" ? v : "host";
}

/**
 * Cómo se comprueba un PR antes de mergearlo: "skip" (sin esperar ni pasar checks), "local" (el runner), "host" (su CI)
 * o "blocked" (sin CI pero no se puede mergear sin checks: el modo auto nunca lo hace y «Exigir checks» lo prohíbe).
 * `skipChecks`: «Merge sense CI» de un admin, solo ese merge. `local`: con modo host, si Actions está pausado por
 * Backcode y el repo declara checks locales.
 */
export function mergeChecksPlan(o: { mode: ChecksMode; skipChecks: boolean; auto: boolean; requireChecks: boolean; local: boolean }): "skip" | "local" | "host" | "blocked" {
  if (o.auto) return o.mode === "none" ? "blocked" : o.mode === "local" || o.local ? "local" : "host";
  if (o.skipChecks) return "skip";
  if (o.mode === "none") return o.requireChecks ? "blocked" : "skip";
  return o.mode === "local" || o.local ? "local" : "host";
}

/** El host rechazó el merge por la protección de la rama (checks o revisiones obligatorias), no por un fallo temporal. */
export function isBranchProtectionError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /required status check|base branch policy|protected branch|branch protection|approving review|merge checks? (failed|not satisfied)|unresolved (merge )?checks/i.test(msg);
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_TIMEOUT_MIN = 20;
/** Minutos sin ninguna salida tras los que un check se da por colgado (un typecheck sano calla segundos, no minutos). */
const DEFAULT_IDLE_MIN = 5;
/** Lo que cabe del log en el resultado de la acción (como CHECK_LOG_MAX de check-logs.ts). */
const LOG_MAX = 3000;

export interface LocalCheck {
  name: string;
  /** Carpeta donde se ejecuta, relativa al repo ("" = raíz). */
  dir: string;
  cmd: string[];
  install: boolean;
  timeoutMs: number;
  /** Sin escribir nada durante esto, se da por colgado y se corta (aunque no haya llegado a `timeoutMs`). */
  idleMs: number;
  /** De qué depende, relativo al repo (carpetas o ficheros). Vacío: de todo el repo. */
  paths: string[];
  description?: string;
}

export const statusName = (check: Pick<LocalCheck, "name">) => `${LOCAL_CHECK_PREFIX}${check.name}`;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
const inside = (p: string) => !p.split("/").includes("..") && !p.startsWith("/");

/** Los checks `[check.<nombre>]` de un backcode.toml. */
export function readCheckConfig(text: string): { checks: LocalCheck[]; errors: string[] } {
  const parsed = parseToml(text);
  const errors: string[] = [];
  const checks: LocalCheck[] = [];
  for (const [key, d] of Object.entries(parsed.tables)) {
    if (!key.startsWith("check.")) continue;
    const name = key.slice("check.".length);
    if (!NAME_RE.test(name)) {
      errors.push(`[check.${name}]: nombre no válido (minúsculas, números y guiones)`);
      continue;
    }
    const run = d.run;
    const cmd = typeof run === "string" && run.trim() ? ["sh", "-c", run] : Array.isArray(run) && run.length && run.every((x) => typeof x === "string" && x) ? run : null;
    if (!cmd) {
      errors.push(`[check.${name}]: falta «run» (un comando o una lista)`);
      continue;
    }
    const dir = typeof d.dir === "string" ? norm(d.dir) : "";
    if (!inside(dir)) {
      errors.push(`[check.${name}]: «dir» tiene que estar dentro del repo`);
      continue;
    }
    const minutes = typeof d.timeout === "number" && d.timeout >= 1 ? Math.min(60, d.timeout) : DEFAULT_TIMEOUT_MIN;
    const idle = typeof d.idle === "number" && d.idle >= 1 ? Math.min(60, d.idle) : DEFAULT_IDLE_MIN;
    const description = typeof d.description === "string" ? d.description.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const paths = Array.isArray(d.paths) && d.paths.every((p) => typeof p === "string") ? (d.paths as string[]).map(norm).filter((p) => p && inside(p)) : [];
    checks.push({ name, dir, cmd, install: d.install !== false, timeoutMs: minutes * 60_000, idleMs: idle * 60_000, paths, ...(description ? { description } : {}) });
  }
  return { checks, errors };
}

/** Los checks declarados en el backcode.toml de la raíz en `ref` (vacío si no hay fichero o no declara ninguno). */
export async function localChecksAt(repoPath: string, ref: string): Promise<LocalCheck[]> {
  const text = await git(repoPath, ["show", `${ref}:backcode.toml`]).catch(() => "");
  if (!text) return [];
  const { checks, errors } = readCheckConfig(text);
  for (const e of errors) console.warn(`\x1b[33m⚠ backcode.toml ${e}\x1b[0m`);
  return checks;
}

const LOCKFILES: [string, string[]][] = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
  ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci", "--no-audit", "--no-fund"]],
  ["npm-shrinkwrap.json", ["npm", "ci", "--no-audit", "--no-fund"]],
];

/** Qué instalar antes de un check: la carpeta con lockfile más cercana (subiendo hasta la raíz) y su comando. */
export function installFor(wt: string, dir: string): { dir: string; cmd: string[] } | null {
  for (let d = dir; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    const lock = LOCKFILES.find(([f]) => existsSync(join(wt, d, f)));
    if (lock) return { dir: d, cmd: lock[1] };
    if (!d) break;
  }
  // Un paquete sin lockfile: se instala como lo haría cualquiera a mano.
  return existsSync(join(wt, dir, "package.json")) ? { dir, cmd: ["npm", "install", "--no-audit", "--no-fund"] } : null;
}

// Variables de entorno que pasan a los checks: las del sistema y las de los gestores de versiones (Node, Java…), nunca
// tokens ni claves del entorno del runner.
const KEEP_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TZ|TMPDIR|TERM|JAVA_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|NVM_[A-Z_]+|VOLTA_HOME|ASDF_[A-Z_]+|PNPM_HOME|BUN_INSTALL|COREPACK_[A-Z_]+|npm_config_cache)$/;

export function checkEnv(wt: string, cwd: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && KEEP_ENV.test(k)) env[k] = v;
  env.PATH = [join(cwd, "node_modules", ".bin"), join(wt, "node_modules", ".bin"), env.PATH ?? "/usr/bin:/bin"].join(":");
  env.CI = "1";
  return env;
}

/** Lo que se espera tras SIGTERM a que el árbol de procesos de un check termine antes de mandarle SIGKILL. */
const KILL_GRACE_MS = 10_000;

/** Los descendientes de `root` (hijos, nietos…), aunque estén en otro grupo de procesos. Vacío si no se puede leer. */
function descendants(root: number): Promise<number[]> {
  return new Promise((resolve) => {
    // Sin poder lanzar `ps` (EPERM en un sandbox…), solo se para el grupo del check: mejor eso que lanzar.
    try {
      execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      const kids = new Map<number, number[]>();
      for (const line of String(out).split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid && ppid) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
      }
      const found: number[] = [];
      const stack = [...(kids.get(root) ?? [])];
      while (stack.length) {
        const pid = stack.pop()!;
        found.push(pid);
        stack.push(...(kids.get(pid) ?? []));
      }
      resolve(found);
      });
    } catch {
      resolve([]);
    }
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    /* ya no existe */
  }
};

/**
 * Para un check y todo lo que lanzó: su grupo de procesos y además cada descendiente, porque algunas herramientas sacan
 * procesos a un grupo propio (los emuladores de Firebase se lanzan con `detached`) y sobrevivirían ocupando sus puertos.
 * SIGTERM primero (para que cierren limpio) y, si a los `graceMs` sigue alguno, SIGKILL. Vuelve cuando no queda ninguno.
 */
export async function killTree(pid: number, graceMs = KILL_GRACE_MS): Promise<void> {
  const pids = [pid, ...(await descendants(pid))];
  signal(-pid, "SIGTERM");
  for (const p of pids) signal(p, "SIGTERM");
  const until = Date.now() + graceMs;
  while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  // Lo que lanzaron mientras tanto también cuenta (otra pasada de descendientes de los que siguen vivos).
  for (const p of pids.filter(alive)) pids.push(...(await descendants(p)));
  signal(-pid, "SIGKILL");
  for (const p of pids) if (alive(p)) signal(p, "SIGKILL");
  // SIGKILL no se puede ignorar, pero el sistema tarda un instante en retirarlos: se espera un poco (puertos libres).
  const reaped = Date.now() + 2000;
  while (pids.some(alive) && Date.now() < reaped) await new Promise((r) => setTimeout(r, 50));
}

/**
 * Ejecuta un comando y devuelve si salió bien y su salida (las últimas 200 000 letras). Si tarda más de `timeoutMs` o se
 * aborta `abort`, mata su árbol de procesos entero (killTree) antes de volver. Nunca lanza.
 */
export function runCommand([cmd, ...args]: string[], cwd: string, env: Record<string, string>, timeoutMs: number, abort?: AbortSignal, opts: { graceMs?: number; idleMs?: number } = {}): Promise<{ ok: boolean; out: string }> {
  if (abort?.aborted) return Promise.resolve({ ok: false, out: t("lc.aborted") });
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let stopping = false;
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const finish = (ok: boolean, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      abort?.removeEventListener("abort", onAbort);
      resolve({ ok, out: out + extra });
    };
    const stop = (why: string) => {
      if (stopping || done) return;
      stopping = true;
      void (child.pid ? killTree(child.pid, opts.graceMs) : Promise.resolve(child.kill("SIGTERM"))).catch(() => undefined).finally(() => finish(false, `\n${why}`));
    };
    const onAbort = () => stop(t("lc.aborted"));
    let lastOutput = Date.now();
    const add = (d: Buffer) => {
      lastOutput = Date.now();
      out = (out + d.toString()).slice(-200_000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => stop(t("lc.timeout", { min: Math.round(timeoutMs / 60_000) })), timeoutMs);
    // Colgado: lleva `idleMs` sin escribir nada (p. ej. un emulador que no arranca). Se mira cada pocos segundos.
    const idleMs = opts.idleMs;
    const idleTimer = setInterval(() => {
      if (idleMs && Date.now() - lastOutput >= idleMs) stop(t("lc.idle", { min: Math.max(1, Math.round(idleMs / 60_000)) }));
    }, idleMs ? Math.min(5000, Math.max(50, idleMs / 4)) : 60_000);
    abort?.addEventListener("abort", onAbort);
    child.on("error", (e) => finish(false, `\n${e.message}`));
    // Si se está parando, se espera a que killTree acabe (que los puertos queden libres para el siguiente).
    child.on("close", (code) => !stopping && finish(code === 0));
  });
}

/** Dónde quedan las salidas completas de los checks que fallaron (las últimas FAILED_LOGS_KEEP). */
export const FAILED_LOGS_DIR = join(LOGS_DIR, "checks");
const FAILED_LOGS_KEEP = 30;

/**
 * Guarda la salida entera (sin colores ni líneas que parezcan secretos) de un check que falló, para poder ver después qué
 * pasó aunque el runner se reinicie: ~/.backcode/logs/checks/<fecha>-<sha>-<nombre>.log. Devuelve la ruta o "" si no pudo.
 */
export function saveFailedLog(name: string, sha: string, out: string, dir = FAILED_LOGS_DIR): string {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha.slice(0, 7)}-${name}.log`);
    writeFileSync(file, cleanOutput(out, 200_000) + "\n");
    const old = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(FAILED_LOGS_KEEP);
    for (const o of old) rmSync(join(dir, o.f), { force: true });
    return file;
  } catch {
    return "";
  }
}

/** Huecos de lotes de checks en este ordenador, compartidos por todos los runners (como ~/.backcode/slots con las tareas). */
export const CHECK_SLOTS_DIR = join(HOME_DIR, "check-slots");
export const CHECK_RUNS_MAX = 2;
const CHECK_SLOT_POLL_MS = 2000;

/**
 * Espera a que haya hueco (menos de `max` lotes en marcha en el ordenador) y lo coge; devuelve la función que lo suelta.
 * Si se aborta mientras espera, deja de esperar sin hueco (lo que venga después no arranca: runCommand ve el abort).
 */
export async function takeCheckSlot(dir: string, max: number, abort?: AbortSignal, onWait?: () => void, pollMs = CHECK_SLOT_POLL_MS): Promise<() => void> {
  const id = `${process.pid}x${Math.random().toString(36).slice(2, 10)}`;
  let warned = false;
  for (;;) {
    const release = takeSlot(dir, "checks", id, max);
    if (release) return release;
    if (abort?.aborted) return () => undefined;
    if (!warned) {
      warned = true;
      onWait?.();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// El mismo check de un repo no se ejecuta dos veces a la vez en este ordenador (dos PR, un merge y una verificación…):
// suelen usar recursos fijos, como los puertos de los emuladores de Firebase, y se pisarían. El siguiente espera su turno.
const checkQueues = new Map<string, Promise<unknown>>();

/** Ejecuta `fn` cuando no haya en marcha otro `key`; `onWait` avisa si le toca esperar. */
export function oneAtATime<T>(key: string, fn: () => Promise<T>, onWait?: () => void): Promise<T> {
  const prev = checkQueues.get(key);
  if (prev) onWait?.();
  const p = (prev ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = p.catch(() => undefined);
  checkQueues.set(key, tail);
  void tail.then(() => checkQueues.get(key) === tail && checkQueues.delete(key));
  return p;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Final de la salida de un check que falló: sin colores, sin líneas vacías ni que parezcan secretos. */
export function cleanOutput(out: string, max: number): string {
  const lines = out.replace(ANSI, "").replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !looksSecret(l));
  const text = lines.join("\n");
  return text.length > max ? `…\n${text.slice(text.length - max + 2)}` : text;
}

/** Última línea con texto (la descripción corta del estado). */
const lastLine = (out: string) => cleanOutput(out, 400).split("\n").pop() ?? "";

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export interface LocalRun {
  /** Resultado de los checks locales (solo los «Backcode · …»); "none" si el repo no declara ninguno. */
  checks: Checks;
  /** Final de la salida de los que fallaron (para la app y para «Devolver a Claude Code»). */
  log: string;
}

export interface LocalRunDeps {
  repoPath: string;
  worktreesDir: string;
  host: PrHost | undefined;
  /** El commit que se comprueba (p. ej. el PR mezclado con la base: mergedCommit, que solo existe en local). */
  sha: string;
  /**
   * Dónde se publican los estados «Backcode · …» si no es `sha` (la cabeza del PR, que sí está en el host). Entonces los
   * estados que ya tenga ese commit no cuentan (eran de la rama sola o de otra base): solo la caché por contenido.
   */
  publishSha?: string;
  /** Los checks a ejecutar (leídos de la rama base: localChecksAt). */
  checks: LocalCheck[];
  /** Inyectable para los tests. */
  run?: (cmd: string[], cwd: string, env: Record<string, string>, timeoutMs: number, abort?: AbortSignal, opts?: { idleMs?: number }) => Promise<{ ok: boolean; out: string }>;
  /** Hueco de checks en este ordenador (por defecto, ~/.backcode/check-slots con CHECK_RUNS_MAX). Inyectable para tests. */
  slot?: (abort: AbortSignal) => Promise<() => void>;
  worktree?: (sha: string) => Promise<string>;
  cleanup?: (wt: string) => Promise<void>;
  /** Lo ya comprobado en este ordenador (por defecto, ~/.backcode/checks-cache.json). */
  cache?: ChecksCache;
  /** Clave de contenido de un check en `sha` (por defecto, checkKey con git). */
  key?: (check: LocalCheck) => Promise<string | null>;
  /**
   * Para dejarlo a medias (la verificación al acabar una tarea que se cansa de esperar): los checks en marcha se matan y
   * los que esperaban turno no arrancan. Si otra acción comparte la misma ejecución sin poder abortarla, sigue.
   */
  signal?: AbortSignal;
}

// Dos acciones a la vez sobre el mismo commit (un merge y un despliegue, dos merges seguidos) comparten la ejecución.
// Solo se aborta cuando todas las que la comparten lo han pedido (una sin `signal` no lo pide nunca).
const running = new Map<string, { p: Promise<LocalRun>; ctrl: AbortController; live: number }>();
// El log de lo último que falló en local en cada PR: «Devolver a Claude Code» se lo pasa a Claude (check-logs.ts › failingLog).
const prLogs = new Map<string, string>();

/** Guarda (o, sin log, olvida) el log de los checks locales que fallaron en un PR. */
export function rememberPrLog(prUrl: string, log: string): void {
  if (log) prLogs.set(prUrl, log);
  else prLogs.delete(prUrl);
}

/** El log de los checks locales que fallaron en el PR en este runner, o "". */
export function prLocalLog(prUrl: string): string {
  return prLogs.get(prUrl) ?? "";
}

/**
 * Pasa los checks locales en `sha`: los que ya constan en verde en ese commit no se repiten; los demás se ejecutan uno
 * detrás de otro en una copia limpia del commit y cada resultado se publica en él («Backcode · <nombre>»).
 */
export function runLocalChecks(d: LocalRunDeps): Promise<LocalRun> {
  if (!d.checks.length) return Promise.resolve({ checks: { state: "none", pending: [] }, log: "" });
  const key = `${d.repoPath}@${d.sha}`;
  let entry = running.get(key);
  if (!entry) {
    const ctrl = new AbortController();
    const fresh: { p: Promise<LocalRun>; ctrl: AbortController; live: number } = { p: Promise.resolve(null as unknown as LocalRun), ctrl, live: 0 };
    fresh.p = doRun(d, ctrl.signal).finally(() => running.get(key) === fresh && running.delete(key));
    running.set(key, fresh);
    entry = fresh;
  }
  const joined = entry;
  joined.live++;
  if (d.signal) {
    const leave = () => --joined.live === 0 && joined.ctrl.abort();
    if (d.signal.aborted) leave();
    else d.signal.addEventListener("abort", leave, { once: true });
  }
  return joined.p;
}

async function doRun(d: LocalRunDeps, abort: AbortSignal): Promise<LocalRun> {
  const publish = async (check: LocalCheck, state: CheckItem["state"], description: string) => {
    await d.host?.setStatus?.(d.publishSha ?? d.sha, { name: statusName(check), state, description }).catch((e: Error) => console.warn(`\x1b[33m⚠ ${t("lc.publishFail", { name: check.name, error: e.message.split("\n")[0] })}\x1b[0m`));
  };
  const cache = d.cache ?? fileChecksCache();
  const keyOf = d.key ?? ((c: LocalCheck) => checkKey(d.repoPath, d.sha, c));
  // Los que ya pasaron en este commit (estado en el host) o con el mismo contenido (caché local) no se repiten.
  const own = !d.publishSha || d.publishSha === d.sha;
  const existing = own ? ((await d.host?.commitItems?.(d.sha).catch(() => [] as CheckItem[])) ?? []) : [];
  const before = new Map(existing.map((i) => [i.name, i.state]));
  const keys = new Map<LocalCheck, string | null>();
  for (const c of d.checks) keys.set(c, await keyOf(c).catch(() => null));
  const items: CheckItem[] = [];
  const todo: LocalCheck[] = [];
  for (const c of d.checks) {
    const key = keys.get(c);
    if (before.get(statusName(c)) === "ok") {
      items.push({ name: statusName(c), state: "ok" });
      if (key) cache.remember(key);
    } else if (key && cache.has(key)) {
      items.push({ name: statusName(c), state: "ok" });
      console.log(`[checks] ${statusName(c)}: ${t("lc.cached")}`);
      await publish(c, "ok", t("lc.cachedStatus"));
    } else todo.push(c);
  }
  if (!todo.length) return { checks: summarize(items), log: "" };

  console.log(`[checks] ${t("lc.start", { n: todo.length, sha: d.sha.slice(0, 7) })}`);
  await Promise.all(todo.map((c) => publish(c, "pending", t("lc.pending"))));
  const run = d.run ?? runCommand;
  // Como mucho CHECK_RUNS_MAX lotes de checks a la vez en este ordenador (todos los proyectos y runners): un merge solo
  // sigue pasando sus checks a la vez; el tercero que coincide espera a que acabe uno (con la máquina saturada todos
  // irían más lentos y los emuladores llegan a colgarse).
  // (Con `run` inyectado, en los tests, sin hueco salvo que se pase `slot`.)
  const takeOne = d.slot ?? (d.run ? async () => () => undefined : (signal: AbortSignal) => takeCheckSlot(CHECK_SLOTS_DIR, CHECK_RUNS_MAX, signal, () => console.log(`[checks] ${t("lc.waitMachine", { n: CHECK_RUNS_MAX })}`)));

  const release = await takeOne(abort);
  const wt = await (d.worktree ?? ((sha) => createDetachedWorktree(d.repoPath, d.worktreesDir, `_checks-${sha.slice(0, 12)}`, sha)))(d.sha).catch((e: unknown) => {
    release();
    throw e;
  });
  const logs: string[] = [];
  try {
    // Las dependencias de cada carpeta se instalan una vez aunque varios checks las usen, y todos van a la vez.
    const installs = new Map<string, Promise<{ ok: boolean; out: string }>>();
    const results = await Promise.all(
      todo.map(async (c) => {
        const started = Date.now();
        const cwd = join(wt, c.dir);
        let res: { ok: boolean; out: string };
        if (!existsSync(cwd)) res = { ok: false, out: t("lc.noDir", { dir: c.dir }) };
        else {
          const inst = c.install ? installFor(wt, c.dir) : null;
          let installRes: { ok: boolean; out: string } = { ok: true, out: "" };
          if (inst) {
            if (!installs.has(inst.dir)) installs.set(inst.dir, run(inst.cmd, join(wt, inst.dir), checkEnv(wt, join(wt, inst.dir)), c.timeoutMs, abort));
            installRes = await installs.get(inst.dir)!;
          }
          res = installRes.ok
            ? await oneAtATime(`${d.repoPath}#${c.name}`, () => run(c.cmd, cwd, checkEnv(wt, cwd), c.timeoutMs, abort, { idleMs: c.idleMs }), () => console.log(`[checks] ${statusName(c)}: ${t("lc.waitTurn")}`))
            : { ok: false, out: `${t("lc.installFail", { dir: inst?.dir || "." })}\n${installRes.out}` };
        }
        return { c, res, took: duration(Date.now() - started) };
      }),
    );
    for (const { c, res, took } of results) {
      console.log(`[checks] ${statusName(c)}: ${res.ok ? "ok" : "fail"} (${took})`);
      items.push({ name: statusName(c), state: res.ok ? "ok" : "fail" });
      if (res.ok) {
        const key = keys.get(c);
        if (key) cache.remember(key);
        await publish(c, "ok", t("lc.ok", { took }));
      } else {
        await publish(c, "fail", `${t("lc.fail", { took })} ${lastLine(res.out)}`.trim());
        const saved = d.run ? "" : saveFailedLog(c.name, d.publishSha ?? d.sha, res.out);
        if (saved) console.log(`[checks] ${statusName(c)}: ${t("lc.savedLog", { file: saved })}`);
        logs.push(`## ${statusName(c)}\n${cleanOutput(res.out, LOG_MAX)}`);
      }
    }
  } finally {
    release();
    await (d.cleanup ?? (async (path: string) => {
      await removeWorktree(d.repoPath, path);
      rmSync(path, { recursive: true, force: true });
    }))(wt);
  }
  const joined = logs.join("\n\n");
  const log = joined.length > LOG_MAX ? `…\n${joined.slice(joined.length - LOG_MAX + 2)}` : joined;
  return { checks: summarize(items), log };
}

/**
 * ¿Están en rojo solo checks que no llegaron a ejecutarse? (GitHub Actions sin minutos o con un pago fallido.) Entonces la
 * app ofrece «Pasar los checks en local». Si alguno falló de verdad o sigue en curso, no.
 */
export async function onlyNotStarted(host: PrHost, prUrl: string, checks: Checks): Promise<boolean> {
  return onlyNotStartedIn(host.notStarted ? () => host.notStarted!(prUrl) : undefined, checks);
}

/** Como onlyNotStarted, con la lista de los que no arrancaron de donde sea (un PR o un commit). */
export async function onlyNotStartedIn(read: (() => Promise<string[]>) | undefined, checks: Checks): Promise<boolean> {
  if (checks.state !== "failing" || !read) return false;
  const failing = checks.pending.filter((p) => p.endsWith(": fail")).map((p) => p.slice(0, -": fail".length));
  if (checks.pending.some((p) => !p.endsWith(": fail") && !p.startsWith(LOCAL_CHECK_PREFIX))) return false;
  const notStarted = new Set(await read().catch(() => [] as string[]));
  return failing.length > 0 && failing.every((n) => notStarted.has(n) || n.startsWith(LOCAL_CHECK_PREFIX));
}
