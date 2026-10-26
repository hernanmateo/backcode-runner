import { query } from "@anthropic-ai/claude-agent-sdk";

// Cuota del plan (Pro/Max) de quien ejecuta el runner, para el panel "Uso del equipo".
// Usa una API experimental del SDK: si cambia o no hay datos (API key), devuelve null y no rompe nada.
// Abre una sesión que nunca envía mensajes, así que no hay llamada al modelo ni consumo.

export interface QuotaWindow {
  pct: number | null;
  resetsAt: string | null;
}
export interface Quota {
  plan: string | null;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
}

const TIMEOUT_MS = 20_000;

export async function readQuota(env: Record<string, string>): Promise<Quota | null> {
  const abort = new AbortController();
  const idle = async function* () {
    await new Promise((r) => abort.signal.addEventListener("abort", r));
  };
  const q = query({ prompt: idle(), options: { abortController: abort, env, settingSources: [], allowedTools: [], permissionMode: "dontAsk" } });
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const read = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> }).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof read !== "function") return null;
    const usage = (await read.call(q)) as {
      subscription_type?: string | null;
      rate_limits?: Record<string, { utilization?: number | null; resets_at?: string | null } | null> | null;
    };
    const win = (w?: { utilization?: number | null; resets_at?: string | null } | null): QuotaWindow | null =>
      w ? { pct: typeof w.utilization === "number" ? Math.round(w.utilization) : null, resetsAt: typeof w.resets_at === "string" ? w.resets_at : null } : null;
    // Solo se publica lo imprescindible: plan y % de las ventanas de 5 h y semanal (nada de créditos ni importes).
    return { plan: usage.subscription_type ?? null, fiveHour: win(usage.rate_limits?.five_hour), sevenDay: win(usage.rate_limits?.seven_day) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
