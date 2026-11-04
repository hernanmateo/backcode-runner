// Checks en local ya comprobados en este ordenador, por contenido: la clave de un check es un hash de su comando y del
// contenido (árboles y ficheros de git) de lo que declara en `paths` en ese commit. Así no se repite un check que ya pasó
// con el mismo código aunque el commit sea otro (el squash de un PR ya comprobado al desplegar, o un PR que no toca sus
// carpetas), y no depende de poder leer los estados del host (GitHub caído).
//
// Solo se guardan claves y fechas (nada de código ni logs), en ~/.backcode/checks-cache.json, y se limpian solas: cada
// entrada caduca a los 7 días y como mucho se guardan 300 (se van las más antiguas).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.js";
import { HOME_DIR } from "./paths.js";

export const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
export const CACHE_MAX = 300;

export interface ChecksCache {
  has(key: string): boolean;
  remember(key: string): void;
}

/** Quita lo caducado y, si sobran, lo más antiguo. */
export function pruneCache(entries: Record<string, number>, now = Date.now(), ttlMs = CACHE_TTL_MS, max = CACHE_MAX): Record<string, number> {
  const fresh = Object.entries(entries).filter(([, at]) => typeof at === "number" && now - at < ttlMs);
  fresh.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(fresh.slice(0, max));
}

/** Caché en un fichero JSON (por defecto ~/.backcode/checks-cache.json). Nunca lanza: sin fichero o roto, vacía. */
export function fileChecksCache(file = join(HOME_DIR, "checks-cache.json"), now: () => number = Date.now): ChecksCache {
  const read = (): Record<string, number> => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, number>) : {};
    } catch {
      return {};
    }
  };
  return {
    has: (key) => key in pruneCache(read(), now()),
    remember: (key) => {
      try {
        const entries = pruneCache({ ...read(), [key]: now() }, now());
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(entries));
      } catch {
        // Sin caché no pasa nada: el check se ejecutará la próxima vez.
      }
    },
  };
}

/**
 * Clave de contenido de un check en `sha`: su comando, carpeta e instalación, y el hash de git de cada uno de sus `paths`
 * (o del árbol entero del repo si no declara ninguno). null si no se pudo calcular (entonces se ejecuta).
 */
export async function checkKey(repoPath: string, sha: string, check: { name: string; dir: string; cmd: string[]; install: boolean; paths: string[] }, gitFn = git): Promise<string> {
  const objects = check.paths.length
    ? await Promise.all(check.paths.map(async (p) => `${p}=${await gitFn(repoPath, ["rev-parse", `${sha}:${p}`]).catch(() => "-")}`))
    : [`/=${await gitFn(repoPath, ["rev-parse", `${sha}^{tree}`])}`];
  const what = JSON.stringify({ v: 1, name: check.name, dir: check.dir, cmd: check.cmd, install: check.install, objects });
  return createHash("sha256").update(what).digest("hex").slice(0, 32);
}
