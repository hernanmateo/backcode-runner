import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PrHost } from "./hosts.js";
import { t, type Key } from "./i18n.js";

const run = promisify(execFile);

// Sin hooks de git en ningún comando que lance el runner: un hook escrito por el agente
// se ejecutaría fuera del sandbox y con tus credenciales.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...NO_HOOKS, ...args], { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Mezcla lo último de la rama base en la rama de una tarea (en su worktree), antes de retomarla. Sin conflictos queda
 * hecho el commit de merge; con conflictos el merge queda a medias (marcas <<<<<<<) para que Claude los resuelva y el
 * commit posterior lo cierre. Devuelve los ficheros en conflicto.
 */
export async function mergeBaseIntoBranch(worktree: string, remote: string, baseBranch: string): Promise<{ status: "uptodate" | "merged" | "conflicts"; files: string[] }> {
  await git(worktree, ["fetch", "--quiet", remote, baseBranch]);
  const base = `${remote}/${baseBranch}`;
  if (await git(worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).then(() => true, () => false)) return { status: "uptodate", files: [] };
  const ok = await git(worktree, ["merge", "--no-edit", "--no-verify", base]).then(() => true, () => false);
  if (ok) return { status: "merged", files: [] };
  const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
  if (!files.length) {
    // Falló por otro motivo (no por conflictos): se deja como estaba.
    await git(worktree, ["merge", "--abort"]).catch(() => undefined);
    throw new Error(t("git.mergeFail", { base }));
  }
  return { status: "conflicts", files };
}

/**
 * ¿La rama de una tarea choca con la rama base? Prueba la mezcla en una copia temporal sin commitear y la deshace.
 * Devuelve los ficheros en conflicto (vacío = se puede mergear sin problemas).
 */
export async function findConflicts(repoPath: string, worktreesDir: string, remote: string, baseBranch: string, branch: string): Promise<string[]> {
  await git(repoPath, ["fetch", "--quiet", remote, baseBranch, `${branch}:refs/remotes/${remote}/${branch}`]);
  // git >= 2.38: merge-tree lo calcula sin tocar ninguna copia de trabajo (sale con 1 si hay conflictos).
  const fast = await run("git", [...NO_HOOKS, "merge-tree", "--write-tree", "--name-only", "--no-messages", `${remote}/${baseBranch}`, `${remote}/${branch}`], { cwd: repoPath }).then(
    () => [] as string[],
    (e: { code?: number; stdout?: string }) => (e.code === 1 ? String(e.stdout ?? "").split("\n").slice(1).filter(Boolean) : null),
  );
  if (fast) return fast;
  // git más antiguo: se prueba la mezcla en una copia temporal sin commitear y se deshace.
  const path = join(worktreesDir, "_conflicts");
  mkdirSync(worktreesDir, { recursive: true });
  await removeWorktree(repoPath, path);
  await git(repoPath, ["worktree", "add", "--detach", path, `${remote}/${branch}`]);
  try {
    const clean = await git(path, ["merge", "--no-commit", "--no-ff", "--no-verify", `${remote}/${baseBranch}`]).then(() => true, () => false);
    if (clean) return [];
    return (await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
  } finally {
    await git(path, ["merge", "--abort"]).catch(() => undefined);
    await removeWorktree(repoPath, path);
  }
}

/** Sube la rama de una tarea (p. ej. tras mezclar la base sin conflictos): el PR se actualiza solo. */
export async function pushBranch(worktree: string, remote: string, branch: string): Promise<void> {
  await git(worktree, ["push", "--no-verify", "--force-with-lease", remote, `${branch}:${branch}`]);
}

/** Trae la rama base y la de una tarea del remoto. */
export async function fetchBranches(repoPath: string, remote: string, baseBranch: string, branch: string): Promise<void> {
  await git(repoPath, ["fetch", "--quiet", remote, baseBranch, `${branch}:refs/remotes/${remote}/${branch}`]);
}

/** Sha de una rama remota (sin red). */
export async function remoteSha(repoPath: string, remote: string, branch: string): Promise<string> {
  return git(repoPath, ["rev-parse", `${remote}/${branch}`]).catch(() => "");
}

export async function createWorktree(opts: {
  repoPath: string;
  worktreesDir: string;
  remote: string;
  baseBranch: string;
  featureId: string;
  branch: string;
  /** Continuar una conversación: reutiliza el worktree (o la rama publicada) en vez de empezar de la base. */
  resume?: boolean;
}): Promise<{ path: string; branch: string; resumed: boolean }> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(opts.featureId)) throw new Error(t("git.badFeatureId", { id: opts.featureId }));
  const branch = opts.branch;
  const path = join(opts.worktreesDir, opts.featureId);
  mkdirSync(opts.worktreesDir, { recursive: true });

  if (opts.resume) {
    // Mismo directorio que la sesión original: Claude Code guarda las sesiones por carpeta.
    const current = existsSync(path) ? await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "") : "";
    if (current === branch) return { path, branch, resumed: true };
    await git(opts.repoPath, ["fetch", opts.remote, opts.baseBranch]);
    const published = await git(opts.repoPath, ["ls-remote", "--heads", opts.remote, branch]).catch(() => "");
    if (published) {
      await git(opts.repoPath, ["fetch", opts.remote, `${branch}:refs/remotes/${opts.remote}/${branch}`]);
      if (existsSync(path)) await removeWorktree(opts.repoPath, path);
      await git(opts.repoPath, ["worktree", "prune"]);
      await git(opts.repoPath, ["worktree", "add", "-B", branch, path, `${opts.remote}/${branch}`]);
      return { path, branch, resumed: true };
    }
  }

  await git(opts.repoPath, ["fetch", opts.remote, opts.baseBranch]);
  if (existsSync(path)) await removeWorktree(opts.repoPath, path);
  await git(opts.repoPath, ["worktree", "prune"]);
  // -B reinicia la rama si existía de un intento anterior.
  await git(opts.repoPath, ["worktree", "add", "-B", branch, path, `${opts.remote}/${opts.baseBranch}`]);
  return { path, branch, resumed: false };
}

