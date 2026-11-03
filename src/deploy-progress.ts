// «Desplegarlo todo» paso a paso: progreso en vivo en el documento de la acción, un solo despliegue a la vez en el
// proyecto (candado locks/deploy, compartido por todos los runners) y reintentos automáticos de los errores transitorios
// (red, API, candados) de todos los tipos de despliegue: OTA, builds y despliegues de cualquier proveedor.
// Sin Firestore aquí: actions.ts le pasa las funciones del store, y así los tests no necesitan emulador.

/** Paso de un «Desplegarlo todo» que se está haciendo ahora (result.current). Horas en ms del reloj del runner. */
export interface CurrentStep {
  id: string;
  /** Posición (desde 0) en `order`. */
  index: number;
  startedAt: number;
  /** Esperando el candado: lo que se está desplegando en otro sitio (p. ej. «functions»). */
  waitingFor?: string;
  /** Reintento automático en curso (1…maxRetries) tras un error transitorio, y su motivo. */
  attempt?: number;
  maxRetries?: number;
  reason?: string;
}

/** Lo que se va escribiendo en `result` mientras corre (lo lee la app; al acabar lo sustituye el resultado final). */
export interface ProgressResult<S> {
  order: string[];
  steps: S[];
  current?: CurrentStep;
}

const retryOf = (c: CurrentStep | undefined): Partial<CurrentStep> =>
  c?.attempt ? { attempt: c.attempt, ...(c.maxRetries ? { maxRetries: c.maxRetries } : {}), ...(c.reason ? { reason: c.reason } : {}) } : {};

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
    this.current = { id, index, startedAt: same && this.current ? this.current.startedAt : this.now(), ...(waitingFor ? { waitingFor } : {}), ...(same ? retryOf(this.current) : {}) };
    return this.flush();
  }

  /** Ya no espera el candado: el paso empieza de verdad (cuenta el tiempo desde ahora). */
  running(id: string): Promise<void> {
    this.current = { id, index: this.order.indexOf(id), startedAt: this.now(), ...(this.current?.id === id ? retryOf(this.current) : {}) };
    return this.flush();
  }

  retrying(id: string, attempt: number, maxRetries?: number, reason?: string): Promise<void> {
    if (this.current?.id !== id) return Promise.resolve();
    this.current = { ...this.current, attempt, ...(maxRetries ? { maxRetries } : {}), ...(reason ? { reason: reason.slice(0, 300) } : {}) };
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

// --- Errores transitorios al desplegar (OTA, builds y despliegues de cualquier proveedor) ---

/** Comunes a todos: red, HTTP 429/5xx y los mensajes de «vuelve a probar». */
const COMMON_TRANSIENT_RE = [
  /\b(ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|EPIPE)\b|socket hang up/,
  /\b(HTTP( Error)?|status( code)?|response( code)?|returned error)\W{0,3}(429|500|502|503|504)\b/i,
  /\b(429|500|502|503|504)\W{0,3}(Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)/i,
  /Too Many Requests|Service (is )?(temporarily )?Unavailable|Internal Server Error|Bad Gateway|Gateway Time-?out/i,
  /try again later|please try again|temporarily unavailable/i,
  /\bquota\b.{0,80}(exceeded|limit)|RESOURCE_EXHAUSTED|rate[ -]limit/i,
  /network (error|timeout)|connection (reset|timed out|closed unexpectedly)|Connection reset by peer/i,
];

/** Propios de cada proveedor. Los de git (push o tag) valen para todos. */
const PROVIDER_TRANSIENT_RE: Record<string, RegExp[]> = {
  firebase: [
    /Failed to list functions/i,
    /An unexpected error has occurred/i,
    /Failed to (get|create) (Firebase )?(project|release|version)/i,
  ],
  eas: [
    /Request failed with status code (429|5\d\d)/i,
    /GraphQL request failed/i,
    /(Expo|EAS)( Build| Update)? (servers?|API|service)( is| are)? (temporarily )?(unavailable|down|experiencing)/i,
    /Failed to upload (the )?(bundle|assets?|archive|build)/i,
    /(upload|download)(ing)?.{0,60}(timed? ?out|was interrupted)/i,
    /Unexpected (response|error) from (the )?(Expo|EAS) (server|API)/i,
  ],
  wrangler: [/Cloudflare API.{0,200}(timed out|Service Unavailable|Internal Server Error|Bad Gateway)/i, /\[code: (10013|10500|7010)\]/],
  supabase: [/error sending request for url/i, /failed to connect to postgres.{0,80}(timeout|connection refused|reset)/i, /Unexpected error (retrieving|uploading|deploying)/i],
  git: [
    /RPC failed|early EOF|the remote end hung up unexpectedly|unexpected disconnect while reading/i,
    /Could not resolve host|Failed to connect to .{0,80} port \d+/i,
    /The requested URL returned error: (429|5\d\d)/i,
  ],
};

/** Otro despliegue (o git) tiene el candado: esperar y reintentar lo arregla. */
const LOCK_RE = [
  /(another|a previous|an existing) (deploy(ment)?|operation|build|update|release)( is)? (already )?(in progress|running)/i,
  /(deploy(ment)?|operation|update) (is )?already in progress/i,
  /Unable to create '[^']*\.lock'|index\.lock'?: File exists|could not (acquire|obtain) (the )?lock/i,
  /\block(ed)? (is )?(held|owned) by another|resource is locked/i,
  /concurrent (deploy(ment)?|update|modification)/i,
];

