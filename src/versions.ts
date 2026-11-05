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

// Códigos de color/estilo ANSI (eas-cli los imprime si cree que hay terminal).
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Valor de runtime plausible: empieza por dígito («1.4.0») o lleva algún dígito (fingerprint, «exposdk:51.0.0»); nunca «s». */
export function isRuntimeVersion(v: string | undefined): v is string {
  return !!v && v.length <= 64 && (/^\d/.test(v) || (v.length >= 2 && /\d/.test(v))) && /^[0-9A-Za-z][0-9A-Za-z._:+-]*$/.test(v);
}

/** Primer valor de las líneas «<etiqueta>  valor» (texto plano, «Etiqueta: valor» o tabla con «│»/«|») que pase `ok`. */
function field(lines: string[], label: string, ok: (v: string) => boolean): string | undefined {
  // `\b` tras la etiqueta: «Runtime versions» no encaja con «Runtime version». Entre etiqueta y valor, al menos un espacio o separador.
  const re = new RegExp(`^[\\s│|]*${label}\\b[^\\S\\n]*(?:[:│|][^\\S\\n]*|[^\\S\\n]+)([^\\s│|]+)`, "i");
  for (const line of lines) {
    const v = re.exec(line)?.[1];
    if (v && ok(v)) return v;
  }
  return undefined;
}

const UPDATE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f-]{8,36}$/i;

/**
 * Runtime e identificador del update que imprime `eas update` («Runtime version  1.4.0», «Update group ID  …»), con o
 * sin colores ANSI y en tabla. Si las plataformas van por separado («Android runtime version», «iOS update ID»), la de la
 * primera. Lo que no parezca una versión o un id se descarta (el runner usa entonces la versión de la app).
 */
export function otaInfoFrom(output: string): { runtimeVersion?: string; updateId?: string } {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  const runtimeVersion = field(lines, "Runtime version", isRuntimeVersion) ?? field(lines, "(?:Android|iOS) runtime version", isRuntimeVersion);
  const isId = (v: string) => UPDATE_ID.test(v) && /\d/.test(v);
  const updateId = field(lines, "Update group ID", isId) ?? field(lines, "(?:Android|iOS) update ID", isId);
  return { ...(runtimeVersion ? { runtimeVersion } : {}), ...(updateId ? { updateId } : {}) };
}
