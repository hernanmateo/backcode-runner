// «Reintenta las tareas fallidas por errores temporales» (ajuste del proyecto `autoRetry`, solo admins): cuando una tarea
// termina fallida, el runner que la ejecutó decide si se puede volver a intentar sola. Solo los errores del entorno que se
// arreglan volviéndolo a probar (red, API caída o sobrecargada, el runner o el Mac se pararon a media ejecución, un push
// rechazado porque la rama remota avanzó). Nunca credenciales, permisos, herramientas que faltan, disco lleno, presupuesto
// agotado, tests o compilación en rojo, Claude que dice que no puede, ni una parada pedida por el usuario.
//
// Límite estricto: como mucho `max` reintentos por tarea (2 por defecto, 3 como mucho), con una espera creciente, y un tope
// de coste para la suma de todos los intentos. Al llegar a cualquiera de los dos, queda fallida y no se reintenta más.
// El límite del plan de Claude Code (usage limit) no se trata aquí ni cuenta como reintento: lo lleva otra parte.
//
// En la tarea (`autoRetry`) queda el estado, que la app enseña: scheduled (reintento programado), retrying (en marcha),
// gaveUp (agotó reintentos o el tope de coste) o skipped (el error no es temporal: no se reintenta, con el motivo).

export type RetryableKind = "network" | "overloaded" | "interrupted" | "pushRejected";
export type FinalKind = "credentials" | "permissions" | "missingTool" | "diskFull" | "budget" | "cannotDo" | "tests" | "build" | "cancelled" | "unknown";
export type FailureKind = RetryableKind | FinalKind;
export type Classification = { kind: RetryableKind; retry: true } | { kind: FinalKind; retry: false } | { kind: "planLimit"; retry: false };

export const RETRYABLE: readonly RetryableKind[] = ["network", "overloaded", "interrupted", "pushRejected"];

/** Reintentos por defecto y máximo configurable (el proyecto fija autoRetryMax entre 1 y 3). */
export const DEFAULT_RETRY_MAX = 2;
export const RETRY_MAX_LIMIT = 3;
export const clampRetryMax = (n: unknown) => (typeof n === "number" && Number.isInteger(n) ? Math.min(RETRY_MAX_LIMIT, Math.max(1, n)) : DEFAULT_RETRY_MAX);
/** Espera antes de cada reintento: 2 min, 10 min, 30 min. */
export const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];
/** Intentos que se guardan en la tarea (el original y los reintentos). */
const HISTORY_MAX = RETRY_MAX_LIMIT + 1;

export interface FailureInput {
  error?: string;
  /** Error conocido del runner: noPr / noPlan (Claude terminó sin hacer lo pedido). */
  errorCode?: string;
  /** Quien la dirige pidió pararla. */
  cancelled?: boolean;
  /** Coste de este intento (USD). */
  costUsd?: number;
}

