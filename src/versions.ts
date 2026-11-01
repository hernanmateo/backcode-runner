import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployTarget } from "./git.js";

// Número de versión de cada parte desplegada (lo que la app enseña en vez del commit): el `expo.version` de app.json si
// la carpeta es una app de Expo (web, OTA, builds) y si no la `version` de su package.json (p. ej. el runner, 1.0.78).
// Las partes sin versión propia (reglas, functions, una landing estática…) no tienen: la app enseña la fecha.

/** Carpeta de la que sale la versión de un destino; null si no tiene versión propia. */
export function versionDir(target: Pick<DeployTarget, "dir" | "auto" | "env">, rank: number): string | null {
  // Reglas, índices y functions (y migraciones): su package.json, si lo hay, es el de las pruebas o no dice nada.
  if (rank < 2) return null;
  if (target.auto) return target.auto.paths.length === 1 && target.auto.paths[0] ? target.auto.paths[0] : null;
  // Un script en la raíz: la versión de la raíz no suele decir nada del destino.
  return target.dir || null;
}

/** Versión de `dir` leyendo sus ficheros con `read` (de un commit o del disco); undefined si no tiene. */
export async function readVersion(read: (path: string) => Promise<string | undefined>, dir: string): Promise<string | undefined> {
  const prefix = dir && dir !== "." ? `${dir.replace(/\/+$/, "")}/` : "";
  const field = async (file: string, pick: (json: Record<string, unknown>) => unknown) => {
    try {
      const text = await read(`${prefix}${file}`);
      const v = text ? pick(JSON.parse(text) as Record<string, unknown>) : undefined;
      return typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : undefined;
    } catch {
      return undefined;
    }
  };
  return (await field("app.json", (j) => (j.expo as { version?: unknown } | undefined)?.version)) ?? (await field("package.json", (j) => j.version));
}

/** Lector para readVersion de los ficheros bajo `root` en disco (una copia limpia del commit). */
export function readFrom(root: string): (path: string) => Promise<string | undefined> {
  return async (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return undefined;
    }
  };
}

/** Número de build que asigna EAS (autoIncrement): «Incremented buildNumber from 52 to 53», «Initialized versionCode with 1» (el último que aparezca). */
export function buildNumberFrom(output: string): string | undefined {
  const all = [...output.matchAll(/(?:buildNumber|versionCode|build number|version code)[^\d\n]{0,40}(\d+)(?:\s+to\s+(\d+))?/gi)];
  const last = all.at(-1);
  return last ? (last[2] ?? last[1]) : undefined;
}

/** Runtime e identificador del update que imprime `eas update` («Runtime version  1.4.0», «Update group ID  …»). */
export function otaInfoFrom(output: string): { runtimeVersion?: string; updateId?: string } {
  const runtimeVersion = /Runtime version\s*[:│|]?\s*([0-9A-Za-z][0-9A-Za-z._-]{0,39})/i.exec(output)?.[1];
  const updateId = /Update group ID\s*[:│|]?\s*([0-9a-f-]{8,36})/i.exec(output)?.[1];
  return { ...(runtimeVersion ? { runtimeVersion } : {}), ...(updateId ? { updateId } : {}) };
}
