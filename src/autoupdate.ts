import { execFile } from "node:child_process";
import { relative } from "node:path";
import { KIT_DIR } from "./config.js";
import { t } from "./i18n.js";

/** Cada cuánto se mira si hay versión nueva del runner (una consulta mínima al remoto, sin descargar código). */
export const UPDATE_EVERY_MS = 2 * 60_000;
/** Código de salida con el que un runner pide a `npm run all` que lo vuelva a lanzar (ya con la versión nueva). */
export const RESTART_CODE = 75;

let warned = "";

/**
 * Actualiza el runner si su rama remota tiene commits nuevos: `git pull --ff-only` (solo si la copia está limpia),
 * `npm install` si cambiaron las dependencias, comprobación de tipos y build. Devuelve true si hay versión nueva lista
 * (hay que reiniciar para usarla). Si algo no cuadra (cambios locales, no es un avance limpio, no compila) avisa una vez
 * y sigue con la versión actual: nunca deja el runner roto.
 */
export async function updateIfAvailable(): Promise<boolean> {
  const root = await git(["rev-parse", "--show-toplevel"]).catch(() => "");
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "");
  if (!root || !upstream.includes("/")) return false;
  const [remote, ...rest] = upstream.split("/");
  const branch = rest.join("/");
  const remoteSha = (await git(["ls-remote", remote, `refs/heads/${branch}`]).catch(() => "")).split(/\s/)[0];
  if (!remoteSha) return false;
  const local = await git(["rev-parse", "HEAD"]);
  if (local === remoteSha || (await git(["merge-base", "--is-ancestor", remoteSha, "HEAD"]).then(() => true, () => false))) return false;

  if ((await git(["status", "--porcelain", "--untracked-files=no"])).trim()) return warnOnce("dirty", t("update.dirty"));
  if (!(await git(["pull", "--ff-only", "--quiet"]).then(() => true, () => false))) return warnOnce(remoteSha, t("update.notFf"));

  // En un monorepo (el runner dentro de otro repo) no todos los commits tocan al runner.
  const dir = relative(root, KIT_DIR) || ".";
  const changed = (await git(["diff", "--name-only", `${local}..HEAD`, "--", dir])).split("\n").filter(Boolean);
  if (!changed.length) return false;
  console.log(`[backcode] ${t("update.found", { n: changed.length })}`);
  if (changed.some((f) => /(^|\/)package(-lock)?\.json$/.test(f))) await run("npm", ["install", "--no-audit", "--no-fund"]);
  if (!(await run("npx", ["tsc", "--noEmit"]).then(() => true, () => false))) return warnOnce(`tsc-${remoteSha}`, t("update.broken"));
  await run("npm", ["run", "build"]);
  console.log(`[backcode] ${t("update.ready")}`);
  return true;
}

function warnOnce(key: string, message: string): false {
  if (warned !== key) console.warn(`\x1b[33m⚠ ${message}\x1b[0m`);
  warned = key;
  return false;
}

function git(args: string[]): Promise<string> {
  return run("git", args).then((s) => s.trim());
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: KIT_DIR, maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}