// El orden importa: lo que no se reintenta nunca va antes (un 403 con un timeout sigue siendo de credenciales).
const RULES: [FailureKind | "planLimit", RegExp][] = [
  ["budget", /error_max_budget|max(imum)?[_ ]budget|budget (exceeded|exhausted|reached)|error_max_turns|max(imum)? turns/i],
  // Límite del plan de Claude Code (otra tarea lo lleva): ni se reintenta ni cuenta.
  ["planLimit", /usage limit|limit reached|rate.?limit|\b429\b|quota|resets? at|out of (extra )?usage/i],
  ["credentials", /not logged in|log ?in (again|first)|re-?authenticat|unauthori[sz]ed|invalid_grant|invalid (api )?key|authenticat(e|ion) (failed|required|error)|\b40[13]\b|forbidden|token (has )?expired|expired token|credentials?\b/i],
  ["permissions", /permission denied|access denied|\bEACCES\b|\bEPERM\b|operation not permitted/i],
  ["diskFull", /\bENOSPC\b|no space left/i],
  ["missingTool", /command not found|not recognized as an internal|could not determine executable|spawn \S+ ENOENT/i],
  ["tests", /tests? (failed|failing)|\d+ failing|test suites?: \d+ failed|\d+ tests? failed/i],
  ["build", /\berror TS\d{4}\b|\bTS\d{4}:|compil(ation|e|er) (error|failed)|build failed|failed to compile|cannot find module/i],
  ["network", /\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|socket hang up|\bECONNREFUSED\b|\bENOTFOUND\b|network (error|is unreachable)|fetch failed/i],
  ["overloaded", /\b(500|502|503|504|529)\b|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|try again later/i],
  ["pushRejected", /non-fast-forward|\(fetch first\)|updates were rejected because|failed to push some refs|stale info/i],
  // El runner o el Mac se pararon a media ejecución (store.orphan en es/en/ca, lease caducado, proceso muerto).
  ["interrupted", /runner se detuvo durante|runner stopped during|runner s'ha aturat durant|lease (expired|caducad)|process (exited|died|was killed)|\bSIGKILL\b|\bSIGTERM\b|mac (went to sleep|slept)/i],
];

/** ¿Se puede reintentar este fallo? Función pura (auto-retry.test.ts). */
export function classifyFailure(input: FailureInput): Classification {
  if (input.cancelled) return { kind: "cancelled", retry: false };
  const text = (input.error ?? "").trim();
  for (const [kind, re] of RULES) {
    if (!re.test(text)) continue;
    if (kind === "planLimit") return { kind, retry: false };
    if ((RETRYABLE as readonly string[]).includes(kind)) return { kind: kind as RetryableKind, retry: true };
    return { kind: kind as FinalKind, retry: false };
  }
  // Claude terminó sin PR o sin plan: dice que no puede (o no ha sabido); volver a probarlo no lo arregla.
  if (input.errorCode === "noPr" || input.errorCode === "noPlan") return { kind: "cannotDo", retry: false };
  return { kind: "unknown", retry: false };
}

export type AutoRetryStatus = "scheduled" | "retrying" | "gaveUp" | "skipped";
export interface AutoRetryAttempt {
  kind: FailureKind;
  costUsd: number;
}
export interface AutoRetryState {
  state: AutoRetryStatus;
  /** Reintentos automáticos hechos (o programados). */
  count: number;
  max: number;
  /** Motivo del último fallo. */
  kind: FailureKind;
  /** Cada intento fallido, en orden (el original y los reintentos). */
  history: AutoRetryAttempt[];
  /** Suma del coste de todos los intentos fallidos. */
  totalCostUsd: number;
  /** gaveUp por el tope de coste (y no por el número de reintentos). */
  costCap?: boolean;
  /** Cuándo toca el reintento (ms), si está programado. */
  nextAt?: number;
}

export interface RetrySettings {
  on: boolean;
  max: number;
  /** Tope de coste de todos los intentos (USD). */
  maxCostUsd: number;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Qué hacer con una tarea que acaba de fallar: null si no aplica (opción apagada o límite del plan, que no cuenta);
 * si no, el estado nuevo para la tarea. `prev`, el que tenía (de reintentos anteriores).
 */
export function decideRetry(prev: AutoRetryState | undefined, failure: FailureInput, settings: RetrySettings, now: number): AutoRetryState | null {
  if (!settings.on) return null;
  const c = classifyFailure(failure);
  if (c.kind === "planLimit") return null;
  const count = prev?.count ?? 0;
  const cost = Number.isFinite(failure.costUsd) && (failure.costUsd ?? 0) > 0 ? failure.costUsd! : 0;
  const history = [...(prev?.history ?? []), { kind: c.kind, costUsd: round(cost) }].slice(-HISTORY_MAX);
  const totalCostUsd = round((prev?.totalCostUsd ?? 0) + cost);
  const max = clampRetryMax(settings.max);
  const base = { count, max, kind: c.kind, history, totalCostUsd };
  if (!c.retry) return { ...base, state: "skipped" };
  // Ya se reintentó tantas veces como se permite (también si el máximo bajó desde entonces): fallida definitivamente.
  if (count >= max) return { ...base, state: "gaveUp" };
  if (totalCostUsd >= settings.maxCostUsd) return { ...base, state: "gaveUp", costCap: true };
  return { ...base, state: "scheduled", count: count + 1, nextAt: now + RETRY_DELAYS_MS[Math.min(count, RETRY_DELAYS_MS.length - 1)] };
}

/** ¿Toca ya lanzar el reintento programado? */
export const retryDue = (s: Pick<AutoRetryState, "state" | "nextAt"> | undefined, now: number) => s?.state === "scheduled" && (s.nextAt ?? 0) <= now;
