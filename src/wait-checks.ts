import type { Checks } from "./hosts.js";

// Justo después de crear o actualizar un PR (o de mergear en la rama base) lo normal es que la CI siga en marcha: en vez
// de rechazar al momento el merge, el OTA, la build o el despliegue, se espera a que los checks terminen. El lease de la
// acción ya se renueva cada minuto mientras está en marcha (index.ts), así que la espera no lo hace caducar.

/** Cada cuánto se vuelven a consultar los checks en curso. */
export const CHECKS_POLL_MS = 15_000;
/** Máximo que se espera a la CI antes de rechazar la acción con los checks aún en curso. */
export const CHECKS_WAIT_MS = 15 * 60_000;

// Al parar o reiniciar el runner se deja de esperar (no se bloquea un reinicio 15 minutos): la acción falla con los
// checks en curso, como antes.
let stopped = false;
export function stopWaitingForChecks(): void {
  stopped = true;
}

export interface WaitOptions {
  pollMs?: number;
  maxMs?: number;
  /** Inyectables para los tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  shouldStop?: () => boolean;
  /** Se llama una vez, al empezar a esperar (para avisar en el log). */
  onWait?: (checks: Checks) => void;
}

/**
 * Lee los checks y, mientras sigan en curso, vuelve a leerlos cada `pollMs` hasta `maxMs`. Devuelve los últimos en
 * cuanto dejan de estar en curso (green, failing o none), al agotar el tiempo o al parar el runner.
 */
export async function waitForChecks(read: () => Promise<Checks>, opts: WaitOptions = {}): Promise<Checks> {
  const pollMs = opts.pollMs ?? CHECKS_POLL_MS;
  const maxMs = opts.maxMs ?? CHECKS_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const shouldStop = opts.shouldStop ?? (() => stopped);
  const deadline = now() + maxMs;
  let checks = await read();
  let warned = false;
  while (checks.state === "pending" && !shouldStop()) {
    const left = deadline - now();
    if (left <= 0) break;
    if (!warned) {
      warned = true;
      opts.onWait?.(checks);
    }
    await sleep(Math.min(pollMs, left));
    if (shouldStop()) break;
    checks = await read();
  }
  return checks;
}
