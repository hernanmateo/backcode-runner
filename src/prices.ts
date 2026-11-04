// Precios de la API de Anthropic para estimar el coste en directo de una tarea (live-usage.ts) mientras no llega el
// `result` del SDK, que trae el coste exacto y sustituye la estimación. Solo sirve para eso: el coste que se guarda
// al acabar siempre es el de Claude Code.
//
// Cómo actualizarla: USD por millón de tokens (MTok) de la página de precios de Anthropic
// (https://docs.anthropic.com/en/docs/about-claude/pricing). `cacheWrite` es la escritura en caché de 5 minutos
// (1,25 × input) y `cacheRead` la lectura (0,1 × input). Las filas se prueban en orden: las más concretas (versiones
// antiguas con otro precio) van antes que la de la familia. Un modelo que no encaja con ninguna no tiene precio: su
// coste queda como «desconocido» hasta el `result`, nunca se inventa.

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PriceRow {
  /** Encaja con el id del modelo (p. ej. "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-3-5-haiku-20241022"). */
  match: RegExp;
  price: Price;
  /**
   * Variantes de contexto largo ("[1m]") con recargo: si la petición (input + caché) pasa de `above` tokens, cada
   * precio se multiplica por su factor. Sin este campo, la variante "[1m]" cuesta lo mismo.
   */
  longContext?: { above: number; input: number; output: number };
}

const p = (input: number, output: number): Price => ({ input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 });

export const PRICES: readonly PriceRow[] = [
  // Opus: 4 y 4.1 (y Claude 3 Opus) a 15/75; desde 4.5, 5/25.
  { match: /^claude-(opus-4-(0|1)|opus-4-\d{8}|3-opus)/, price: p(15, 75) },
  { match: /^claude-opus-/, price: p(5, 25) },
  // Sonnet: mismo precio desde 3.5; el contexto de 1M tokens cobra el doble de input y 1,5 × output por encima de 200k.
  { match: /^claude-(sonnet-|3-5-sonnet|3-7-sonnet)/, price: p(3, 15), longContext: { above: 200_000, input: 2, output: 1.5 } },
  // Haiku: 4.5 en adelante a 1/5; 3.5 a 0,80/4; 3 a 0,25/1,25.
  { match: /^claude-3-5-haiku/, price: p(0.8, 4) },
  { match: /^claude-3-haiku/, price: p(0.25, 1.25) },
  { match: /^claude-haiku-/, price: p(1, 5) },
  // Fable: sin precio público confirmado aquí; mientras no se añada su fila, su coste sale «al terminar».
];

/** Tokens de un mensaje de la API, separados como los cobra Anthropic. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Coste estimado en USD de un mensaje de la API, o undefined si el modelo no está en la tabla. */
export function estimateCost(model: string | undefined, t: TokenCounts): number | undefined {
  if (!model) return undefined;
  const row = PRICES.find((r) => r.match.test(model));
  if (!row) return undefined;
  const long = row.longContext && model.endsWith("[1m]") && t.input + t.cacheRead + t.cacheWrite > row.longContext.above ? row.longContext : undefined;
  const fi = long?.input ?? 1;
  const fo = long?.output ?? 1;
  const { price } = row;
  return (t.input * price.input * fi + t.output * price.output * fo + t.cacheRead * price.cacheRead * fi + t.cacheWrite * price.cacheWrite * fi) / 1e6;
}
