import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Encontrar el repo de un proyecto en este ordenador sin preguntar la ruta: se miran las carpetas donde se suelen guardar
// (dos niveles) y se compara el remoto con la URL del proyecto. Así quien ya lo tiene clonado no tiene que hacer nada, y
// quien no, lo clona con un clic en ~/Backcode/<proyecto>.

export const REPO_ROOTS = ["Projects", "Developer", "Code", "code", "dev", "src", "Sites", "GitHub", "Documents/GitHub", "Documents/Projects", "repos", "workspace", "Backcode"];

/** Carpeta por defecto para clonar un proyecto: ~/Backcode/<nombre-en-minúsculas>. */
export function defaultClonePath(name: string | undefined, projectId: string): string {
  const slug = (name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return join(homedir(), "Backcode", slug || projectId);
}

/** «github.com/dueño/repo» de una URL de git (https o ssh), en minúsculas y sin .git; null si no se reconoce. */
export function normalizeRemote(url: string): string | null {
  const u = url.trim().replace(/^https?:\/\/[^@/]+@/, "https://");
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null;
}

/** URL del remoto origin de un repo, leída de .git/config (sin lanzar git). */
export function originUrl(dir: string): string | null {
  try {
    const gitDir = join(dir, ".git");
    const config = statSync(gitDir).isDirectory() ? readFileSync(join(gitDir, "config"), "utf8") : null;
    if (!config) return null;
    return /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface FoundRepo {
  path: string;
  name: string;
  remote: string | null;
}

/** Repos git en las carpetas habituales (hasta dos niveles), los más recientes primero. */
export function findRepos(home = homedir()): FoundRepo[] {
  const found: (FoundRepo & { mtime: number })[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = join(dir, name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(path, ".git"))) found.push({ path, name, remote: originUrl(path), mtime: statSync(path).mtimeMs });
      else if (depth < 2) visit(path, depth + 1);
    }
  };
  for (const root of REPO_ROOTS) visit(join(home, root), 1);
  const unique = [...new Map(found.map((r) => [r.path, r])).values()];
  return unique.sort((a, b) => b.mtime - a.mtime).map(({ path, name, remote }) => ({ path, name, remote }));
}

/** El repo de este ordenador cuyo remoto es el del proyecto, si lo hay. */
export function findProjectRepo(projectUrl: string, repos = findRepos()): string | null {
  const want = normalizeRemote(projectUrl);
  return want ? repos.find((r) => r.remote && normalizeRemote(r.remote) === want)?.path ?? null : null;
}
