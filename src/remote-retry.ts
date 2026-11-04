// Caídas pasajeras de GitHub/Bitbucket: un push con «Internal Server Error» o «fatal error in commit_refs», un 502 de la
// API, un merge que se queda en «Merge already in progress», un `gh pr ready` que no se aplica («still a draft»)… No
// dependen del cambio: basta con esperar y reintentar.
// Aquí se reconocen, se reintentan unas pocas veces con espera y, si aun así fallan, el error lo dice y, si GitHub tiene
// una incidencia abierta (githubstatus.com), la nombra, para que nadie busque el fallo en su código.

/** Errores de GitHub/Bitbucket que no dependen del cambio (servidor caído o saturado, red, operación a medias). */
const TRANSIENT_RE =
  /something went wrong|\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway time-?out|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|try again later|merge already in progress|fatal error in commit_refs|remote rejected[^\n]*\((?:failure|internal server error)\)|RPC failed|the remote end hung up|unexpected disconnect|pull request is still a draft/i;

export function errorText(e: unknown): string {
  return `${(e as { stderr?: unknown })?.stderr ?? ""}\n${(e as Error)?.message ?? e}`;
}

/** ¿Es un fallo pasajero del host (no del cambio)? */
export function isTransientRemoteError(e: unknown): boolean {
  return TRANSIENT_RE.test(errorText(e));
}

/** Esperas entre intentos: 5 s, 15 s y 30 s (cuatro intentos en total, algo menos de un minuto). */
export const REMOTE_RETRY_DELAYS = [5_000, 15_000, 30_000];

/**
 * Ejecuta `fn` reintentando los fallos pasajeros del host. `done` (opcional) mira, antes de reintentar, si la operación sí
 * llegó a hacerse pese al error (p. ej. el PR ya consta como mergeado): entonces se da por buena.
 */
export async function withRemoteRetry<T>(
  fn: () => Promise<T>,
  opts: { delaysMs?: number[]; done?: () => Promise<T | undefined>; sleep?: (ms: number) => Promise<void>; label?: string } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? REMOTE_RETRY_DELAYS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const already = await opts.done?.().catch(() => undefined);
      if (already !== undefined) return already;
      if (attempt >= delays.length || !isTransientRemoteError(e)) throw e;
      if (opts.label) console.warn(`\x1b[33m⚠ ${opts.label}: ${errorText(e).trim().split("\n").pop()?.slice(0, 160)} · reintento ${attempt + 1}/${delays.length}\x1b[0m`);
      await sleep(delays[attempt]);
    }
  }
}

/** Incidencias abiertas de GitHub (githubstatus.com), o [] si no hay o no se pudo saber (nunca lanza; 5 s como mucho). */
export async function githubIncidents(fetchFn: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchFn("https://www.githubstatus.com/api/v2/incidents/unresolved.json", { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { incidents?: { name?: string }[] };
    return (json.incidents ?? []).map((i) => i.name ?? "").filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Mensaje de un fallo del host para la app y la terminal: si es pasajero, lo dice y, si GitHub tiene una incidencia
 * abierta, la nombra. Si no es pasajero, el mensaje tal cual.
 */
export async function explainRemoteError(message: string, texts: { transient: string; incident: (names: string) => string }, fetchFn: typeof fetch = fetch): Promise<string> {
  if (!isTransientRemoteError(message)) return message;
  const incidents = /github/i.test(message) || !/bitbucket/i.test(message) ? await githubIncidents(fetchFn) : [];
  return `${incidents.length ? texts.incident(incidents.join(" · ")) : texts.transient}\n\n${message}`;
}
