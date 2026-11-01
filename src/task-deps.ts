import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./actions.js";
import { git } from "./git.js";

// Dependencias de la tarea, listas antes de que empiece Claude. Dentro del sandbox, instalarlas falla a menudo (la caché
// del gestor vive fuera del worktree, la red es una lista cerrada, la versión del gestor no lee el lockfile…) y Claude se
// pasaba media hora esperando un `bun install` que no acababa, sin poder pasar tests ni abrir el PR. Así que las instala
// el runner, fuera del sandbox, con el lockfile y el gestor del repo, como antes de desplegar.
//
// Solo con los ficheros de dependencias tal como están en la rama base (los de la rama principal, que es lo que
// instalaría cualquiera del equipo): si Claude ya los cambió en una vuelta anterior, no se instala aquí (lo hace él en su
// sandbox). Y solo donde node_modules está ignorado por git, para no acabar subiéndolo en el PR.

/** Lockfile → instalación sin tocarlo, por orden de preferencia si hay varios en la misma carpeta. */
const FROZEN: [string, string[]][] = [
  ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
  ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci", "--no-audit", "--no-fund"]],
];

const INSTALL_MS = 15 * 60_000;

export interface DepsResult {
  /** Carpeta relativa al worktree ("" = raíz). */
  dir: string;
  cmd: string[];
  ok: boolean;
  error?: string;
}

/** Carpetas con lockfile versionado (sin node_modules) y su comando. */
export async function lockfileDirs(worktree: string): Promise<{ dir: string; lock: string; cmd: string[] }[]> {
  const names = new Set(FROZEN.map(([l]) => l));
  const files = (await git(worktree, ["ls-files"])).split("\n").filter((f) => f && names.has(f.slice(f.lastIndexOf("/") + 1)) && !/(^|\/)node_modules\//.test(f));
  const dirs = [...new Set(files.map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")))].sort();
  return dirs.flatMap((dir) => {
    const found = FROZEN.find(([l]) => files.includes(dir ? `${dir}/${l}` : l));
    return found ? [{ dir, lock: found[0], cmd: found[1] }] : [];
  });
}

/** Instala lo que falte (sin node_modules) en cada carpeta con lockfile. Nunca lanza: un fallo lo resuelve Claude. */
export async function prepareTaskDependencies(opts: { worktree: string; base: string }): Promise<DepsResult[]> {
  const out: DepsResult[] = [];
  for (const { dir, lock, cmd } of await lockfileDirs(opts.worktree).catch(() => [])) {
    const abs = join(opts.worktree, dir);
    if (existsSync(join(abs, "node_modules")) || !existsSync(join(abs, "package.json"))) continue;
    const rel = (f: string) => (dir ? `${dir}/${f}` : f);
    // Igual que en la rama base (Claude no los ha tocado) y node_modules ignorado por git.
    const same = await git(opts.worktree, ["diff", "--quiet", opts.base, "--", rel("package.json"), rel(lock)]).then(() => true, () => false);
    const ignored = await git(opts.worktree, ["check-ignore", "-q", rel("node_modules")]).then(() => true, () => false);
    if (!same || !ignored) continue;
    try {
      await exec(cmd, abs, { timeoutMs: INSTALL_MS });
      out.push({ dir, cmd, ok: true });
    } catch (err) {
      out.push({ dir, cmd, ok: false, error: (err as Error).message.split("\n").find((l) => l.trim())?.slice(0, 300) ?? "" });
    }
  }
  return out;
}
