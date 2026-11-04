// PR de tareas mergeados fuera de la app (a mano en GitHub/Bitbucket o con `gh pr merge`): el runner los busca cada minuto
// con una sola consulta al host (los últimos mergeados del repo) en vez de preguntar PR por PR, y solo si alguna de mis
// tareas tiene un PR abierto. Así la tarea pasa a «Mergeada» (y lo pendiente de desplegar se recalcula) en un minuto como
// mucho. La comprobación PR por PR de cada 5 minutos (index.ts › checkConflicts) sigue como respaldo para los más antiguos.

/** Cada cuánto se miran los PR mergeados. */
export const MERGED_POLL_MS = 60_000;

/** Misma URL de PR aunque cambie la forma (barra final, mayúsculas, /files, #…). */
export function prKey(url: string): string {
  const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:pull|pull-requests)\/(\d+)/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}`.toLowerCase() : url.trim().toLowerCase();
}

/** Mis tareas con PR abierto que aparecen entre los mergeados, con el commit del merge si se conoce. */
export function findMergedOutside<T extends { id: string; prUrl?: string }>(open: T[], merged: { url: string; sha?: string }[]): (T & { sha?: string })[] {
  const byKey = new Map(merged.map((m) => [prKey(m.url), m.sha]));
  return open.filter((f) => f.prUrl?.startsWith("https://") && byKey.has(prKey(f.prUrl))).map((f) => ({ ...f, sha: byKey.get(prKey(f.prUrl!)) }));
}
