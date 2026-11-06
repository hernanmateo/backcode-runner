// Qué tarea de la cola puede arrancar ahora en este proyecto: respeta el límite personal del proyecto (y el del
// ordenador, si es menor) y no arranca a la vez dos tareas de la misma conversación del runner que choquen: las que
// no declaran qué rutas tocan (touches), las que se solapan o las que dependen de otra (after). El hueco del ordenador y el freno por RAM/disco se miran después (slots.ts y monitor.ts).

export interface QueuedTask {
  id: string;
  /** Conversación del runner que la creó (chat), si viene de una. */
  chatId?: string;
  /** Rutas o carpetas que prevé tocar (lo declara el chat al crearla); sin ellas, se trata como si tocara todo. */
  touches?: string[];
  /** Ids de tareas que deben terminar antes (de la misma conversación). */
  after?: string[];
  /** Estaba en espera del límite del plan y alguien pidió «Reprèn ara» desde la app: arranca aunque dure el límite. */
  resumeNow?: boolean;
}

/** Motivo por el que una tarea espera en cola (lo ve la app en su tarjeta). quota: límite del plan de Claude Code. */
export type QueueReason = "project" | "machine" | "chat" | "memory" | "disk" | "quota";

/** Límites por defecto: 1 por proyecto (como siempre) y sin tope en el ordenador. */
export const DEFAULT_PROJECT_LIMIT = 1;
export const MAX_PROJECT_LIMIT = 8;
export const MAX_MACHINE_LIMIT = 16;

/** Valor válido de un límite que llega de Firestore (o el de por defecto). */
export function clampLimit(raw: unknown, max: number, fallback: number | null): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, max);
}

/** Tareas a la vez de este proyecto en este ordenador: nunca más que el total del ordenador. */
export function effectiveProjectLimit(project: number | null, machine: number | null): number {
  const p = project ?? DEFAULT_PROJECT_LIMIT;
  return machine === null ? p : Math.max(1, Math.min(p, machine));
}

/**
 * `quotaBlocked`: el plan de Claude Code está en su límite; solo arrancan las que alguien pidió reanudar ya (el resto
 * fallaría igual y espera en cola con el motivo «quota»).
 */
export function nextTask(all: QueuedTask[], running: QueuedTask[], limit: number, quotaBlocked = false): { task: QueuedTask } | { task: null; reason: QueueReason | null } {
  if (!all.length) return { task: null, reason: null };
  const pending = quotaBlocked ? all.filter((p) => p.resumeNow) : all;
  if (!pending.length) return { task: null, reason: "quota" };
  if (running.length >= limit) return { task: null, reason: "project" };
  const waiting = new Set(all.map((p) => p.id));
  const task = pending.find((p) => !p.after?.some((id) => waiting.has(id)) && !running.some((r) => chatClash(p, r)));
  return task ? { task } : { task: null, reason: "chat" };
}

/** Una ruta declarada, normalizada para comparar: sin «./» ni «/» final; con comodín, su carpeta (por prudencia). */
function normPath(raw: string): string {
  const p = raw.trim().replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  const glob = p.search(/[*?[{]/);
  const base = glob < 0 ? p : p.slice(0, p.lastIndexOf("/", glob) + 1);
  const out = base.replace(/\/+$/, "");
  return out === "." ? "" : out;
}

/** Si dos rutas se pisan: iguales, o una está dentro de la otra (una vacía es la raíz del repo). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return !x || !y || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Si `p` no puede arrancar mientras `r` está en marcha por ser de la misma conversación: depende de ella, alguna de
 * las dos no dice qué toca o sus rutas se solapan. De conversaciones distintas, nunca chocan aquí.
 */
export function chatClash(p: QueuedTask, r: QueuedTask): boolean {
  if (!p.chatId || p.chatId !== r.chatId) return false;
  if (p.after?.includes(r.id)) return true;
  if (!p.touches?.length || !r.touches?.length) return true;
  return p.touches.some((a) => r.touches!.some((b) => pathsOverlap(a, b)));
}
