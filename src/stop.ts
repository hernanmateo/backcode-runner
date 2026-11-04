import { AsyncLocalStorage } from "node:async_hooks";

// «Parar» desde la app (stopRequested en la acción): el runner aborta la acción que ejecuta. Cada acción corre dentro de
// un StopScope con su AbortSignal; lo que lanza procesos (exec, checks en local) o espera (CI, turno de merge) lo mira
// sin tener que pasarlo por todas las funciones. Antes de lo que no tiene vuelta atrás (pedir el merge al host, subir la
// OTA) se llama a pointOfNoReturn: desde ahí la acción ya no se para y la app deja de ofrecer «Parar» (noStop).

export interface StopScope {
  signal: AbortSignal;
  /** Marca la acción como sin vuelta atrás (noStop en Firestore). */
  markNoStop: () => Promise<void>;
  /** Ya pasó el punto sin vuelta atrás: una petición de parar que llegue ahora se ignora. */
  noStop: boolean;
}

const scope = new AsyncLocalStorage<StopScope>();

/** Ejecuta `fn` dentro del ámbito de parada de una acción. */
export function withStopScope<T>(s: StopScope, fn: () => Promise<T>): Promise<T> {
  return scope.run(s, fn);
}

/** La señal de la acción en curso (undefined fuera de una acción). */
export const stopSignal = (): AbortSignal | undefined => scope.getStore()?.signal;

/** ¿Se pidió parar la acción en curso (y aún se puede)? */
export const stopRequested = (): boolean => !!scope.getStore()?.signal.aborted;

export class StoppedError extends Error {
  readonly stopped = true;
  constructor(message = "stopped") {
    super(message);
    this.name = "StoppedError";
  }
}

export const isStoppedError = (e: unknown): boolean => (e as { stopped?: unknown })?.stopped === true;

/** Lanza StoppedError si se pidió parar la acción en curso. */
export function throwIfStopped(): void {
  if (stopRequested()) throw new StoppedError();
}

/**
 * Justo antes de lo que no se puede deshacer: si ya se pidió parar, para aquí (StoppedError); si no, marca la acción como
 * sin vuelta atrás (la app esconde «Parar» y el runner ignora las peticiones que lleguen después).
 */
export async function pointOfNoReturn(): Promise<void> {
  const s = scope.getStore();
  if (!s || s.noStop) return;
  throwIfStopped();
  s.noStop = true;
  await s.markNoStop().catch(() => undefined);
}
