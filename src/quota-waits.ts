import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Tareas en espera del límite del plan de Claude Code (plan-limit.ts) de este runner en este proyecto. Viven en memoria
// y en un fichero local (~/.backcode/quota/<proyecto>.json) que sobrevive a los reinicios: así la represa no depende de
// que Firestore haya aceptado la marca waitingQuota (reglas antiguas sin desplegar). Sin Firestore: se prueba solo.

/**
 * Cómo quedó la tarea al pararse:
 * - marked: 'waiting' con la marca waitingQuota (lo normal); se reanuda con store.resumeFromQuota.
 * - queued: las reglas no aceptaron la marca y volvió a la cola ('execute'); la retiene el bloqueo hasta su hora.
 * - unmarked: 'waiting' sin marca (ni la marca ni la cola); no se puede reanudar sola: se avisa en la tarea.
 */
export type QuotaWaitMode = "marked" | "queued" | "unmarked";

export interface QuotaWait {
  /** Hora (epoch ms) prevista de represa. */
  until: number;
  /** Veces seguidas que se ha parado por el límite (backoff). */
  tries: number;
  mode: QuotaWaitMode;
  /** Ya reanudada (vuelve a la cola o se está ejecutando): no bloquea ni se vuelve a reanudar; guarda los intentos. */
  resumed?: boolean;
}

/** Nunca se guarda una espera más allá de 8 días (la ventana semanal). */
const MAX_AGE_MS = 9 * 24 * 60 * 60_000;
const MODES: QuotaWaitMode[] = ["marked", "queued", "unmarked"];

export class QuotaWaits {
  private map = new Map<string, QuotaWait>();

  /** `file`: dónde se guardan (sin él, solo en memoria: tests). */
  constructor(private readonly file?: string) {}

