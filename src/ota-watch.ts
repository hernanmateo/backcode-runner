import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAncestor } from "./git.js";
import type { Store } from "./store.js";

// OTA publicados fuera de la app (p. ej. `npm run ota:publish` desde la terminal): el script deja el commit publicado en
// <app>/.expo/eoas-last-publish-<rama>. El runner lo mira y hace lo mismo que tras publicar desde la app: marca
// «Desplegada» en ese canal las tareas mergeadas que entraron, y «Pendiente de desplegar» lo da por publicado.

/** Canal de la rama del fichero: la principal es production; dev/preview/staging, preview. */
function channelOf(branch: string, baseBranch: string): "production" | "preview" | null {
  if (branch === baseBranch || branch === "main" || branch === "master" || branch === "production" || branch === "prod") return "production";
  if (branch === "dev" || branch === "develop" || branch === "preview" || branch === "staging") return "preview";
  return null;
}

/** El último commit publicado por canal, según los ficheros que deja el script de OTA (solo commits completos). */
export function lastCliPublish(repoPath: string, appDir: string, baseBranch: string): Partial<Record<"production" | "preview", string>> {
  const dir = join(repoPath, appDir, ".expo");
  if (!existsSync(dir)) return {};
  const out: Partial<Record<"production" | "preview", string>> = {};
  for (const name of readdirSync(dir).filter((n) => n.startsWith("eoas-last-publish-"))) {
    const channel = channelOf(name.slice("eoas-last-publish-".length), baseBranch);
    const sha = (() => {
      try {
        return readFileSync(join(dir, name), "utf8").trim();
      } catch {
        return "";
      }
    })();
    if (channel && /^[0-9a-f]{40}$/.test(sha)) out[channel] = sha;
  }
  return out;
}

/** Marca «Desplegada» las tareas mergeadas que van en lo publicado desde la terminal. Devuelve cuántas marcó. */
export async function markCliPublished(store: Store, repoPath: string, published: Partial<Record<"production" | "preview", string>>): Promise<number> {
  let marked = 0;
  for (const [channel, sha] of Object.entries(published) as ["production" | "preview", string][]) {
    for (const f of await store.mergedNotDeployed(channel).catch(() => [])) {
      if (!f.sha || !(await isAncestor(repoPath, f.sha, sha))) continue;
      await store
        .markDeployed(f.id, channel, sha)
        .then(() => marked++)
        .catch(() => undefined); // solo el runner de un admin puede (las reglas lo comprueban)
    }
  }
  return marked;
}