/**
 * Busca el icono del proyecto en el repo, leyendo de git en el commit dado (sin worktree ni ejecutar nada):
 * primero el `expo.icon` de cualquier app.json; si no, apple-touch-icon, icon, logo o favicon en PNG/JPG.
 */
/** `hint`: ruta propuesta por la IA al generar el mapa; se usa si la config de Expo no dice nada y solo si el fichero existe y es válido. */
export async function findRepoIcon(repoPath: string, commit: string, hint?: string): Promise<{ data: Buffer; contentType: string } | null> {
  const listing = await git(repoPath, ["ls-tree", "-r", "-l", commit]);
  const files = listing
    .split("\n")
    .map((line) => /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ size: Number(m[1]), path: m[2] }))
    .filter((f) => !/(^|\/)(node_modules|dist|build|\.git|Pods)\//.test(f.path));
  const show = async (path: string) => (await run("git", [...NO_HOOKS, "show", `${commit}:${path}`], { cwd: repoPath, encoding: "buffer", maxBuffer: 5 * 1024 * 1024 })).stdout as Buffer;
  const ok = (f?: { size: number; path: string }) => !!f && f.size > 512 && f.size < 2 * 1024 * 1024 && /\.(png|jpe?g)$/i.test(f.path);

  const candidates: { size: number; path: string }[] = [];
  for (const appJson of files.filter((f) => /(^|\/)app\.json$/.test(f.path))) {
    try {
      const icon = JSON.parse((await show(appJson.path)).toString("utf8"))?.expo?.icon;
      if (typeof icon !== "string") continue;
      const dir = appJson.path.includes("/") ? appJson.path.slice(0, appJson.path.lastIndexOf("/") + 1) : "";
      const target = files.find((f) => f.path === (dir + icon.replace(/^\.\//, "")));
      if (ok(target)) candidates.push(target!);
    } catch {
      // app.json no válido: se ignora
    }
  }
  // Config dinámica (app.config.js/ts): se busca el `icon: "./…"` de primer nivel en el texto, sin ejecutarla.
  for (const cfgFile of candidates.length ? [] : files.filter((f) => /(^|\/)app\.config\.(js|ts|mjs|cjs)$/.test(f.path))) {
    const icon = /^\s*icon:\s*['"]([^'"]+\.(?:png|jpe?g))['"]/m.exec((await show(cfgFile.path)).toString("utf8"))?.[1];
    if (!icon) continue;
    const dir = cfgFile.path.includes("/") ? cfgFile.path.slice(0, cfgFile.path.lastIndexOf("/") + 1) : "";
    const target = files.find((f) => f.path === dir + icon.replace(/^\.\//, ""));
    if (ok(target)) candidates.push(target!);
  }
  if (!candidates.length && hint) {
    const target = files.find((f) => f.path === hint.replace(/^\.\//, ""));
    if (ok(target)) candidates.push(target!);
  }
  if (!candidates.length) {
    const rank = (p: string) => ["apple-touch-icon", "app-icon", "icon", "logo", "favicon"].findIndex((n) => new RegExp(`(^|/)${n}[^/]*$`, "i").test(p));
    // A igual nombre, mejor el exacto (icon.png) que una variante (icon-dark.png); luego el más grande.
    const exact = (p: string) => (/(^|\/)(apple-touch-icon|app-icon|icon|logo|favicon)\.(png|jpe?g)$/i.test(p) ? 0 : 1);
    candidates.push(...files.filter((f) => ok(f) && rank(f.path) >= 0).sort((a, b) => rank(a.path) - rank(b.path) || exact(a.path) - exact(b.path) || b.size - a.size));
  }
  const best = candidates[0];
  if (!best) return null;
  return { data: await show(best.path), contentType: /\.png$/i.test(best.path) ? "image/png" : "image/jpeg" };
}

/**
 * Detecta una app Expo publicable por OTA en el commit dado: carpeta con eas.json y app.json (con "expo")
 * o app.config.*. Devuelve la carpeta y los canales de eas.json (por defecto preview y production).
 */
/**
 * Cómo publica OTA el repo:
 * - `script`: la app tiene un script `ota:publish` propio (p. ej. un servidor xprem); se respeta, con sus guardas.
 * - `eas`: EAS Update configurado (`updates.url` en u.expo.dev).
 * Sin ninguno de los dos, la app Expo no tiene OTA (`ota: null`) y se dice por qué en `reason`.
 */
export interface ExpoApp {
  appDir: string;
  channels: string[];
  ota: "script" | "eas" | null;
  /** Texto del script `ota:publish` (si `ota` es `script`), para no repetirle la rama si ya la lleva. */
  otaScript?: string;
  /** Gestor de paquetes según el lockfile (para instalar y ejecutar el script). */
  pm: "npm" | "pnpm" | "yarn" | "bun";
  /** Perfiles de `build` de eas.json (las builds para testers usan `production`, la de tienda). */
  buildProfiles: string[];
}

export async function findExpoApp(repoPath: string, commit: string): Promise<ExpoApp | null> {
  const files = (await git(repoPath, ["ls-tree", "-r", "--name-only", commit])).split("\n").filter((f) => !/(^|\/)node_modules\//.test(f));
  const show = (path: string) => git(repoPath, ["show", `${commit}:${path}`]).catch(() => "");
  for (const eas of files.filter((f) => /(^|\/)eas\.json$/.test(f))) {
    const dir = eas.includes("/") ? eas.slice(0, eas.lastIndexOf("/") + 1) : "";
    const configFile = [`${dir}app.json`, ...["js", "ts", "mjs", "cjs"].map((e) => `${dir}app.config.${e}`)].find((f) => files.includes(f));
    const config = configFile ? await show(configFile) : "";
    if (!configFile || (configFile.endsWith("app.json") && !/"expo"\s*:/.test(config))) continue;
    let channels: string[] = [];
    let buildProfiles: string[] = [];
    try {
      const build = (JSON.parse(await show(eas)) as { build?: Record<string, { channel?: string }> }).build ?? {};
      buildProfiles = Object.keys(build);
      channels = [...new Set(Object.values(build).map((p) => p.channel).filter((c): c is string => !!c && /^[a-z0-9-]{1,40}$/i.test(c)))];
    } catch {
      // eas.json no válido: canales por defecto
    }
    const known = channels.filter((c) => c === "preview" || c === "production");
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(await show(`${dir}package.json`)) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      // sin package.json propio (monorepo): solo EAS
    }
    const has = (f: string) => files.includes(`${dir}${f}`) || files.includes(f);
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
    const ota = scripts["ota:publish"] ? "script" : /u\.expo\.dev\//.test(config) ? "eas" : null;
    return { appDir: dir.replace(/\/$/, ""), channels: known.length ? known : ["preview", "production"], ota, otaScript: scripts["ota:publish"], pm, buildProfiles };
  }
  return null;
}

/**
 * URL del remoto sin credenciales, para que el equipo pueda clonar el repo (`git clone`): solo GitHub o Bitbucket,
 * por https (sin usuario ni token) o por ssh (`git@…`). Cualquier otra cosa no se comparte.
 */
export function publicRepoUrl(remoteUrl: string): string | null {
  const url = remoteUrl.trim().replace(/^https:\/\/[^@/]+@/, "https://");
  return /^(https:\/\/(github\.com|bitbucket\.org)\/|git@(github\.com|bitbucket\.org):)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(url) ? url : null;
}

/**
 * Destinos de despliegue que el repo ofrece a Backcode: scripts `backcode:deploy:<nombre>` de cualquier package.json
 * (en un monorepo, uno por app, web, api…). Solo estos: un `deploy` sin su línea `backcode:` nunca se ofrece.
 */
export interface DeployTarget {
  /** `<carpeta>#<nombre>` (carpeta "" = raíz): lo que pide la app y se vuelve a comprobar al ejecutar. */
  id: string;
  name: string;
  dir: string;
  pm: "npm" | "pnpm" | "yarn" | "bun";
}

export const DEPLOY_PREFIX = "backcode:deploy:";
const DEPLOY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export async function findDeployTargets(repoPath: string, commit: string): Promise<DeployTarget[]> {
  const files = (await git(repoPath, ["ls-tree", "-r", "--name-only", commit])).split("\n").filter((f) => !/(^|\/)node_modules\//.test(f));
  const out: DeployTarget[] = [];
  for (const pkg of files.filter((f) => /(^|\/)package\.json$/.test(f))) {
    const dir = pkg.includes("/") ? pkg.slice(0, pkg.lastIndexOf("/")) : "";
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(await git(repoPath, ["show", `${commit}:${pkg}`])) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      continue;
    }
    const has = (f: string) => files.includes(dir ? `${dir}/${f}` : f) || files.includes(f);
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
    for (const key of Object.keys(scripts)) {
      const name = key.startsWith(DEPLOY_PREFIX) ? key.slice(DEPLOY_PREFIX.length) : "";
      if (DEPLOY_NAME_RE.test(name) && typeof scripts[key] === "string") out.push({ id: `${dir}#${name}`, name, dir, pm });
    }
  }
  return out.slice(0, 20);
}

/** Excluye una ruta de git en el repo (info/exclude, compartido por los worktrees) sin tocar su .gitignore. */
export async function excludeFromGit(worktree: string, pattern: string): Promise<void> {
  const common = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const file = join(common, "info", "exclude");
  mkdirSync(join(common, "info"), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!current.split("\n").includes(pattern)) appendFileSync(file, `${current.endsWith("\n") || !current ? "" : "\n"}${pattern}\n`);
}

/** Los worktrees se conservan para poder continuar la conversación; se borran tras `days` sin uso. */
export async function pruneOldWorktrees(repoPath: string, worktreesDir: string, days: number): Promise<void> {
  if (!existsSync(worktreesDir)) return;
  const limit = Date.now() - days * 86_400_000;
  for (const name of readdirSync(worktreesDir)) {
    const path = join(worktreesDir, name);
    if (statSync(path).mtimeMs < limit) await removeWorktree(repoPath, path);
  }
  await git(repoPath, ["worktree", "prune"]).catch(() => undefined);
}

/**
 * Ajusta la configuración al repo real antes de empezar: si la rama base no existe en el remoto se usa
 * la rama por defecto del repo (p. ej. master), y si el remoto no es GitHub no se intenta abrir PR con gh.
 * Devuelve avisos legibles para la terminal y para la app.
 */
/** Aviso de configuración: código + datos, para que la app lo muestre traducido. */
export type RepoWarning =
  | { code: "baseBranchFallback"; configured: string; used: string }
  | { code: "notGithub"; host: string }
  | { code: "bitbucketNoToken" };

export function describeWarning(w: RepoWarning): string {
  if (w.code === "baseBranchFallback") return t("git.baseFallback", { configured: w.configured, used: w.used });
  if (w.code === "bitbucketNoToken") return t("git.bitbucketNoToken");
  return t("git.notGithub", { host: w.host });
}

type PrMode = "github" | "bitbucket" | "push-only";

/**
 * Ajusta la configuración al repo real antes de empezar: si la rama base no existe en el remoto se usa
 * la rama por defecto del repo (p. ej. master), y el modo de PR se adapta al alojamiento (GitHub,
 * Bitbucket con token, o solo subir la rama). Devuelve avisos para la terminal y para la app.
 */
export async function checkRepo(repoPath: string, remote: string, baseBranch: string, pullRequest: PrMode, hasBitbucketToken: boolean): Promise<{ baseBranch: string; pullRequest: PrMode; remoteUrl: string; warnings: RepoWarning[] }> {
  const warnings: RepoWarning[] = [];
  const url = await git(repoPath, ["remote", "get-url", remote]).catch(() => "");
  if (!url) throw new Error(t("git.noRemote", { repo: repoPath, remote }));
  const heads = await git(repoPath, ["ls-remote", "--symref", remote, "HEAD", `refs/heads/${baseBranch}`]);
  const defaultBranch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(heads)?.[1];
  const hasBase = heads.split("\n").some((l) => l.endsWith(`refs/heads/${baseBranch}`));
  if (!hasBase) {
    if (!defaultBranch) throw new Error(t("git.noBase", { base: baseBranch, remote }));
    warnings.push({ code: "baseBranchFallback", configured: baseBranch, used: defaultBranch });
    baseBranch = defaultBranch;
  }
  if (pullRequest !== "push-only") {
    if (/github\.com[:/]/.test(url)) pullRequest = "github";
    else if (/bitbucket\.org[:/]/.test(url)) {
      pullRequest = hasBitbucketToken ? "bitbucket" : "push-only";
      if (!hasBitbucketToken) warnings.push({ code: "bitbucketNoToken" });
    } else {
      warnings.push({ code: "notGithub", host: /@?([a-z0-9.-]+\.[a-z]+)[:/]/i.exec(url)?.[1] ?? "?" });
      pullRequest = "push-only";
    }
  }
  return { baseBranch, pullRequest, remoteUrl: url, warnings };
}

/** Último commit de la rama base en el remoto (hace fetch antes). */
/** ¿`ancestor` está contenido en `commit`? (p. ej. el merge de una tarea en el commit publicado por OTA) */
export async function isAncestor(repoPath: string, ancestor: string, commit: string): Promise<boolean> {
  return git(repoPath, ["merge-base", "--is-ancestor", ancestor, commit]).then(
    () => true,
    () => false,
  );
}

/**
 * Pone al día tu copia local de la rama base (p. ej. tras mergear un PR desde la app) SOLO si es seguro: estás en esa
 * rama, sin cambios pendientes, y es un avance limpio (fast-forward). Si no, no toca nada y dice por qué.
 */
export async function syncLocalBase(repoPath: string, remote: string, baseBranch: string): Promise<{ status: "updated" | "uptodate" | "skipped"; reason?: string; commits?: number; changed?: string[] }> {
  await git(repoPath, ["fetch", "--quiet", remote, baseBranch]);
  const branch = await git(repoPath, ["branch", "--show-current"]).catch(() => "");
  const target = `${remote}/${baseBranch}`;
  const behind = Number(await git(repoPath, ["rev-list", "--count", `${baseBranch}..${target}`]).catch(() => "0"));
  if (!behind) return { status: "uptodate" };
  if (branch !== baseBranch) {
    // En otra rama: se avanza la rama base sin cambiar de rama, solo si es fast-forward (git fetch lo comprueba).
    const ok = await git(repoPath, ["fetch", "--quiet", remote, `${baseBranch}:${baseBranch}`]).then(() => true, () => false);
    return ok ? { status: "updated", commits: behind } : { status: "skipped", reason: t("git.localAhead", { base: baseBranch, target }) };
  }
  if (await git(repoPath, ["status", "--porcelain", "--untracked-files=no"])) return { status: "skipped", reason: t("git.dirty") };
  const before = await git(repoPath, ["rev-parse", "HEAD"]);
  const ok = await git(repoPath, ["merge", "--ff-only", "--quiet", target]).then(() => true, () => false);
  if (!ok) return { status: "skipped", reason: t("git.localAhead", { base: baseBranch, target }) };
  // Ficheros cambiados: para saber si hay que reinstalar dependencias en tu copia.
  const changed = (await git(repoPath, ["diff", "--name-only", before, "HEAD"])).split("\n").filter(Boolean);
  return { status: "updated", commits: behind, changed };
}

export async function remoteHead(repoPath: string, remote: string, baseBranch: string): Promise<string> {
  await git(repoPath, ["fetch", remote, baseBranch]);
  return git(repoPath, ["rev-parse", `${remote}/${baseBranch}`]);
}

/** Worktree de solo lectura (sin rama) en un commit concreto. Solo contiene ficheros versionados. */
export async function createDetachedWorktree(repoPath: string, worktreesDir: string, name: string, commit: string): Promise<string> {
  const path = join(worktreesDir, name);
  mkdirSync(worktreesDir, { recursive: true });
  if (existsSync(path)) await removeWorktree(repoPath, path);
  await git(repoPath, ["worktree", "prune"]);
  await git(repoPath, ["worktree", "add", "--detach", path, commit]);
  return path;
}

export async function removeWorktree(repoPath: string, path: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", path]).catch(() => undefined);
}

export async function stageAll(worktree: string): Promise<string[]> {
  await git(worktree, ["add", "-A"]);
  const out = await git(worktree, ["diff", "--cached", "--name-only", "-z", ...(await stagedAgainst(worktree))]);
  return out.split("\0").filter(Boolean);
}

export async function commitsAhead(worktree: string, remote: string, baseBranch: string): Promise<number> {
  return Number(await git(worktree, ["rev-list", "--count", `${remote}/${baseBranch}..HEAD`]));
}

/** Patrón y clave del texto (se traduce al usarlo). */
export const SECRET_PATTERNS: Array<[RegExp, Key]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "secret.privateKey"],
  [/\bAKIA[0-9A-Z]{16}\b/, "secret.aws"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "secret.github"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "secret.anthropic"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "secret.slack"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "secret.api"],
  [/"private_key"\s*:\s*"-----BEGIN/, "secret.google"],
];

/** Busca secretos en las líneas añadidas del diff staged. */
/**
 * Contra qué se revisa lo preparado: normalmente HEAD; si se está cerrando un merge con la rama base, contra esa base
 * (MERGE_HEAD), para revisar solo lo que cambia la tarea y no todo lo que entró en la base (ya revisado allí).
 */
async function stagedAgainst(worktree: string): Promise<string[]> {
  return (await git(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => "")) ? ["MERGE_HEAD"] : [];
}

export async function scanStagedForSecrets(worktree: string): Promise<string[]> {
  const diff = await git(worktree, ["diff", "--cached", "-U0", "--no-color", ...(await stagedAgainst(worktree))]);
  const findings: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+")) {
      for (const [re, label] of SECRET_PATTERNS) {
        if (re.test(line)) findings.push(t("git.secretIn", { label: t(label), file }));
      }
    }
  }
  return [...new Set(findings)];
}

export async function commitPushAndOpenPr(opts: {
  worktree: string;
  remote: string;
  baseBranch: string;
  branch: string;
  title: string;
  body: string;
  featureId: string;
  /** Sin host (modo "solo subir la rama") no se abre PR. */
  host?: PrHost;
}): Promise<string> {
  // Un reintento tras fallar el push o la API puede no tener nada nuevo que commitear.
  const staged = await git(opts.worktree, ["diff", "--cached", "--name-only"]);
  if (staged) await git(opts.worktree, [
    "commit", "--no-verify",
    "-m", opts.title,
    "-m", `Backcode-Feature: ${opts.featureId}`,
  ]);
  await git(opts.worktree, ["push", "--no-verify", "--force-with-lease", opts.remote, `${opts.branch}:${opts.branch}`]);
  if (!opts.host) return `${opts.remote}/${opts.branch}`;
  // En una conversación el PR ya existe: el push de arriba lo actualiza.
  return opts.host.openOrUpdatePr({ cwd: opts.worktree, branch: opts.branch, base: opts.baseBranch, title: opts.title, body: opts.body });
}
