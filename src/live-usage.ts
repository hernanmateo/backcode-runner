// Consumo de una tarea: el que se escribe al final en `result` (a partir de los mensajes `result` del SDK) y el que se
// va enseñando en directo mientras se ejecuta (`liveUsage`), con el mismo cálculo para que cuadren.

/** Uso por modelo de un mensaje `result` del SDK (solo los campos que se usan). */
export interface SdkModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

/** `usage` de un mensaje `assistant` (API de Anthropic). */
export interface SdkTurnUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Lo acumulado en fases anteriores de la misma vuelta (con Remote Control de por medio hay varias). */
export interface Spent {
  costUsd: number;
  turns: number;
  input: number;
  output: number;
  cache: number;
}

export interface ResultUsage {
  models: Record<string, { costUsd: number; tokens: number; cache: number }>;
  costUsd: number;
  turns: number;
  tokens: { input: number; output: number; cache: number };
}

/** Coste y tokens de un mensaje `result` (acumulado de la fase) más lo de las fases anteriores. */
export function usageFromResult(modelUsage: Record<string, SdkModelUsage> | undefined, totalCostUsd: number, numTurns: number, spent: Spent): ResultUsage {
  const entries = Object.entries(modelUsage ?? {});
  const all = entries.map(([, m]) => m);
  return {
    models: Object.fromEntries(entries.map(([name, m]) => [name, { costUsd: m.costUSD, tokens: m.inputTokens + m.outputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, cache: m.cacheReadInputTokens + m.cacheCreationInputTokens }])),
    costUsd: totalCostUsd + spent.costUsd,
    turns: numTurns + spent.turns,
    tokens: {
      input: all.reduce((n, m) => n + m.inputTokens, 0) + spent.input,
      output: all.reduce((n, m) => n + m.outputTokens, 0) + spent.output,
      cache: all.reduce((n, m) => n + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0) + spent.cache,
    },
  };
}

/** Lo que se guarda en la tarea mientras se ejecuta (sin `updatedAt`, que pone el store). */
export interface LiveUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  models?: Record<string, { tokens: number; costUsd: number }>;
}

/** Modelos como máximo en `liveUsage.models` (las reglas de Firestore limitan el tamaño). */
export const LIVE_MAX_MODELS = 8;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,79}$/;

/** Id de modelo que se puede guardar tal cual (p. ej. "claude-opus-5-5" o "claude-opus-5-5[1m]"); si no, undefined. */
export function cleanModelId(model: unknown): string | undefined {
  return typeof model === "string" && MODEL_ID.test(model) ? model : undefined;
}

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Consumo acumulado de una vuelta mientras se ejecuta. Cada `result` de un turno trae el total exacto de la fase (coste
 * incluido); entre uno y otro se suman los tokens de los mensajes `assistant` (sin coste: no hay tabla de precios). Al
 * llegar el siguiente `result`, esos parciales se sustituyen por su total.
 */
export class LiveUsage {
  private spent: Spent = { costUsd: 0, turns: 0, input: 0, output: 0, cache: 0 };
  private spentModels: Record<string, { tokens: number; costUsd: number }> = {};
  private phase: ResultUsage | null = null;
  /** Mensajes `assistant` desde el último `result`, por id de mensaje de la API (el SDK repite el mismo en cada bloque). */
  private pending = new Map<string, { model?: string; input: number; output: number; cache: number }>();

  /** Un mensaje `assistant`: sus tokens cuentan hasta que llegue el `result` del turno. */
  assistant(messageId: string | undefined, model: string | undefined, usage: SdkTurnUsage | undefined): void {
    if (!usage) return;
    const key = messageId || `anon-${this.pending.size}`;
    this.pending.set(key, { model: cleanModelId(model), input: n(usage.input_tokens), output: n(usage.output_tokens), cache: n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens) });
  }

  /** El `result` de un turno: el total de la fase (el mismo cálculo que va a `result`). */
  result(usage: ResultUsage): void {
    this.phase = usage;
    this.pending.clear();
  }

  /** Acaba una fase: lo hecho pasa a ser la base de la siguiente (como `spent` en index.ts). */
  endPhase(spent: Spent): void {
    if (this.phase) for (const [name, m] of Object.entries(this.phase.models)) {
      const acc = (this.spentModels[name] ??= { tokens: 0, costUsd: 0 });
      acc.tokens += m.tokens;
      acc.costUsd += m.costUsd;
    }
    this.spent = { ...spent };
    this.phase = null;
    this.pending.clear();
  }

  snapshot(): LiveUsageSnapshot {
    const base = this.phase ?? { costUsd: this.spent.costUsd, tokens: { input: this.spent.input, output: this.spent.output, cache: this.spent.cache }, models: {} };
    const models: Record<string, { tokens: number; costUsd: number }> = {};
    const add = (name: string | undefined, tokens: number, costUsd: number) => {
      if (!name || (!(name in models) && Object.keys(models).length >= LIVE_MAX_MODELS)) return;
      const acc = (models[name] ??= { tokens: 0, costUsd: 0 });
      acc.tokens += tokens;
      acc.costUsd += costUsd;
    };
    for (const [name, m] of Object.entries(this.spentModels)) add(name, m.tokens, m.costUsd);
    for (const [name, m] of Object.entries(base.models)) add(name, m.tokens, m.costUsd);
    let input = base.tokens.input;
    let output = base.tokens.output;
    let cache = base.tokens.cache;
    for (const p of this.pending.values()) {
      input += p.input;
      output += p.output;
      cache += p.cache;
      add(p.model, p.input + p.output + p.cache, 0);
    }
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    for (const m of Object.values(models)) m.costUsd = round(m.costUsd);
    return { inputTokens: input, outputTokens: output, cacheTokens: cache, costUsd: round(base.costUsd), ...(Object.keys(models).length ? { models } : {}) };
  }
}

/** Escribe como mucho cada `intervalMs` (salvo `force`, al acabar un turno). Las escrituras no se solapan. */
export function throttled(write: () => Promise<void>, intervalMs: number, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const run = () => {
    clearTimeout(timer);
    timer = undefined;
    last = now();
    chain = chain.then(write).catch(() => undefined);
    return chain;
  };
  return {
    /** Hay datos nuevos: se escriben ya si toca, o al cumplirse el intervalo. */
    touch(force = false): void {
      if (force || now() - last >= intervalMs) void run();
      else timer ??= setTimeout(run, intervalMs - (now() - last));
    },
    /** Sin escrituras pendientes (al acabar la fase). */
    stop(): Promise<void> {
      clearTimeout(timer);
      timer = undefined;
      return chain;
    },
  };
}
