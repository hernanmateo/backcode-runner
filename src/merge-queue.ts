// Cola de merges: «Mergear todo» (y varios merges pedidos a la vez) pide una acción `merge` por PR; el runner las ejecuta
// de una en una (como todas sus acciones) y, entre las que esperan, elige cada vez la que menos choca con las demás:
//
//   1. la que comparte ficheros con menos PR de los que siguen en la cola (los que no se solapan con ninguno, primero);
//   2. a igualdad, la que cambia menos ficheros (menos superficie para chocar con lo que se mergee después);
//   3. a igualdad, la que se pidió antes.
//
// Se recalcula tras cada merge con los que quedan, así que un PR que solo chocaba con uno ya mergeado sube en la cola.
// Los ficheros de cada PR salen de git (diff desde el merge-base con la rama principal). Cada acción en espera lleva su
// posición (result.queue / result.queueOf) para que la app la enseñe en vivo en su tarjeta y en «Mergear todo».
//
// Además, un merge pedido desde la app toma el turno de merge del proyecto (locks/autoMerge), el mismo que el modo auto,
// y en este runner un merge manual y uno automático nunca van a la vez (withMergeLock).
import { git } from "./git.js";

export interface QueuedPr {
  id: string;
  /** Ficheros que cambia el PR; null si no se pudieron leer (va después de los conocidos, en su orden). */
  files: string[] | null;
}

/** Orden en que mergear `items` (en el orden en que se pidieron) para que choquen lo mínimo. Puro. */
export function mergeOrder(items: QueuedPr[]): string[] {
  const left = items.map((it, index) => ({ ...it, index, set: it.files ? new Set(it.files) : null }));
  const out: string[] = [];
  while (left.length) {
    const score = (a: (typeof left)[number]) => {
      if (!a.set) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, a.index];
      const overlaps = left.filter((b) => b !== a && b.set && [...a.set!].some((f) => b.set!.has(f))).length;
      return [overlaps, a.set.size, a.index];
    };
    let best = 0;
    let bestScore = score(left[0]);
    for (let i = 1; i < left.length; i++) {
      const s = score(left[i]);
      if (s[0] < bestScore[0] || (s[0] === bestScore[0] && (s[1] < bestScore[1] || (s[1] === bestScore[1] && s[2] < bestScore[2])))) {
        best = i;
        bestScore = s;
      }
    }
    out.push(left[best].id);
    left.splice(best, 1);
  }
  return out;
}

/** Ficheros que cambia la rama `branch` respecto a la principal (ya traídas del remoto); null si git no puede. */
export async function prFiles(repoPath: string, remote: string, base: string, branch: string): Promise<string[] | null> {
  const out = await git(repoPath, ["diff", "--name-only", `${remote}/${base}...${remote}/${branch}`]).catch(() => null);
  return out === null ? null : out.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Merges de este runner (manuales y del modo auto): de uno en uno.
let chain: Promise<unknown> = Promise.resolve();
/** Ejecuta `fn` cuando no haya otro merge de este runner en marcha. */
export function withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.catch(() => undefined).then(fn);
  chain = p.catch(() => undefined);
  return p;
}

// El modo auto de este runner tiene el turno del proyecto: un merge manual no lo vuelve a pedir ni lo suelta.
let autoTurn = false;
export const setAutoHoldsTurn = (held: boolean) => void (autoTurn = held);
export const autoHoldsTurn = () => autoTurn;

export interface TurnDeps {
  take: () => Promise<boolean>;
  release: () => Promise<void>;
  /** Para dejar de esperar (el runner se para). */
  stop: () => boolean;
  onWait?: () => void;
  pollMs?: number;
}

/**
 * Ejecuta `fn` con el turno de merge del proyecto: si lo tiene otro runner (un merge automático en marcha), espera a que
 * lo suelte o caduque. Si el modo auto de este mismo runner ya lo tiene, no lo pide ni lo suelta.
 */
export async function withMergeTurn<T>(d: TurnDeps, fn: () => Promise<T>): Promise<T> {
  if (autoHoldsTurn()) return fn();
  let warned = false;
  while (!(await d.take())) {
    if (d.stop()) break;
    if (!warned) d.onWait?.();
    warned = true;
    await new Promise((r) => setTimeout(r, d.pollMs ?? 20_000));
  }
  try {
    return await fn();
  } finally {
    if (!autoHoldsTurn()) await d.release().catch(() => undefined);
  }
}