// Errores del código, la compilación, los tests, las credenciales, la configuración o el disco: reintentar no los arregla.
const REAL_RE = [
  /error TS\d+/,
  /SyntaxError|TypeError|ReferenceError/,
  /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/,
  /\bBuild failed\b|Failed to compile|compilation failed|Compilation error/i,
  /\bnpm (ERR!|error) code ELIFECYCLE/,
  /\bpredeploy\b.{0,80}(error|failed)/i,
  /Error: .{0,200} (is not|are not) (defined|a function)/,
  // Tests
  /\b\d+ (failing|tests? failed)\b|Tests?:\s+\d+ failed|AssertionError|Test suite failed/i,
  // Credenciales o sesión caducada
  /\b(HTTP( Error)?|status( code)?)\W{0,3}(401|403)\b|\b(401|403)\W{0,3}(Unauthorized|Forbidden)/i,
  /not logged in|not authenticated|log ?in required|(you must|please) (log|sign) ?in|session (has )?expired|(token|credentials?) (has |have )?expired|invalid (token|credentials|api key|access token)/i,
  /PERMISSION_DENIED|Permission denied \(publickey|Authentication error \[code: 10000\]|Authentication failed/i,
  // Configuración que falta
  /missing (required )?(config(uration)?|environment variable|env var)|is not configured|No (project|profile) .{0,40}(found|configured)/i,
  /Could not find (a )?(firebase\.json|eas\.json|wrangler\.(toml|json)|config)/i,
  // Disco lleno
  /ENOSPC|No space left on device|disk (is )?full/i,
];

export type DeployErrorKind = "transient" | "lock" | "real" | "unknown";

/**
 * Clasifica el error de un despliegue: `real` (código, compilación, tests, credenciales, configuración, disco: nunca se
 * reintenta), `lock` (otro despliegue en curso o un candado), `transient` (red, API caída, cuota…) o `unknown`.
 * `provider`: firebase, eas, wrangler, supabase…; sin él (o desconocido) se miran los patrones de todos.
 */
export function classifyDeployError(error: string, provider?: string): DeployErrorKind {
  if (!error) return "unknown";
  if (REAL_RE.some((re) => re.test(error))) return "real";
  if (LOCK_RE.some((re) => re.test(error))) return "lock";
  const own = provider && PROVIDER_TRANSIENT_RE[provider] ? [...PROVIDER_TRANSIENT_RE[provider], ...PROVIDER_TRANSIENT_RE.git] : Object.values(PROVIDER_TRANSIENT_RE).flat();
  return [...COMMON_TRANSIENT_RE, ...own].some((re) => re.test(error)) ? "transient" : "unknown";
}

/** Si el error de un despliegue es transitorio (de la red, la API o un candado) y vale la pena reintentarlo. */
export function isTransientDeployError(error: string, provider?: string): boolean {
  const kind = classifyDeployError(error, provider);
  return kind === "transient" || kind === "lock";
}

/** El motivo corto de un reintento: la línea del error que lo hace transitorio o, si no, la última no vacía. */
export function transientReason(error: string, provider?: string): string {
  const lines = error.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => isTransientDeployError(l, provider)) ?? lines.at(-1) ?? "").slice(0, 300);
}

/** Reintentos automáticos: 2 por defecto y nunca más de 3, aunque el proyecto tenga otro número. */
export const DEFAULT_DEPLOY_RETRIES = 2;
export const MAX_DEPLOY_RETRIES = 3;
export const clampDeployRetries = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_DEPLOY_RETRIES, Math.max(0, Math.floor(n))) : DEFAULT_DEPLOY_RETRIES);

/** Esperas (crecientes) antes de cada reintento: 20 s, 60 s y 120 s. */
export const RETRY_DELAYS_MS = [20_000, 60_000, 120_000];
export const retryDelays = (retries: unknown): number[] => RETRY_DELAYS_MS.slice(0, clampDeployRetries(retries));

/**
 * Ejecuta `run` y, si falla con un error que `transient` da por transitorio, lo reintenta tras cada espera de `delays`
 * (como mucho MAX_DEPLOY_RETRIES; avisa con `onRetry`, que lo deja en el log). Un fallo real, o el último intento, se
 * devuelve tal cual: ya no se reintenta más. `reasons`: el error de cada intento fallido, en orden.
 */
export async function retryTransient<R extends { ok: boolean; result: { error?: string } }>(
  run: () => Promise<R>,
  opts: { transient: (error: string, done: R) => boolean; delays?: number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, waitMs: number, error: string) => void | Promise<void> },
): Promise<R & { attempts: number; reasons: string[] }> {
  const delays = (opts.delays ?? retryDelays(DEFAULT_DEPLOY_RETRIES)).slice(0, MAX_DEPLOY_RETRIES);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reasons: string[] = [];
  for (let attempt = 0; ; attempt++) {
    const done = await run();
    const error = String(done.result.error ?? "");
    if (!done.ok) reasons.push(error);
    if (done.ok || attempt >= delays.length || !opts.transient(error, done)) return { ...done, attempts: attempt + 1, reasons };
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