  /** Las esperas guardadas antes de reiniciar el runner (las caducadas o mal formadas se descartan). */
  load(now = Date.now()): void {
    if (!this.file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    for (const [id, w] of Object.entries(raw as Record<string, Partial<QuotaWait>>)) {
      if (!w || typeof w.until !== "number" || !MODES.includes(w.mode as QuotaWaitMode) || Math.abs(w.until - now) > MAX_AGE_MS) continue;
      this.map.set(id, { until: w.until, tries: typeof w.tries === "number" ? w.tries : 0, mode: w.mode as QuotaWaitMode, ...(w.resumed ? { resumed: true } : {}) });
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[quota] ${(err as Error).message}`);
    }
  }

  get(id: string): QuotaWait | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }

  entries(): [string, QuotaWait][] {
    return [...this.map];
  }

  set(id: string, w: QuotaWait): void {
    this.map.set(id, w);
    this.save();
  }

  delete(id: string): void {
    if (this.map.delete(id)) this.save();
  }

  /** Vuelve a la cola o arranca: deja de bloquear, pero conserva los intentos por si se vuelve a topar con el límite. */
  markResumed(id: string): void {
    const w = this.map.get(id);
    if (!w || w.resumed) return;
    this.map.set(id, { ...w, resumed: true });
    this.save();
  }

  isResumed(id: string): boolean {
    return this.map.get(id)?.resumed === true;
  }

  /**
   * Hasta cuándo no arranca ninguna tarea (fallarían igual): la espera pendiente más tardía. 0 si no hay ninguna. Como se
   * calcula de las esperas, se libera solo al reanudarlas, cancelarlas o retomarlas a mano.
   */
  blockedUntil(now = Date.now()): number {
    let until = 0;
    for (const w of this.map.values()) if (!w.resumed && w.until > now) until = Math.max(until, w.until);
    return until;
  }

  /** Las esperas pendientes cuya hora ya llegó (hay que mirar la cuota y reanudarlas). */
  due(now = Date.now()): [string, QuotaWait][] {
    return [...this.map].filter(([, w]) => !w.resumed && w.until <= now);
  }

  /** Ha vuelto la cuota (lectura real o una tarea que trabaja sin toparse con el límite): todas vencen ya. */
  release(now = Date.now()): boolean {
    let changed = false;
    for (const [id, w] of this.map) {
      if (w.resumed || w.until <= now) continue;
      this.map.set(id, { ...w, until: now });
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  /** Aún no ha vuelto: las pendientes vencidas pasan a `until`. */
  postpone(ids: string[], until: number): void {
    for (const id of ids) {
      const w = this.map.get(id);
      if (w && !w.resumed) this.map.set(id, { ...w, until });
    }
    this.save();
  }

  /**
   * Lo que hay en Firestore: `waiting` son mis tareas en 'waiting' (las de compañeros que ejecuto con mi runner incluidas)
   * y `marked`, las que tienen la marca. Añade las marcadas que no conocía (p. ej. de antes de este fichero) y quita las
   * que ya no esperan porque alguien las canceló, las liberó o las reanudó a mano (así dejan de bloquear la cola).
   */
  syncWaiting(waiting: Set<string>, marked: { id: string; until: number; tries: number }[]): string[] {
    const removed: string[] = [];
    for (const [id, w] of this.map) {
      if (w.resumed || w.mode === "queued" || waiting.has(id)) continue;
      this.map.delete(id);
      removed.push(id);
    }
    let added = false;
    for (const m of marked) {
      const w = this.map.get(m.id);
      if (w && w.mode !== "unmarked") continue;
      this.map.set(m.id, { until: m.until, tries: Math.max(m.tries, w?.tries ?? 0), mode: "marked" });
      added = true;
    }
    if (removed.length || added) this.save();
    return removed;
  }

  /** Las que volvieron a la cola sin marca (queued) y ya no están en ella ni ejecutándose: canceladas o liberadas. */
  syncQueued(alive: Set<string>): string[] {
    const removed: string[] = [];
    for (const [id, w] of this.map) {
      if (w.mode !== "queued" || w.resumed || alive.has(id)) continue;
      this.map.delete(id);
      removed.push(id);
    }
    if (removed.length) this.save();
    return removed;
  }
}

/**
 * De las tareas en 'waiting' que traen las dos consultas (assignee y runnerUid), las que ejecuta este runner (`executes`:
 * la de un compañero con mi runner sí; la mía con el runner de otro, no: la reanuda el suyo con su cuota) y, de ellas,
 * las que llevan la marca del límite del plan.
 */
export function quotaWaitsOf(
  docs: { id: string; data: { assignee?: string; runnerUid?: string; waitingQuota?: { until?: { toMillis(): number } | null; tries?: number } | null } }[],
  executes: (f: { assignee?: string; runnerUid?: string }) => boolean,
): [Set<string>, { id: string; until: number; tries: number }[]] {
  const waiting = new Set<string>();
  const marked: { id: string; until: number; tries: number }[] = [];
  for (const d of docs) {
    if (waiting.has(d.id) || !executes(d.data)) continue;
    waiting.add(d.id);
    const w = d.data.waitingQuota;
    if (w?.until) marked.push({ id: d.id, until: w.until.toMillis(), tries: w.tries ?? 0 });
  }
  return [waiting, marked];
}

/** Lo que necesitan aparcar y reanudar de Firestore (store.ts); en los tests, uno falso. */
export interface QuotaWaitStore {
  /** 'waiting' con la marca waitingQuota (falla con reglas antiguas). */
  markWaiting(id: string): Promise<void>;
  /** Vuelta a la cola ('execute'): la transición de siempre del runner, también con reglas antiguas. */
  requeue(id: string): Promise<void>;
  /** 'waiting' sin la marca (último recurso). */
  plainWaiting(id: string): Promise<void>;
  resumeFromQuota(id: string): Promise<boolean>;
  postponeQuota(id: string, until: number, tries: number): Promise<boolean>;
}

/**
 * Aparca una tarea parada por el límite y la apunta (memoria y fichero): con la marca si se puede; si las reglas no la
 * aceptan, de vuelta a la cola retenida hasta su hora; y si ni eso, en espera sin marca (se avisa en la tarea).
 */
export async function parkForQuota(waits: QuotaWaits, store: QuotaWaitStore, id: string, until: number, tries: number, warn: (msg: string) => void = () => undefined): Promise<QuotaWaitMode> {
  const mode = await store.markWaiting(id).then(
    () => "marked" as const,
    (err: Error) => {
      warn(`${id} waitingQuota: ${err?.message ?? err}`);
      return store.requeue(id).then(
        () => "queued" as const,
        () => store.plainWaiting(id).then(() => "unmarked" as const, () => "unmarked" as const),
      );
    },
  );
  waits.set(id, { until, tries, mode });
  return mode;
}

/** El error es de permisos (reglas): reintentarlo no sirve. */
const denied = (err: unknown) => (err as { code?: string } | null)?.code === "permission-denied";

/**
 * Represa de las esperas vencidas. `still`: hasta cuándo sigue agotada la cuota leída (null si ha vuelto o no se sabe).
 * Devuelve las reanudadas, las que ya no esperaban (canceladas o reanudadas a mano), las aplazadas y las que no se
 * pueden reanudar solas (hay que avisarlo en la tarea: nunca se pierden en silencio).
 */
export async function resumeDue(waits: QuotaWaits, store: QuotaWaitStore, still: number | null, now = Date.now(), warn: (msg: string) => void = () => undefined): Promise<{ resumed: string[]; gone: string[]; manual: string[]; postponed: string[] }> {
  const out = { resumed: [] as string[], gone: [] as string[], manual: [] as string[], postponed: [] as string[] };
  const due = waits.due(now);
  if (still) {
    const until = still + 60_000;
    for (const [id, w] of due) {
      if (w.mode !== "marked") continue;
      const ok = await store.postponeQuota(id, until, w.tries).catch(() => true);
      if (!ok) {
        waits.delete(id);
        out.gone.push(id);
      }
    }
    out.postponed = due.map(([id]) => id).filter((id) => waits.has(id));
    waits.postpone(out.postponed, until);
    return out;
  }
  for (const [id, w] of due) {
    if (w.mode === "queued") {
      // Ya está en la cola ('execute'): basta con dejar de retenerla.
      waits.markResumed(id);
      out.resumed.push(id);
      continue;
    }
    const ok = w.mode === "unmarked" ? "manual" : await store.resumeFromQuota(id).catch((err: Error) => (warn(`${id} ${err?.message ?? err}`), denied(err) ? "manual" : null));
    if (ok === true) {
      // Se conserva la cuenta de intentos (para el backoff) hasta que la tarea trabaje sin toparse con el límite.
      waits.markResumed(id);
      out.resumed.push(id);
    } else if (ok === false) {
      waits.delete(id);
      out.gone.push(id);
    } else if (ok === "manual") {
      waits.delete(id);
      out.manual.push(id);
    }
    // null: error pasajero (red); se reintenta en la siguiente pasada.
  }
  return out;
}
