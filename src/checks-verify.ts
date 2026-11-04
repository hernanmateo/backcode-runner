// Verificación de los checks al terminar una tarea: con «Checks en local», en cuanto la tarea abre o actualiza su PR el
// runner pasa los checks del backcode.toml sobre el último commit del PR y guarda el resultado en la tarea, atado a los
// commits exactos (el del PR y el de la rama base en ese momento). Al mergear, si pasó y nada ha cambiado desde entonces,
// no se repiten. Con la CI del host (GitHub Actions…) manda la CI; sin CI («none») o con «sin checks», no hay nada que
// verificar.

import { parseChecksMode } from "./local-checks.js";

/** El resultado guardado en la tarea (`checksVerify`). */
export interface ChecksVerification {
  state: "verifying" | "passed" | "failed";
  headSha: string;
  /** La rama base (remota) cuando se verificó. */
  baseSha: string;
  /** Milisegundos (en Firestore, un Timestamp: quien lo lee lo convierte). */
  checkedAt?: number;
  /** Los checks que se pasaron (sus nombres en el backcode.toml). */
  checks?: string[];
  summary?: string;
}

/** Un resultado de más de 7 días no se reutiliza (como la caché de checks-cache.ts). */
export const VERIFY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Lo más que puede tardar la verificación de una tarea antes de darla por fallida. */
export const VERIFY_TIMEOUT_MS = 30 * 60_000;
/** Lo que cabe del resumen de lo que falló. */
export const VERIFY_SUMMARY_MAX = 300;

/** ¿Se verifican los checks al terminar la tarea? Solo con checks en local y alguno declarado. */
export function shouldVerifyAfterTask(mode: unknown, declared: number): boolean {
  return parseChecksMode(mode) === "local" && declared > 0;
}

export interface MergeChecksInput {
  /** El modo efectivo del proyecto ("host" | "local" | "none"; cualquier otro valor cuenta como "host"). */
  mode: unknown;
  /** Merge puntual sin checks. */
  skipChecks?: boolean;
  verification?: ChecksVerification | null;
  /** El último commit del PR ahora. */
  headSha: string;
  /** La rama base (remota) ahora. */
  baseSha: string;
  /** ¿El commit verificado ya contiene la base actual? (git merge-base --is-ancestor base head) */
  baseContained: boolean;
  /** Los checks que se pasarían ahora (de la rama base). */
  checks: string[];
  now: number;
}

/**
 * Qué hacer con la verificación guardada al mergear (complementa mergeChecksPlan de local-checks.ts, que elige dónde se
 * comprueba):
 * - "none": no se comprueba nada (proyecto sin CI o merge puntual sin checks).
 * - "host": la CI del host (como siempre).
 * - "reuse": checks en local ya verificados en verde sobre este mismo PR y esta misma base: no se repiten.
 * - "run": checks en local, se pasan como siempre.
 */
export function verifiedChecksPlan(i: MergeChecksInput): "none" | "host" | "reuse" | "run" {
  const mode = parseChecksMode(i.mode);
  if (mode === "none" || i.skipChecks === true) return "none";
  if (mode === "host") return "host";
  const v = i.verification;
  if (!v || v.state !== "passed" || !i.headSha || v.headSha !== i.headSha) return "run";
  if (v.baseSha !== i.baseSha && !i.baseContained) return "run";
  if (typeof v.checkedAt !== "number" || i.now - v.checkedAt > VERIFY_MAX_AGE_MS || v.checkedAt > i.now + 60_000) return "run";
  const same = [...(v.checks ?? [])].sort().join("\n") === [...i.checks].sort().join("\n");
  return same && i.checks.length > 0 ? "reuse" : "run";
}

/** Lee el `checksVerify` de una tarea tal como está en Firestore (null si falta o no tiene forma). */
export function readVerification(raw: unknown): ChecksVerification | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!["verifying", "passed", "failed"].includes(r.state as string) || typeof r.headSha !== "string" || typeof r.baseSha !== "string") return null;
  const at = r.checkedAt as { toMillis?: () => number } | number | undefined;
  const checkedAt = typeof at === "number" ? at : typeof at?.toMillis === "function" ? at.toMillis() : undefined;
  return {
    state: r.state as ChecksVerification["state"],
    headSha: r.headSha,
    baseSha: r.baseSha,
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(Array.isArray(r.checks) ? { checks: r.checks.filter((c): c is string => typeof c === "string") } : {}),
    ...(typeof r.summary === "string" ? { summary: r.summary } : {}),
  };
}
