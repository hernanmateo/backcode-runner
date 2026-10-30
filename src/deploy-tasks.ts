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
