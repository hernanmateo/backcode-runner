import type { Quota } from "./quota.js";

// Límite del plan de Claude Code (ventana de 5 h o semanal): una tarea que se para por él no es fallida. Queda «en
// espera del límit» (waiting + waitingQuota) y el runner la retoma sola cuando vuelve la cuota, sin arrancar mientras
// tanto otras tareas que fallarían igual. Aquí, lo que no depende de Firestore: reconocerlo y calcular hasta cuándo.

/** Lo que se sabe del límite al pararse: el motivo (texto corto) y, si lo dijo Claude Code, cuándo se reinicia. */
export interface PlanLimitHit {
  reason: string;
  /** Milisegundos (epoch) en que se reinicia la ventana, si se sabe. */
  resetsAt?: number;
}

/**
 * Mensajes de Claude Code al llegar al límite del plan: «Claude AI usage limit reached|1730000000», «You've hit your
 * limit · resets 3pm», «5-hour limit reached», un 429 o un rate_limit de la API. Otros errores (red, permisos, tests…)
 * no cuentan.
 */
const LIMIT_TEXT = /usage limit|limit reached|hit your (usage )?limit|(5-hour|five[ -]hour|weekly|session|opus|sonnet) limit|rate[_ -]?limit(ed)?\b|too many requests|\b429\b/i;

/** Reconoce el límite del plan en un texto de error (o en el resultado de Claude Code). */
export function planLimitFromText(text: string | undefined | null, now = Date.now()): PlanLimitHit | null {
  const s = String(text ?? "").trim();
  if (!s || !LIMIT_TEXT.test(s)) return null;
  const reason = s.split("\n").find((l) => LIMIT_TEXT.test(l))!.replace(/\|\d{9,13}\b/, "").trim().slice(0, 300);
  return { reason, ...withReset(resetFromText(s, now)) };
}

/** Evento rate_limit_event del SDK: rechazado por el límite del plan (resetsAt en segundos). */
export function planLimitFromEvent(info: { status?: string; resetsAt?: number; rateLimitType?: string } | null | undefined): PlanLimitHit | null {
  if (!info || info.status !== "rejected") return null;
  const resetsAt = typeof info.resetsAt === "number" && info.resetsAt > 0 ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : undefined;
  return { reason: `rate_limit: ${info.rateLimitType ?? "plan"}`, ...withReset(resetsAt) };
}

const withReset = (at: number | undefined) => (at !== undefined ? { resetsAt: at } : {});

/** Hora de reinicio que da el mensaje: «…|1730000000» (epoch) o «resets 3pm» / «resets at 15:30» (hora local). */
export function resetFromText(text: string, now = Date.now()): number | undefined {
  const epoch = /\|(\d{10}|\d{13})\b/.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const at = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!at) return undefined;
  let hour = Number(at[1]);
  const min = Number(at[2] ?? 0);
  const ampm = at[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return undefined;
  const d = new Date(now);
  d.setHours(hour, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Ventanas del plan agotadas ahora (≥ 100 %) y con reinicio en el futuro: hasta cuándo, la más tardía. */
export function quotaBlockedUntil(quota: Quota | null | undefined, now = Date.now()): number | null {
  if (!quota) return null;
  let until: number | null = null;
  for (const w of [quota.fiveHour, quota.sevenDay]) {
    if (!w || w.pct === null || w.pct < 100 || !w.resetsAt) continue;
    const at = Date.parse(w.resetsAt);
    if (Number.isFinite(at) && at > now) until = Math.max(until ?? 0, at);
  }
  return until;
}

/** Reintento prudente cuando no se sabe cuándo vuelve: 15 min, 30, 1 h, 2 h… hasta 3 h. */
export function backoffMs(tries: number): number {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, tries), 3 * 60 * 60_000);
}

/** Margen tras el reinicio, para no volver justo en el límite. */
const MARGIN_MS = 60_000;
/** Nunca más allá de 8 días (la ventana semanal), por si llega una hora rara. */
const MAX_WAIT_MS = 8 * 24 * 60 * 60_000;

/**
 * Hasta cuándo esperar: el reinicio que dijo Claude Code o, si no, el de la cuota leída (quota.ts) o, si tampoco, un
 * reintento con backoff según los intentos (`tries`).
 */
export function waitUntil(hit: PlanLimitHit, quota: Quota | null | undefined, tries: number, now = Date.now()): number {
  const known = hit.resetsAt && hit.resetsAt > now ? hit.resetsAt : quotaBlockedUntil(quota, now);
  const at = known ? known + MARGIN_MS : now + backoffMs(tries);
  return Math.min(at, now + MAX_WAIT_MS);
}
