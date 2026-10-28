import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./paths.js";

// Para quien usa Claude Code con una API key de Anthropic (no con un plan Pro o Max): se pega en el panel, se comprueba y
// se guarda en ~/.backcode/config/anthropic-key (600). El runner se la pasa a Claude Code (ANTHROPIC_API_KEY). Con un plan,
// la sesión la inicia el propio Claude Code («Abrir en Terminal»).

const KEY_FILE = join(CONFIG_DIR, "anthropic-key");
let fromFile = false;

/** Carga la API key guardada (salvo que ya venga en el entorno). */
export function loadSavedApiKey(): void {
  if (process.env.ANTHROPIC_API_KEY || !existsSync(KEY_FILE)) return;
  const key = readFileSync(KEY_FILE, "utf8").trim();
  if (key) {
    process.env.ANTHROPIC_API_KEY = key;
    fromFile = true;
  }
}

export const hasSavedApiKey = () => existsSync(KEY_FILE);

/** Comprueba la key contra la API de Anthropic (lista de modelos: no consume) y la guarda. */
export async function saveApiKey(key: string): Promise<{ ok: true } | { error: string }> {
  const k = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return { error: "format" };
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": k, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) return { error: "network" };
  if (res.status === 401 || res.status === 403) return { error: "invalid" };
  ensureConfigDir();
  writeFileSync(KEY_FILE, k + "\n", { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  process.env.ANTHROPIC_API_KEY = k;
  fromFile = true;
  return { ok: true };
}

export function removeApiKey(): void {
  rmSync(KEY_FILE, { force: true });
  if (fromFile) delete process.env.ANTHROPIC_API_KEY;
  fromFile = false;
}
