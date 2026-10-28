import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./paths.js";

// Cómo se habla con el panel que ya esté en marcha (el servicio o `backcode` en otra terminal). Escucha solo en
// 127.0.0.1 y cada llamada lleva el token de ~/.backcode/config/panel-token (solo lo puede leer tu usuario): así no lo
// puede usar otro usuario del ordenador ni una web que abras en el navegador.

export const PANEL_PORT = Number(process.env.BACKCODE_PANEL_PORT) || 47474;
export const PANEL_HOST = "127.0.0.1";
const TOKEN_FILE = join(CONFIG_DIR, "panel-token");

/** Token del panel (se crea la primera vez). */
export function panelToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved.length >= 32) return saved;
  }
  ensureConfigDir();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

/** Dirección del panel con el token (va en el fragmento: no sale en los logs ni en el historial del servidor). */
export const panelUrl = () => `http://${PANEL_HOST}:${PANEL_PORT}/#t=${panelToken()}`;

/** Llama al panel en marcha. Falla (rechaza) si no hay ninguno. */
export async function panelCall(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  return fetch(`http://${PANEL_HOST}:${PANEL_PORT}${path}`, {
    method,
    headers: { "X-Backcode-Token": panelToken(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

/** ¿Hay un panel de Backcode escuchando (y es el nuestro)? */
export async function panelAlive(): Promise<boolean> {
  try {
    const res = await panelCall("GET", "/api/hello");
    return res.ok && ((await res.json()) as { app?: string }).app === "backcode-runner";
  } catch {
    return false;
  }
}
