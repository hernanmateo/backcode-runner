import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readCredentials } from "./credentials.js";
import { bitbucketRepo } from "./hosts.js";
import { HOME_DIR, projectFiles } from "./paths.js";
import { valueIn } from "./setup.js";

// Lo que este ordenador puede hacer al crear un proyecto desde la app: dónde se crean (carpeta de proyectos) y en qué
// cuentas (sesión de gh y sus organizaciones, workspaces de Bitbucket). Se publica en users/{uid}/private/machine para
// que la app lo ofrezca; nunca lleva tokens. La carpeta la puede proponer la app, pero solo vale dentro de tu $HOME.

const run = promisify(execFile);

export type ProjectsDirSource = "settings" | "inferred" | "default";

/**
 * Una carpeta de proyectos aceptable: absoluta (o con ~), dentro de tu $HOME, fuera de ~/.backcode y sin carpetas
 * ocultas por el camino. Devuelve la ruta resuelta o null.
 */
export function validProjectsDir(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const home = homedir();
  const expanded = raw.trim().replace(/^~(?=$|\/)/, home);
  if (!isAbsolute(expanded)) return null;
  const dir = resolve(expanded);
  const rel = relative(home, dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (rel.split(sep).some((part) => part.startsWith("."))) return null;
  if (dir === HOME_DIR || dir.startsWith(HOME_DIR + sep)) return null;
  return dir;
}

/** Repos conectados en este ordenador (ruta y remoto de cada uno, si se puede leer). */
function connectedRepos(): { path: string; pullRequest?: string }[] {
  return projectFiles().flatMap(({ file }) => {
    try {
      const text = readFileSync(file, "utf8");
      const path = valueIn(text, "BACKCODE_REPO_PATH");
      return path ? [{ path: path.replace(/^~(?=\/)/, homedir()), pullRequest: valueIn(text, "BACKCODE_PULL_REQUEST") }] : [];
    } catch {
      return [];
    }
  });
}

/** La carpeta donde ya tienes más repos conectados (si es válida). */
function inferredProjectsDir(): string | null {
  const counts = new Map<string, number>();
  for (const r of connectedRepos()) {
    const parent = validProjectsDir(dirname(r.path));
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Carpeta de proyectos: la de los ajustes de la app, la que ya usas o ~/Projects. */
export function resolveProjectsDir(fromSettings?: string): { dir: string; source: ProjectsDirSource } {
  const settings = validProjectsDir(fromSettings);
  if (settings) return { dir: settings, source: "settings" };
  const inferred = inferredProjectsDir();
  if (inferred) return { dir: inferred, source: "inferred" };
  return { dir: join(homedir(), "Projects"), source: "default" };
}

async function remoteUrls(): Promise<string[]> {
  const urls = await Promise.all(connectedRepos().map((r) => run("git", ["-C", r.path, "remote", "get-url", "origin"], { timeout: 5000 }).then((o) => o.stdout.trim(), () => "")));
  return urls.filter(Boolean);
}

/** ¿Tus repos de Bitbucket usan ssh (git@…)? Así el repo nuevo se sube igual que los demás. */
export async function bitbucketUsesSsh(): Promise<boolean> {
  return (await remoteUrls()).some((u) => u.startsWith("git@bitbucket.org:"));
}

/** Sesión de gh: tu usuario y tus organizaciones (o null si gh no está o no tiene sesión). */
async function githubAccount(): Promise<{ login: string; orgs: string[] } | null> {
  const gh = (args: string[]) => run("gh", args, { timeout: 15_000 }).then((o) => o.stdout.trim());
  const login = await gh(["api", "user", "--jq", ".login"]).catch(() => "");
  if (!login) return null;
  const orgs = (await gh(["api", "user/orgs", "--jq", ".[].login"]).catch(() => "")).split("\n").map((s) => s.trim()).filter(Boolean);
  return { login, orgs: orgs.slice(0, 50) };
}

/** Workspaces de Bitbucket: los que da la API con tu token y los de tus repos conectados (o null sin token). */
async function bitbucketAccount(credentials?: { email: string; token: string }): Promise<{ workspaces: string[] } | null> {
  if (!credentials) return null;
  const found = new Set<string>();
  const headers = { Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`, Accept: "application/json" };
  // /user/workspaces sustituye a /user/permissions/workspaces; se prueban los dos (el que no exista da error y se ignora).
  for (const path of ["/user/workspaces?pagelen=100", "/user/permissions/workspaces?pagelen=100"]) {
    const data = (await fetch(`https://api.bitbucket.org/2.0${path}`, { headers, signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null), () => null)) as { values?: { slug?: string; workspace?: { slug?: string } }[] } | null;
    for (const v of data?.values ?? []) {
      const slug = v.workspace?.slug ?? v.slug;
      if (slug) found.add(slug);
    }
    if (found.size) break;
  }
  for (const url of await remoteUrls()) {
    const repo = bitbucketRepo(url);
    if (repo) found.add(repo.workspace);
  }
  return { workspaces: [...found].sort().slice(0, 50) };
}

/** Informe completo para users/{uid}/private/machine (sin updatedAt, que pone el servidor). */
export async function machineInfo(settingsDir: string | undefined, projectBitbucket?: { email: string; token: string }): Promise<Record<string, unknown>> {
  const { dir, source } = resolveProjectsDir(settingsDir);
  const [github, bitbucket] = await Promise.all([githubAccount(), bitbucketAccount(readCredentials().bitbucket ?? projectBitbucket)]);
  return { projectsDir: dir, projectsDirSource: source, github, bitbucket, host: hostname() };
}
