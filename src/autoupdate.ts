import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { VERSION } from "./assets.js";
import { KIT_DIR } from "./config.js";
import { t } from "./i18n.js";
import { APP_DIR, FROM_NPM, IS_BINARY, MANAGED, selfCommand } from "./paths.js";

export { VERSION } from "./assets.js";

/** Cada cuánto se mira si hay versión nueva del runner (una consulta mínima al remoto, sin descargar código). */
export const UPDATE_EVERY_MS = 2 * 60_000;
/** En npm, el registro se consulta con menos frecuencia. */
const NPM_EVERY_MS = 30 * 60_000;
/** Las Releases de GitHub (ejecutable sin Node), más a menudo: una versión nueva llega en minutos, no en media hora. */
const BINARY_EVERY_MS = 5 * 60_000;
/** Código de salida con el que un runner pide a su supervisor (panel, `npm run all`) que lo vuelva a lanzar (ya con la versión nueva). */
export const RESTART_CODE = 75;
/**
 * Línea con la que un runner supervisado anuncia que va a salir (y con qué código), justo antes de process.exit: el
 * ejecutable de Bun a veces no termina con process.exit y se queda dormido; el supervisor lo remata (supervisor.ts).
 */
export const EXIT_MARK = "@@backcode:exit ";
/** Sale; si es un runner supervisado, avisando antes al supervisor (ver EXIT_MARK). */
export function exitSupervised(code: number): never {
  if (process.env.BACKCODE_SUPERVISED === "1") console.log(`${EXIT_MARK}${code}`);
  process.exit(code);
}
export const PACKAGE_NAME = "backcode";
/** Repositorio de GitHub con las versiones del ejecutable sin Node (Releases). */
export const RELEASES_REPO = "hernanmateo/backcode-runner";

/**
 * Cómo se actualiza esta copia: el ejecutable desde GitHub Releases, git pull, npm en ~/.backcode/app, o nada (npx o
 * global: solo se avisa).
 */
export const UPDATE_MODE: "binary" | "git" | "managed" | "manual" = IS_BINARY ? "binary" : !FROM_NPM ? "git" : MANAGED ? "managed" : "manual";
/** Última versión publicada en npm (si se ha podido consultar). */
export let latestVersion: string | undefined;

let warned = "";
let lastNpmCheck = 0;

/**
 * Actualiza el runner si hay versión nueva. Devuelve true si está lista (hay que reiniciar para usarla). Si algo no cuadra,
 * avisa una vez y sigue con la versión actual: nunca deja el runner roto.
 */
export async function updateIfAvailable(opts: { force?: boolean } = {}): Promise<boolean> {
  if (UPDATE_MODE === "git") return updateFromGit();
  if (UPDATE_MODE === "binary") {
    if (!opts.force && Date.now() - lastNpmCheck < BINARY_EVERY_MS) return false;
    lastNpmCheck = Date.now();
    return updateBinary();
  }
  if (!opts.force && Date.now() - lastNpmCheck < NPM_EVERY_MS) return false;
  lastNpmCheck = Date.now();
  return updateFromNpm();
}

/** 1.10.0 > 1.9.3 (sin prereleases: solo se publican versiones normales). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/**
 * npm: consulta la última versión en el registro. En la instalación propia (~/.backcode/app) la instala ahí (sin permisos
 * de administrador) y comprueba que arranca; con npx o una instalación global solo avisa de cómo actualizar.
 */
async function updateFromNpm(): Promise<boolean> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return false;
  const latest = ((await res.json()) as { version?: string }).version;
  if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) return false;
  latestVersion = latest;
  if (!newer(latest, VERSION)) return false;
  if (UPDATE_MODE === "manual") return warnOnce(`manual-${latest}`, t("update.manual", { version: latest }));
  console.log(`[backcode] ${t("update.npmFound", { version: latest })}`);
  const ok = await run("npm", ["install", "--prefix", APP_DIR, `${PACKAGE_NAME}@${latest}`, "--no-audit", "--no-fund"], APP_DIR).then(() => true, () => false);
  if (!ok) return warnOnce(`npm-${latest}`, t("update.npmFailed", { version: latest }));
  // La copia nueva tiene que arrancar (y ser la que se pidió) antes de reiniciar con ella.
  const installed = await run(...selfCommand(["--version"]), APP_DIR).then((s) => s.trim(), () => "");
  if (installed !== latest) return warnOnce(`npm-${latest}`, t("update.broken"));
  console.log(`[backcode] ${t("update.ready")}`);
  return true;
}

/** Nombre del ejecutable de esta plataforma en las Releases (backcode-darwin-arm64…). */
export const binaryAsset = () => `backcode-${process.platform}-${process.arch}`;

/**
 * Ejecutable sin Node: consulta la última Release, descarga el de esta plataforma, comprueba su SHA-256 contra SHA256SUMS
 * y que arranca con la versión esperada, y solo entonces sustituye el actual (rename atómico: el proceso en marcha sigue
 * con el suyo hasta reiniciarse).
 */
async function updateBinary(): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return false;
  const latest = ((await res.json()) as { tag_name?: string }).tag_name?.replace(/^v/, "");
  if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) return false;
  latestVersion = latest;
  if (!newer(latest, VERSION)) return false;
  console.log(`[backcode] ${t("update.npmFound", { version: latest })}`);
  const base = `https://github.com/${RELEASES_REPO}/releases/download/v${latest}`;
  const fail = () => warnOnce(`bin-${latest}`, t("update.npmFailed", { version: latest }));
  try {
    const [bin, sums] = await Promise.all([
      fetch(`${base}/${binaryAsset()}`, { signal: AbortSignal.timeout(10 * 60_000) }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
      fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))),
    ]);
    const expected = new RegExp(`^([0-9a-f]{64})\\s+\\*?${binaryAsset()}$`, "m").exec(sums)?.[1];
    const data = Buffer.from(bin);
    if (!expected || createHash("sha256").update(data).digest("hex") !== expected) return fail();
    const next = join(dirname(process.execPath), `.backcode-${latest}`);
    writeFileSync(next, data);
    chmodSync(next, 0o755);
    const ok = await run(next, ["--version"], dirname(next)).then((s) => s.trim() === latest, () => false);
    if (!ok) {
      rmSync(next, { force: true });
      return fail();
    }
    renameSync(next, process.execPath);
  } catch {
    return fail();
  }
  console.log(`[backcode] ${t("update.ready")}`);
  return true;
}

/**
 * git: si la rama remota tiene commits nuevos, `git pull --ff-only` (solo si la copia está limpia), `npm install` si
 * cambiaron las dependencias, comprobación de tipos y build.
 */
async function updateFromGit(): Promise<boolean> {
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

function run(cmd: string, args: string[], cwd = KIT_DIR): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}
