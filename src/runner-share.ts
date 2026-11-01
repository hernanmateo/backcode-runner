/**
 * Candado «abrir mi runner a mis compañeros» (projects/{pid}/runnerShares/{uid}): `chat` (chat del runner) e `ideas`
 * («Nueva idea»), cada uno con caducidad opcional (`chatUntil` / `ideasUntil`; ausente o null = para siempre). Un
 * `enabled: true` de antes equivale a los dos abiertos para siempre. Mismas condiciones que firestore.rules (runnerShared).
 * Con él cerrado o caducado, el runner deja de atender mensajes e ideas nuevas de compañeros.
 */
export type ShareScope = "chat" | "ideas";

type When = { toMillis(): number } | Date | number | null | undefined;

function millis(w: When): number | null {
  if (w == null) return null;
  if (typeof w === "number") return w;
  if (w instanceof Date) return w.getTime();
  return typeof w.toMillis === "function" ? w.toMillis() : null;
}

/** Abierto = flag true y (sin caducidad o caducidad > ahora); o el `enabled: true` de antes. */
export function isShareOpen(share: Record<string, unknown> | null | undefined, scope: ShareScope, now = Date.now()): boolean {
  if (!share) return false;
  if (share.enabled === true) return true;
  if (share[scope] !== true) return false;
  const until = millis(share[`${scope}Until`] as When);
  return until == null || until > now;
}
