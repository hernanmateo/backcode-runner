import { NATIVE } from "./pending.js";

// «Prova aquest PR al teu mòbil»: OTA solo con el código de un PR, en un canal/rama de EAS Update propio del PR
// (`pr-<número>`). Nunca production ni el canal preview compartido: así lo que ven los demás no cambia.

/** Número de un PR de GitHub (…/pull/12) o Bitbucket (…/pull-requests/12); null si la URL no es de un PR. */
export function prNumberOf(prUrl: string | undefined): number | null {
  const m = prUrl?.match(/^https:\/\/\S+\/pull(?:-requests)?\/(\d{1,9})(?:[/?#]|$)/);
  return m ? Number(m[1]) : null;
}

/** Canal (y rama) de EAS Update de un PR. Nunca coincide con production ni preview. */
export const prChannel = (n: number): string => `pr-${n}`;

/** Ficheros del PR que solo llegan con una build nueva (la misma detección que «Pendiente de desplegar»). */
export const nativeFiles = (files: string[]): string[] => files.filter((f) => NATIVE.test(f));

/** Esquema de la app (`scheme` de la config de Expo; el primero si es una lista) válido para un enlace. */
export function appScheme(config: { scheme?: unknown } | null | undefined): string | undefined {
  const raw = Array.isArray(config?.scheme) ? config?.scheme[0] : config?.scheme;
  return typeof raw === "string" && /^[a-z][a-z0-9+.-]{0,60}$/i.test(raw) ? raw : undefined;
}

/**
 * Enlace que abre la app instalada del proyecto y le pide pasar al canal OTA del PR (o volver al suyo con `channel`
 * vacío). Lo atiende el interruptor de canal del equipo de la app (ver la ayuda de OTA en Backcode).
 */
export const prOtaLink = (scheme: string, channel: string): string => `${scheme}://?backcode-ota-channel=${encodeURIComponent(channel)}`;

/** Argumentos de `eas update` para el PR: canal propio, variables de preview (mismo runtimeVersion que su build). */
export function prOtaArgs(channel: string, message: string): string[] {
  if (!/^pr-\d{1,9}$/.test(channel)) throw new Error(`bad PR channel: ${channel}`);
  return ["npx", "--yes", "eas-cli@latest", "update", "--channel", channel, "--environment", "preview", "--message", message.slice(0, 200), "--platform", "all", "--non-interactive"];
}
