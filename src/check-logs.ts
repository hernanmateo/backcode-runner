// Log de los checks que fallan en un PR: se guarda en el resultado del merge bloqueado (la app lo enseña) y se le pasa a
// Claude para que lo arregle (fix-checks.ts). Solo el final de cada job, sin colores y sin líneas que parezcan secretos.
import { looksSecret } from "./diagnostics.js";
import type { PrHost } from "./hosts.js";

/** Lo que cabe del log en el resultado de la acción y en el mensaje a Claude (los mensajes de la tarea, hasta 4000). */
export const CHECK_LOG_MAX = 3000;

// Colores, también como texto «^[[31m» (así los escribe gh run view).
// eslint-disable-next-line no-control-regex
const ANSI = /(\x1b|\^\[)\[[0-9;?]*[A-Za-z]/g;
// Ruido de los runners de tests y de Actions que no dice qué falló (TAP de node --test, grupos de Actions…).
const NOISE = [/^\s*ok \d+ /, /^\s*---$/, /^\s*\.\.\.$/, /^\s*duration_ms:/, /^\s*type: '(test|suite)'$/, /^\s*# Subtest:/, /^##\[(group|endgroup)\]/];
// (GitHub pone a veces un BOM delante de la fecha.)
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;

/**
 * Limpia la salida de `gh run view --log-failed` («job<TAB>paso<TAB>fecha texto» por línea): una cabecera por job, sin
 * fechas, colores, ruido, líneas repetidas ni líneas que parezcan secretos, y solo las últimas `max` letras (donde suele
 * estar el error).
 */
export function cleanFailedLog(raw: string, max = CHECK_LOG_MAX): string {
  const out: string[] = [];
  const seen = new Set<string>();
  let job = "";
  for (const line of raw.replace(ANSI, "").replace(/\r/g, "").split("\n")) {
    const parts = line.split("\t");
    const [name, text] = parts.length >= 3 ? [parts[0], parts.slice(2).join("\t")] : ["", line];
    const clean = text.replace(TIMESTAMP, "").trimEnd();
    // Cada línea una vez (los avisos repetidos se comen el espacio; iguales salvo horas, ids o números cuentan como la
    // misma), sin ruido ni secretos.
    const key = clean.replace(/0x[0-9a-f]+|\d+/gi, "#");
    if (!clean.trim() || seen.has(key) || NOISE.some((re) => re.test(clean)) || looksSecret(clean)) continue;
    seen.add(key);
    if (name && name !== job) {
      job = name;
      out.push(`## ${name}`);
    }
    out.push(clean);
  }
  const text = out.join("\n");
  return text.length > max ? `…\n${text.slice(text.length - max + 2)}` : text;
}

/** El log de los checks que fallan del PR, o "" si el host no lo da (Bitbucket) o no se pudo leer. */
export async function failingLog(host: PrHost, prUrl: string, max = CHECK_LOG_MAX): Promise<string> {
  if (!host.failedLog) return "";
  return cleanFailedLog(await host.failedLog(prUrl).catch(() => ""), max);
}
