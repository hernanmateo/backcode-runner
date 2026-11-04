import type { Checks } from "./hosts.js";
import { stopRequested } from "./stop.js";

// Justo después de crear o actualizar un PR (o de mergear en la rama base) lo normal es que la CI siga en marcha: en vez
// de rechazar al momento el merge, el OTA, la build o el despliegue, se espera a que los checks terminen. El lease de la
// acción ya se renueva cada minuto mientras está en marcha (index.ts), así que la espera no lo hace caducar.

/** Cada cuánto se vuelven a consultar los checks en curso. */
export const CHECKS_POLL_MS = 15_000;
/** Máximo que se espera a la CI antes de rechazar la acción con los checks aún en curso. */
export const CHECKS_WAIT_MS = 15 * 60_000;
/**
 * En un repo con CI, margen para que aparezcan los checks de un PR recién subido: justo tras el push GitHub puede no
 * haber registrado aún ningún check run ("none"), y eso no significa «sin CI».
 */
export const CHECKS_APPEAR_MS = 4 * 60_000;
/** Lo mismo tras un push a la rama base (OTA, builds, despliegues): más corto, para no retrasarlos si la CI filtra la rama. */
export const BASE_CHECKS_APPEAR_MS = 90_000;

// Al parar o reiniciar el runner se deja de esperar (no se bloquea un reinicio 15 minutos): la acción falla con los
// checks en curso, como antes.
let stopped = false;
export function stopWaitingForChecks(): void {
  stopped = true;
}

export interface WaitOptions {
  pollMs?: number;
  maxMs?: number;
  /** Si > 0 (el repo tiene CI), "none" cuenta como «aún no han aparecido» y se sigue esperando hasta este margen. */
  noneGraceMs?: number;
  /** Inyectables para los tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  shouldStop?: () => boolean;
  /** Se llama una vez, al empezar a esperar (para avisar en el log). */
  onWait?: (checks: Checks) => void;
}

/**
 * Lee los checks y, mientras sigan en curso, vuelve a leerlos cada `pollMs` hasta `maxMs`. Devuelve los últimos en
 * cuanto dejan de estar en curso (green, failing o none), al agotar el tiempo o al parar el runner. Con `noneGraceMs`,
 * "none" también se sigue esperando, pero solo durante ese margen (desde que se empieza a esperar).
 */
export async function waitForChecks(read: () => Promise<Checks>, opts: WaitOptions = {}): Promise<Checks> {
  const pollMs = opts.pollMs ?? CHECKS_POLL_MS;
  const maxMs = opts.maxMs ?? CHECKS_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  // Al parar el runner o al pedir «Parar» la acción que espera (stop.ts).
  const shouldStop = opts.shouldStop ?? (() => stopped || stopRequested());
  const start = now();
  const deadline = start + maxMs;
  const noneDeadline = start + Math.min(opts.noneGraceMs ?? 0, maxMs);
  let checks = await read();
  let warned = false;
  const waiting = () => checks.state === "pending" || (checks.state === "none" && now() < noneDeadline);
  while (waiting() && !shouldStop()) {
    const left = (checks.state === "none" ? noneDeadline : deadline) - now();
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

export interface PrGateDeps {
  /** Lee los checks del PR. */
  read: () => Promise<Checks>;
  /** Ficheros del PR que chocan con la rama base (vacío si no chocan). */
  conflicts: () => Promise<string[]>;
  /** El repo tiene CI (capabilities.ci o un fichero de CI): "none" no es «sin CI». */
  ciExpected: boolean;
  wait?: WaitOptions;
}
/** Checks finales del PR; `conflicts` si salieron "none" porque el PR choca con la base; `ciNoChecks` si con CI no apareció ninguno. */
export interface PrGate {
  checks: Checks;
  conflicts?: string[];
  ciNoChecks?: boolean;
}

/**
 * Checks de un PR antes de mergearlo. GitHub no lanza los workflows `pull_request` si el PR choca con la base (no puede
 * crear el merge ref): sin ningún check, lo primero es mirar si hay conflictos. Si no los hay y el repo tiene CI, "none"
 * es «aún no han aparecido» y se espera hasta `CHECKS_APPEAR_MS`; si siguen sin aparecer, se vuelve a mirar si choca y,
 * si no, `ciNoChecks`. Solo sin CI "none" significa de verdad «no hay checks».
 */
export async function gatePrChecks(d: PrGateDeps): Promise<PrGate> {
  const first = await d.read();
  if (first.state === "none") {
    const files = await d.conflicts();
    if (files.length) return { checks: first, conflicts: files };
  }
  let reads = 0;
  const read = () => (reads++ === 0 ? Promise.resolve(first) : d.read());
  const checks = await waitForChecks(read, { ...d.wait, noneGraceMs: d.ciExpected ? (d.wait?.noneGraceMs ?? CHECKS_APPEAR_MS) : 0 });
  if (checks.state !== "none" || !d.ciExpected) return { checks };
  if (reads > 1) {
    const files = await d.conflicts();
    if (files.length) return { checks, conflicts: files };
  }
  return { checks, ciNoChecks: true };
}
