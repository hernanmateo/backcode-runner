import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./paths.js";

// Credenciales de la cuenta, no de un proyecto: el API token de Bitbucket vale para todos tus repos (y para crear repos
// nuevos desde la app). Se guardan en ~/.backcode/config/credentials (600), que Claude no puede leer. Sin extensión .env
// a propósito: así ningún panel (tampoco uno antiguo) lo toma por la configuración de un proyecto. El .env de un
// proyecto, si las trae, manda.

export const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials");

export interface Credentials {
  bitbucket?: { email: string; token: string };
}

function readValues(): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(CREDENTIALS_FILE)) return values;
  // Si alguien le ha abierto los permisos, se vuelven a cerrar antes de leerlo.
  chmodSync(CREDENTIALS_FILE, 0o600);
  for (const line of readFileSync(CREDENTIALS_FILE, "utf8").split(/\r?\n/)) {
    const m = /^(BACKCODE_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) values.set(m[1], m[2].trim());
  }
  return values;
}

export function readCredentials(): Credentials {
  try {
    const v = readValues();
    const email = v.get("BACKCODE_BITBUCKET_EMAIL");
    const token = v.get("BACKCODE_BITBUCKET_TOKEN");
    return email && token ? { bitbucket: { email, token } } : {};
  } catch {
    return {};
  }
}

/** Guarda (o sustituye) las credenciales de Bitbucket de este ordenador. */
export function saveBitbucketCredentials(email: string, token: string): void {
  ensureConfigDir();
  const values = existsSync(CREDENTIALS_FILE) ? readValues() : new Map<string, string>();
  values.set("BACKCODE_BITBUCKET_EMAIL", email);
  values.set("BACKCODE_BITBUCKET_TOKEN", token);
  writeFileSync(CREDENTIALS_FILE, [...values].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(CREDENTIALS_FILE, 0o600);
}
