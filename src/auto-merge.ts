import type { ActionResult, MergeBlock } from "./actions.js";
import { t } from "./i18n.js";

// «Modo auto» del proyecto (ajuste `autoMerge`, solo admins): cuando una tarea termina con su PR abierto, el runner que
// la ejecutó espera a la CI y la mergea (squash) él solo, con el mismo merge que «Mergear todo» (actions.ts). Si choca con
// la rama principal o los checks fallan, Claude lo arregla con «Arreglar con Claude» / «Devolver a Claude Code»
// (conflicts.ts, fix-checks.ts) y se reintenta, hasta `retries` veces. Sin CI no se mergea nunca. Desplegar o publicar
// sigue siendo manual: aquí solo se mergea.
//
// En la tarea (`autoMerge`) queda el estado, que la app enseña: waiting (esperando a la CI o al turno), fixing (Claude
// arregla: la tarjeta vuelve a «En curso» con el motivo), merged, gaveUp (agotó los reintentos) o stopped (no se puede
// mergear solo: sin CI, PR cerrado…). Las dos últimas dejan la tarea en «Para revisar» y avisan.

export type AutoMergeStatus = "waiting" | "fixing" | "merged" | "gaveUp" | "stopped";
export interface AutoMergeState {
  state: AutoMergeStatus;
  attempts: number;
  reason?: string;
}

/** Reintentos por defecto (el proyecto puede fijar otro entre 1 y 10: autoMergeRetries). */
export const DEFAULT_RETRIES = 3;
export const clampRetries = (n: unknown) => (typeof n === "number" && Number.isInteger(n) ? Math.min(10, Math.max(1, n)) : DEFAULT_RETRIES);

/** El turno de merge del proyecto dura más que la espera máxima a la CI (15 min, wait-checks.ts). */
export const TURN_LEASE_MS = 25 * 60_000;
const TURN_POLL_MS = 20_000;
/** Tras subir un arreglo, margen para que la CI registre el commit nuevo antes de volver a leer los checks. */
const SETTLE_MS = 60_000;

/**
 * Punto de enganche justo antes de cada merge automático (con el turno del proyecto en mano), p. ej. para un futuro
 * «code review automático». Si devuelve ok: false, no se mergea y la tarea queda para revisar con ese motivo.
 */
export type BeforeMergeHook = (featureId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
let beforeMergeHook: BeforeMergeHook | undefined;
export function setBeforeMergeHook(hook: BeforeMergeHook | undefined): void {
  beforeMergeHook = hook;
}

type Outcome = { ok: boolean; result: ActionResult };
export interface AutoMergeDeps {
  featureId: string;
  base: string;
  retries: number;
  /** false si el runner sabe que el repo no tiene CI (capabilities.ci); undefined si aún no lo sabe. */
  hasCi: boolean | undefined;
  merge: () => Promise<Outcome & { blocked?: MergeBlock }>;
  fixChecks: () => Promise<Outcome>;
  fixConflicts: () => Promise<Outcome>;
  setState: (state: AutoMergeState) => Promise<void>;
  takeTurn: () => Promise<boolean>;
  releaseTurn: () => Promise<void>;
  log?: (text: string) => void;
  beforeMerge?: BeforeMergeHook;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
}

/** Mergea solo el PR de una tarea terminada, arreglando y reintentando si hace falta. Devuelve el estado final. */
export async function autoMerge(d: AutoMergeDeps): Promise<AutoMergeState> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stop = d.shouldStop ?? (() => false);
  const hook = d.beforeMerge ?? beforeMergeHook;
  const finish = async (state: AutoMergeState) => {
    await d.setState(state).catch(() => undefined);
    return state;
  };
  let attempts = 0;
  if (d.hasCi === false) return finish({ state: "stopped", attempts, reason: t("auto.noCi") });
  await d.setState({ state: "waiting", attempts, reason: t("auto.waiting") }).catch(() => undefined);
  for (;;) {
    let warned = false;
    while (!(await d.takeTurn())) {
      if (stop()) return { state: "waiting", attempts };
      if (!warned) d.log?.(t("auto.waitTurn"));
      warned = true;
      await sleep(TURN_POLL_MS);
    }
    let done: Outcome & { blocked?: MergeBlock };
    try {
      const review = hook ? await hook(d.featureId) : { ok: true as const };
      if (!review.ok) return await finish({ state: "stopped", attempts, reason: t("auto.stopped", { reason: review.reason }) });
      done = await d.merge().catch((e: Error) => ({ ok: false, result: { error: String(e.message ?? e).slice(0, 500) } }));
    } finally {
      await d.releaseTurn().catch(() => undefined);
    }
    if (done.ok) return finish({ state: "merged", attempts, reason: t("auto.merged") });
    const error = done.result.error ?? "";
    // «Sin CI» solo si de verdad no la hay: con CI, merge() devuelve ciNoChecks (o conflicts) cuando no aparece ningún check.
    if (done.blocked === "noChecks") return finish({ state: "stopped", attempts, reason: t(d.hasCi === true ? "auto.ciNoChecks" : "auto.noCi") });
    if (done.blocked === "ciNoChecks") return finish({ state: "stopped", attempts, reason: t("auto.ciNoChecks") });
    if (done.blocked !== "checks" && done.blocked !== "conflicts") {
      return finish({ state: "stopped", attempts, reason: t("auto.stopped", { reason: done.blocked === "pending" ? t("auto.pending") : error }) });
    }
    if (attempts >= d.retries) return finish({ state: "gaveUp", attempts, reason: t("auto.gaveUp", { max: d.retries, reason: error }) });
    if (stop()) return { state: "waiting", attempts };
    attempts++;
    const reason =
      done.blocked === "checks"
        ? t("auto.fixingChecks", { checks: (done.result.checks ?? []).join(", ") || "CI", n: attempts, max: d.retries })
        : t("auto.fixingConflicts", { base: d.base, n: attempts, max: d.retries });
    await d.setState({ state: "fixing", attempts, reason }).catch(() => undefined);
    d.log?.(reason);
    const fix = await (done.blocked === "checks" ? d.fixChecks() : d.fixConflicts()).catch((e: Error) => ({ ok: false, result: { error: String(e.message ?? e) } }));
    if (!fix.ok) d.log?.(fix.result.error ?? "");
    await d.setState({ state: "waiting", attempts, reason: t("auto.waiting") }).catch(() => undefined);
    if (stop()) return { state: "waiting", attempts };
    await sleep(SETTLE_MS);
  }
}
