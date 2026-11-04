// Checks en local: en vez de (o además de) la CI de GitHub/Bitbucket, el runner ejecuta en este ordenador los comandos de
// comprobación del repo sobre un commit y publica cada resultado en él como un estado «Backcode · <nombre>» (sale en el
// PR como un check más). Son comandos de shell fijos, sin Claude: no gastan tokens.
//
//   [check.app]
//   run = "npm run typecheck && npm run lint"   # el comando (con sh -c) o una lista ["make", "test"] (sin shell)
//   dir = "app"                                 # opcional: carpeta, relativa a la raíz; por defecto la raíz
//   install = true                              # opcional: instalar antes las dependencias de esa carpeta (por defecto sí)
//   timeout = 20                                # opcional: minutos (1-60, por defecto 20)
//   paths = ["app", "firestore.rules"]          # opcional: de qué depende (carpetas o ficheros); por defecto, todo el repo
//   description = "Tipos y lint de la app"      # opcional
//
// Rápidos: se ejecutan a la vez, y un check que ya pasó con el mismo contenido de sus `paths` (el mismo commit, el squash
// de un PR ya comprobado o un PR que no los toca) no se repite: checks-cache.ts lo recuerda en este ordenador.
//
// Los comandos se leen del backcode.toml de la rama base (no del PR): un PR no puede rebajar lo que se comprueba.
// Se usan en dos casos: el proyecto tiene «Checks en local» (checksMode = "local") o, con la CI del host, alguien pide
// «Pasar los checks en local» porque los checks de GitHub no llegaron a ejecutarse (Actions sin minutos o pago fallido).
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { looksSecret } from "./diagnostics.js";
import { parseToml } from "./deploy-config.js";
import { checkKey, type ChecksCache, fileChecksCache } from "./checks-cache.js";
import { createDetachedWorktree, git, removeWorktree } from "./git.js";
import { type Checks, type CheckItem, type PrHost, summarize } from "./hosts.js";
import { t } from "./i18n.js";

/** Prefijo de los estados que publica el runner: así se distinguen de los de la CI del host. */
export const LOCAL_CHECK_PREFIX = "Backcode · ";
/** Dónde se pasan los checks del proyecto: la CI del host (por defecto) o el runner. */
export type ChecksMode = "host" | "local";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_TIMEOUT_MIN = 20;
/** Lo que cabe del log en el resultado de la acción (como CHECK_LOG_MAX de check-logs.ts). */
const LOG_MAX = 3000;

export interface LocalCheck {
  name: string;
  /** Carpeta donde se ejecuta, relativa al repo ("" = raíz). */
  dir: string;
  cmd: string[];
  install: boolean;
  timeoutMs: number;
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
    const description = typeof d.description === "string" ? d.description.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const paths = Array.isArray(d.paths) && d.paths.every((p) => typeof p === "string") ? (d.paths as string[]).map(norm).filter((p) => p && inside(p)) : [];
    checks.push({ name, dir, cmd, install: d.install !== false, timeoutMs: minutes * 60_000, paths, ...(description ? { description } : {}) });
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

/** Ejecuta un comando y devuelve si salió bien y su salida (las últimas 200 000 letras). Nunca lanza. */
function runCommand([cmd, ...args]: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const finish = (ok: boolean, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, out: out + extra });
    };
    const add = (d: Buffer) => (out = (out + d.toString()).slice(-200_000));
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      finish(false, `\n${t("lc.timeout", { min: Math.round(timeoutMs / 60_000) })}`);
    }, timeoutMs);
    child.on("error", (e) => finish(false, `\n${e.message}`));
    child.on("close", (code) => finish(code === 0));
  });
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
  /** El commit que se comprueba. */
  sha: string;
  /** Los checks a ejecutar (leídos de la rama base: localChecksAt). */
  checks: LocalCheck[];
  /** Inyectable para los tests. */
  run?: (cmd: string[], cwd: string, env: Record<string, string>, timeoutMs: number) => Promise<{ ok: boolean; out: string }>;
  worktree?: (sha: string) => Promise<string>;
  cleanup?: (wt: string) => Promise<void>;
  /** Lo ya comprobado en este ordenador (por defecto, ~/.backcode/checks-cache.json). */
  cache?: ChecksCache;
  /** Clave de contenido de un check en `sha` (por defecto, checkKey con git). */
  key?: (check: LocalCheck) => Promise<string | null>;
}

// Dos acciones a la vez sobre el mismo commit (un merge y un despliegue, dos merges seguidos) comparten la ejecución.
const running = new Map<string, Promise<LocalRun>>();
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
  const current = running.get(key);
  if (current) return current;
  const p = doRun(d).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

async function doRun(d: LocalRunDeps): Promise<LocalRun> {
  const publish = async (check: LocalCheck, state: CheckItem["state"], description: string) => {
    await d.host?.setStatus?.(d.sha, { name: statusName(check), state, description }).catch((e: Error) => console.warn(`\x1b[33m⚠ ${t("lc.publishFail", { name: check.name, error: e.message.split("\n")[0] })}\x1b[0m`));
  };
  const cache = d.cache ?? fileChecksCache();
  const keyOf = d.key ?? ((c: LocalCheck) => checkKey(d.repoPath, d.sha, c));
  // Los que ya pasaron en este commit (estado en el host) o con el mismo contenido (caché local) no se repiten.
  const existing = (await d.host?.commitItems?.(d.sha).catch(() => [] as CheckItem[])) ?? [];
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
  const wt = await (d.worktree ?? ((sha) => createDetachedWorktree(d.repoPath, d.worktreesDir, `_checks-${sha.slice(0, 12)}`, sha)))(d.sha);
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
            if (!installs.has(inst.dir)) installs.set(inst.dir, run(inst.cmd, join(wt, inst.dir), checkEnv(wt, join(wt, inst.dir)), c.timeoutMs));
            installRes = await installs.get(inst.dir)!;
          }
          res = installRes.ok ? await run(c.cmd, cwd, checkEnv(wt, cwd), c.timeoutMs) : { ok: false, out: `${t("lc.installFail", { dir: inst?.dir || "." })}\n${installRes.out}` };
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
        logs.push(`## ${statusName(c)}\n${cleanOutput(res.out, LOG_MAX)}`);
      }
    }
  } finally {
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
