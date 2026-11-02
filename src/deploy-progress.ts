// «Desplegarlo todo» paso a paso: progreso en vivo en el documento de la acción, un solo despliegue a la vez en el
// proyecto (candado locks/deploy, compartido por todos los runners) y reintentos de los errores transitorios de Firebase.
// Sin Firestore aquí: actions.ts le pasa las funciones del store, y así los tests no necesitan emulador.

/** Paso de un «Desplegarlo todo» que se está haciendo ahora (result.current). Horas en ms del reloj del runner. */
export interface CurrentStep {
  id: string;
  /** Posición (desde 0) en `order`. */
  index: number;
  startedAt: number;
  /** Esperando el candado: lo que se está desplegando en otro sitio (p. ej. «functions»). */
  waitingFor?: string;
  /** Reintento en curso (1 o 2) tras un error transitorio. */
  attempt?: number;
}

/** Lo que se va escribiendo en `result` mientras corre (lo lee la app; al acabar lo sustituye el resultado final). */
export interface ProgressResult<S> {
  order: string[];
  steps: S[];
  current?: CurrentStep;
}

/**
 * Escribe el progreso con `write` (updateDoc del resultado). Nunca lanza: si una escritura falla, el despliegue sigue y
 * la siguiente lo pone al día. Las escrituras van en serie, en el orden en que se piden.
 */
export class DeployProgress<S extends { id: string }> {
  private chain: Promise<void> = Promise.resolve();
  private current: CurrentStep | undefined;
  readonly steps: S[] = [];

  constructor(
    readonly order: string[],
    private readonly write: (result: ProgressResult<S>) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): ProgressResult<S> {
    return { order: [...this.order], steps: [...this.steps], ...(this.current ? { current: { ...this.current } } : {}) };
  }

  private flush(): Promise<void> {
    const data = this.snapshot();
    this.chain = this.chain.then(() => this.write(data)).catch(() => undefined);
    return this.chain;
  }

  /** Empieza (o espera para empezar) el paso `id`. */
  start(id: string, waitingFor?: string): Promise<void> {
    const index = this.order.indexOf(id);
    const same = this.current?.id === id;
    this.current = { id, index, startedAt: same && this.current ? this.current.startedAt : this.now(), ...(waitingFor ? { waitingFor } : {}), ...(same && this.current?.attempt ? { attempt: this.current.attempt } : {}) };
    return this.flush();
  }

  /** Ya no espera el candado: el paso empieza de verdad (cuenta el tiempo desde ahora). */
  running(id: string): Promise<void> {
    this.current = { id, index: this.order.indexOf(id), startedAt: this.now(), ...(this.current?.id === id && this.current.attempt ? { attempt: this.current.attempt } : {}) };
    return this.flush();
  }

  retrying(id: string, attempt: number): Promise<void> {
    if (this.current?.id !== id) return Promise.resolve();
    this.current = { ...this.current, attempt };
    return this.flush();
  }

  /** Paso acabado (bien o mal): deja de ser el actual. */
  finish(step: S): Promise<void> {
    this.steps.push(step);
    if (this.current?.id === step.id) this.current = undefined;
    return this.flush();
  }

  /** Espera a que se hayan hecho todas las escrituras pedidas (antes del resultado final, para no pisarlo). */
  settled(): Promise<void> {
    return this.chain;
  }
}

// --- Errores transitorios de Firebase al desplegar functions ---

const TRANSIENT_RE = [
  /Failed to list functions/i,
  /An unexpected error has occurred/i,
  /\bHTTP Error: (429|500|502|503|504)\b/i,
  /\b(429|503)\b.{0,40}(Too Many Requests|Service Unavailable|unavailable|quota)/i,
  /(Too Many Requests|Service Unavailable)/i,
  /\bquota\b.{0,80}(exceeded|limit)|RESOURCE_EXHAUSTED|rate limit/i,
  /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up)\b/,
];
// Errores del código o de la compilación: reintentar no los arregla.
const REAL_RE = [
  /error TS\d+/,
  /SyntaxError|TypeError|ReferenceError/,
  /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/,
  /\bBuild failed\b|Failed to compile|compilation failed/i,
  /\bnpm (ERR!|error) code ELIFECYCLE/,
  /\bpredeploy\b.{0,80}(error|failed)/i,
  /Error: .{0,200} (is not|are not) (defined|a function)/,
];

/** Si el error de un despliegue de Firebase es transitorio (de la API) y vale la pena reintentarlo. */
export function isTransientDeployError(error: string): boolean {
  if (!error) return false;
  if (REAL_RE.some((re) => re.test(error))) return false;
  return TRANSIENT_RE.some((re) => re.test(error));
}

/** Esperas antes de cada reintento (como mucho 2): 20 s y 60 s. */
export const RETRY_DELAYS_MS = [20_000, 60_000];

/**
 * Ejecuta `run` y, si falla con un error que `transient` da por transitorio, lo reintenta tras cada espera de `delays`
 * (avisando con `onRetry`, que lo deja en el log). Un fallo real, o el último intento, se devuelve tal cual.
 */
export async function retryTransient<R extends { ok: boolean; result: { error?: string } }>(
  run: () => Promise<R>,
  opts: { transient: (error: string) => boolean; delays?: number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, waitMs: number, error: string) => void | Promise<void> },
): Promise<R & { attempts: number }> {
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const done = await run();
    const error = String(done.result.error ?? "");
    if (done.ok || attempt >= delays.length || !opts.transient(error)) return { ...done, attempts: attempt + 1 };
    await opts.onRetry?.(attempt + 1, delays[attempt], error);
    await sleep(delays[attempt]);
  }
}

// --- Un solo despliegue a la vez en el proyecto ---

export type LockAttempt = { ok: true } | { ok: false; step: string };

export interface DeployLock {
  /** Intenta tomar (o renovar) el candado para el paso `step` de la acción `action`. */
  take(action: string, step: string): Promise<LockAttempt>;
  release(action: string): Promise<void>;
}

/** Cada cuánto se reintenta tomar el candado mientras otro despliega, y cada cuánto se renueva mientras se tiene. */
export const LOCK_POLL_MS = 15_000;
export const LOCK_RENEW_MS = 60_000;

/**
 * Ejecuta `fn` con el candado de despliegue del proyecto: si lo tiene otro (otro runner u otra persona desplegando),
 * espera llamando a `onWait` con lo que se está desplegando. Mientras dura se renueva y al acabar se suelta siempre.
 */
export async function withDeployLock<T>(
  lock: DeployLock,
  action: string,
  step: string,
  fn: () => Promise<T>,
  opts: { onWait?: (busyWith: string) => void | Promise<void>; onAcquired?: () => void | Promise<void>; sleep?: (ms: number) => Promise<void>; pollMs?: number; renewMs?: number; shouldStop?: () => boolean } = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: string | undefined;
  for (;;) {
    const got = await lock.take(action, step).catch((): LockAttempt => ({ ok: true }));
    if (got.ok) break;
    if (got.step !== last) {
      last = got.step;
      await opts.onWait?.(got.step);
    }
    if (opts.shouldStop?.()) break;
    await sleep(opts.pollMs ?? LOCK_POLL_MS);
  }
  if (last !== undefined) await opts.onAcquired?.();
  const renew = setInterval(() => void lock.take(action, step).catch(() => undefined), opts.renewMs ?? LOCK_RENEW_MS);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await lock.release(action).catch(() => undefined);
  }
}
