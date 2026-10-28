import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED } from "./embedded.js";
import { KIT_DIR } from "./paths.js";

/** Un fichero del paquete (p. ej. "panel/index.html"): del ejecutable si va incrustado, si no del disco. */
export function readAsset(path: string): Buffer {
  if (EMBEDDED) {
    const data = EMBEDDED[path];
    if (data === undefined) throw Object.assign(new Error(`asset not found: ${path}`), { code: "ENOENT" });
    return Buffer.from(data, "base64");
  }
  return readFileSync(join(KIT_DIR, path));
}

/** Versión del paquete que se está ejecutando. */
export const VERSION: string = JSON.parse(readAsset("package.json").toString("utf8")).version;
