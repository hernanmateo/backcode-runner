import type { Store } from "./store.js";

/** Tarea que entró en un despliegue (se guarda en el resultado de la acción para verla en la app). */
export interface DeployedTask {
  id: string;
  title: string;
}

/** Como mucho estas por despliegue: el documento de la acción no debe crecer sin límite. */
export const MAX_DEPLOYED_TASKS = 100;

/**
 * Tareas que entran en un despliegue (build, despliegue de un destino): las mergeadas cuyo commit va en `commit` y no
 * iba ya en el despliegue anterior hecho bien del mismo destino (`previous`). Sin anterior, todas las que van en `commit`.
 */
export async function includedTasks(
  merged: { id: string; title: string; sha: string }[],
  commit: string,
  previous: string | undefined,
  isAncestor: (ancestor: string, commit: string) => Promise<boolean>,
): Promise<DeployedTask[]> {
  const out: DeployedTask[] = [];
  for (const f of merged) {
    if (out.length >= MAX_DEPLOYED_TASKS) break;
    if (!f.sha || !(await isAncestor(f.sha, commit).catch(() => false))) continue;
    if (previous && (await isAncestor(f.sha, previous).catch(() => false))) continue;
    out.push({ id: f.id, title: f.title.slice(0, 120) });
  }
  return out;
}

const PREVIEW_WORDS = new Set(["staging", "stage", "stg", "preview", "dev", "develop", "development", "qa", "test", "testing"]);
const PRODUCTION_WORDS = new Set(["production", "prod", "live"]);

/**
 * Canal en el que quedan «desplegadas» las tareas de un destino de despliegue (`<carpeta>#<nombre>`), por su nombre:
 * staging/preview/dev… → preview; production/prod/live → production. Sin ninguna de esas palabras, es production si
 * en la misma carpeta hay su versión de staging (`web` junto a `web-staging`, entre `others`, los ids de los destinos);
 * si no (rules, functions, api…), no se sabe a qué entorno va y no se marca nada.
 */
export function channelOfTarget(targetId: string, others: string[] = []): "production" | "preview" | null {
  const wordsOf = (id: string) => id.slice(id.lastIndexOf("#") + 1).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = wordsOf(targetId);
  if (words.some((w) => PREVIEW_WORDS.has(w))) return "preview";
  if (words.some((w) => PRODUCTION_WORDS.has(w))) return "production";
  const dir = targetId.slice(0, targetId.lastIndexOf("#") + 1);
  const hasStaging = others.some((id) => {
    if (id === targetId || id.slice(0, id.lastIndexOf("#") + 1) !== dir) return false;
    const w = wordsOf(id);
    return w.some((x) => PREVIEW_WORDS.has(x)) && w.filter((x) => !PREVIEW_WORDS.has(x)).join("-") === words.join("-");
  });
  return hasStaging ? "production" : null;
}

/**
 * Marca «desplegadas» en el canal las tareas mergeadas que van en `commit` y aún no constaban en él (como tras un OTA).
 * Devuelve las marcadas (como mucho MAX_DEPLOYED_TASKS, con el título recortado).
 */
export async function markDeployedTasks(
  store: Pick<Store, "mergedNotDeployed" | "markDeployed">,
  channel: "production" | "preview",
  commit: string,
  isAncestor: (ancestor: string, commit: string) => Promise<boolean>,
): Promise<DeployedTask[]> {
  const out: DeployedTask[] = [];
  for (const f of await store.mergedNotDeployed(channel).catch(() => [])) {
    if (!f.sha || !(await isAncestor(f.sha, commit).catch(() => false))) continue;
    await store.markDeployed(f.id, channel, commit).catch(() => undefined); // solo el runner de un admin puede (reglas)
    if (out.length < MAX_DEPLOYED_TASKS) out.push({ id: f.id, title: f.title.slice(0, 120) });
  }
  return out;
}
