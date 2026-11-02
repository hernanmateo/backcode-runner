import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Huecos de tareas en este ordenador, compartidos por los runners de todos sus proyectos (con supervisor o lanzados a
// mano): un fichero por tarea en marcha en ~/.backcode/slots. Los de procesos que ya no existen se limpian solos.

const NAME_RE = /^[A-Za-z0-9_-]{1,64}__[A-Za-z0-9]{1,64}\.json$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe pero es de otro usuario.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Tareas en marcha ahora en este ordenador (todos los proyectos). Borra las de procesos muertos. */
export function countSlots(dir: string): number {
  let n = 0;
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!NAME_RE.test(f)) continue;
    const path = join(dir, f);
    let pid = 0;
    try {
      pid = Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid) || 0;
    } catch {
      pid = 0;
    }
    if (pid > 0 && alive(pid)) n++;
    else rmSync(path, { force: true });
  }
  return n;
}

/**
 * Coge un hueco para la tarea si hay sitio (`max` null = sin tope en el ordenador). Devuelve la función que lo suelta, o
 * null si está lleno. Dos runners pueden contar a la vez y pasarse en uno como mucho: se acepta (es un tope orientativo).
 */
export function takeSlot(dir: string, projectId: string, featureId: string, max: number | null): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${projectId}__${featureId}.json`);
  if (!NAME_RE.test(`${projectId}__${featureId}.json`)) return null;
  if (max !== null && countSlots(dir) >= max) return null;
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
  } catch {
    // Ya existía (de un proceso muerto que se limpiará, o de esta misma tarea): se rehace a nuestro nombre.
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  }
  return () => rmSync(file, { force: true });
}
