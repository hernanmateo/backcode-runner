/**
 * Límites de texto de lo que escribe el runner en Firestore. Deben coincidir con firestore.rules:
 * - events de una tarea (projects/{pid}/features/{fid}/events): EVENT_TEXT_MAX;
 * - mensajes de Claude en la conversación con el runner (projects/{pid}/chats/{id}/messages): CHAT_TEXT_MAX.
 * Un texto más largo no se corta en silencio: se parte en varios trozos consecutivos (splitText).
 */
export const EVENT_TEXT_MAX = 8000;
/** Límite de las reglas antiguas de los events: si un trozo más largo se rechaza por permisos, se reintenta con este. */
export const LEGACY_EVENT_TEXT_MAX = 1000;
export const CHAT_TEXT_MAX = 4000;

/**
 * Parte un texto en trozos de como mucho `max` caracteres, cortando preferentemente en un párrafo, luego en un salto
 * de línea y luego en un espacio (nunca a media palabra salvo que una sola "palabra" supere el límite). Ningún trozo
 * queda vacío; el orden se conserva.
 */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const min = Math.floor(max / 2);
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(sep);
      if (at >= min) {
        cut = at;
        break;
      }
    }
    if (cut < 0) {
      cut = max;
      // No partir un emoji (par sustituto) por la mitad.
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) out.push(piece);
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.trim() || !out.length) out.push(rest);
  return out;
}
