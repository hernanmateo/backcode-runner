import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem, freemem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { countSlots } from "./slots.js";

// Monitor de este ordenador para la app (ficha de la máquina y equipo) y para el freno automático: solo métricas
// agregadas (números), nunca nombres de procesos, rutas ni nada personal.

const run = promisify(execFile);
const GB = 1024 ** 3;

/** Cada cuánto se publican las métricas (lo hace uno solo de los runners del ordenador). */
export const MONITOR_EVERY_MS = 60_000;
/** Por debajo de esto de disco libre no se arranca ninguna tarea nueva. */
export const MIN_FREE_DISK = 5 * GB;
/** RAM por sesión de Claude Code que se supone mientras no hay muestras reales. */
export const DEFAULT_SESSION_RAM = 1.5 * GB;
/** Lo que se deja para el sistema y las demás apps al recomendar. */
const RESERVED_RAM = 4 * GB;
/** Disco que se reserva por cada tarea a la vez (worktree, dependencias, builds). */
const DISK_PER_TASK = 5 * GB;
/** Tope del selector en la app. */
export const MAX_PARALLEL = 16;

export type Pressure = "normal" | "warn" | "critical";

export interface MachineMetrics {
  cpuLoad: number;
  cores: number;
  ramTotal: number;
  pressure: Pressure;
  /** % de memoria disponible (orientativo; en macOS la presión es lo fiable). */
  memFreePct: number | null;
  /** RAM media real por sesión de Claude Code en curso (null sin sesiones). */
  sessionRam: number | null;
  diskFree: number;
  worktreesSize: number | null;
  running: number;
  recommended: number;
  /** Lo que más limita la recomendación. */
  limitedBy: "cpu" | "ram" | "disk";
}

/** `sysctl kern.memorystatus_vm_pressure_level` de macOS: 1 normal, 2 aviso, 4 crítica. */
export function parseDarwinPressure(level: string): Pressure {
  const n = Number(level.trim());
  return n >= 4 ? "critical" : n >= 2 ? "warn" : "normal";
}

/** `memory_pressure -Q`: «System-wide memory free percentage: 45%». */
export function parseFreePct(text: string): number | null {
  const m = /free percentage:\s*(\d+)%/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** /proc/meminfo de Linux: % disponible y la presión que se deduce. */
export function parseMeminfo(text: string): { freePct: number; pressure: Pressure } | null {
  const total = Number(/MemTotal:\s+(\d+)/.exec(text)?.[1]);
  const avail = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1]);
  if (!total || Number.isNaN(avail)) return null;
  const freePct = Math.round((avail / total) * 100);
  return { freePct, pressure: freePct < 5 ? "critical" : freePct < 10 ? "warn" : "normal" };
}

/** Suma el RSS (KB en `ps`) de todos los descendientes de `roots`, sin contar los propios `roots`. */
export function descendantsRss(psOutput: string, roots: number[]): number {
  const children = new Map<number, { pid: number; rss: number }[]>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (!pid || Number.isNaN(ppid) || Number.isNaN(rss)) continue;
    const list = children.get(ppid) ?? [];
    list.push({ pid, rss });
    children.set(ppid, list);
  }
  let kb = 0;
  const seen = new Set<number>(roots);
  const stack = [...roots];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      kb += c.rss;
      stack.push(c.pid);
    }
  }
  return kb * 1024;
}

/** Cuántas tareas a la vez caben con lo medido, y qué lo limita. */
export function recommend(m: { cores: number; ramTotal: number; sessionRam: number | null; diskFree: number }): { recommended: number; limitedBy: "cpu" | "ram" | "disk" } {
  const perSession = Math.max(m.sessionRam ?? DEFAULT_SESSION_RAM, 0.5 * GB);
  const byCpu = Math.floor(m.cores / 2);
  const byRam = Math.floor((m.ramTotal - RESERVED_RAM) / perSession);
  const byDisk = Math.floor(m.diskFree / DISK_PER_TASK);
  const min = Math.min(byCpu, byRam, byDisk);
  const limitedBy = min === byRam ? "ram" : min === byDisk ? "disk" : "cpu";
  return { recommended: Math.max(1, Math.min(8, min)), limitedBy };
}

/** Freno automático: por qué no se debe arrancar otra tarea ahora (o null si se puede). */
export function brakeReason(m: { pressure: Pressure; diskFree: number }): "memory" | "disk" | null {
  if (m.pressure !== "normal") return "memory";
  if (m.diskFree < MIN_FREE_DISK) return "disk";
  return null;
}

async function pressureNow(): Promise<{ pressure: Pressure; freePct: number | null }> {
  if (process.platform === "darwin") {
    const level = await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 5_000 }).then((o) => o.stdout, () => "");
    const free = await run("memory_pressure", ["-Q"], { timeout: 5_000 }).then((o) => parseFreePct(o.stdout), () => null);
    return { pressure: level ? parseDarwinPressure(level) : "normal", freePct: free };
  }
  if (process.platform === "linux") {
    const r = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
    if (r) return { pressure: r.pressure, freePct: r.freePct };
  }
  return { pressure: "normal", freePct: Math.round((freemem() / totalmem()) * 100) };
}

function diskFree(path: string): number {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

let duCache: { at: number; size: number | null } | null = null;
async function dirSize(path: string): Promise<number | null> {
  if (duCache && Date.now() - duCache.at < 10 * 60_000) return duCache.size;
  const size = await run("du", ["-sk", path], { timeout: 120_000 }).then((o) => Number(o.stdout.trim().split(/\s+/)[0]) * 1024 || 0, () => null);
  duCache = { at: Date.now(), size };
  return size;
}

/** Pids de los runners con tareas en marcha (de los ficheros de huecos). */
function runnerPids(slotsDir: string): number[] {
  const pids = new Set<number>([process.pid]);
  try {
    for (const f of readdirSync(slotsDir)) {
      try {
        const pid = Number((JSON.parse(readFileSync(join(slotsDir, f), "utf8")) as { pid?: number }).pid);
        if (pid > 0) pids.add(pid);
      } catch {
        // fichero a medio escribir
      }
    }
  } catch {
    // sin carpeta
  }
  return [...pids];
}

/** Comprobación rápida para el freno (sin `du` ni `ps`). */
export async function quickCheck(worktreesRoot: string): Promise<{ pressure: Pressure; diskFree: number }> {
  mkdirSync(worktreesRoot, { recursive: true });
  return { pressure: (await pressureNow()).pressure, diskFree: diskFree(worktreesRoot) };
}

/** Todas las métricas. `worktreesRoot` es ~/.backcode/worktrees (todos los proyectos). */
export async function measure(worktreesRoot: string, slotsDir: string): Promise<MachineMetrics> {
  mkdirSync(worktreesRoot, { recursive: true });
  const running = countSlots(slotsDir);
  const [{ pressure, freePct }, size, ps] = await Promise.all([
    pressureNow(),
    dirSize(worktreesRoot),
    run("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }).then((o) => o.stdout, () => ""),
  ]);
  const sessionsRam = ps ? descendantsRss(ps, runnerPids(slotsDir)) : 0;
  const cores = cpus().length || 1;
  const ramTotal = totalmem();
  const free = diskFree(worktreesRoot);
  const sessionRam = running > 0 && sessionsRam > 0 ? Math.round(sessionsRam / running) : null;
  return {
    cpuLoad: Math.round(loadavg()[0] * 100) / 100,
    cores,
    ramTotal,
    pressure,
    memFreePct: freePct,
    sessionRam,
    diskFree: free,
    worktreesSize: size,
    running,
    ...recommend({ cores, ramTotal, sessionRam: sessionRam ?? lastSessionRam(slotsDir), diskFree: free }),
  };
}

/** RAM media por sesión de la última vez que hubo sesiones (para recomendar sin tareas en marcha). */
function lastSessionRam(slotsDir: string): number | null {
  try {
    const v = Number(readFileSync(join(dirname(slotsDir), "session-ram"), "utf8"));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function rememberSessionRam(slotsDir: string, bytes: number | null): void {
  if (!bytes) return;
  try {
    const prev = lastSessionRam(slotsDir);
    // Media móvil: una tarea puntual no cambia de golpe la recomendación.
    writeFileSync(join(dirname(slotsDir), "session-ram"), String(Math.round(prev ? prev * 0.7 + bytes * 0.3 : bytes)), { mode: 0o600 });
  } catch {
    // sin disco: no pasa nada
  }
}

/**
 * Solo uno de los runners del ordenador publica las métricas: el que encuentra `monitor.lock` caducado lo renueva.
 */
export function takeMonitorTurn(homeDir: string, now = Date.now()): boolean {
  const file = join(homeDir, "monitor.lock");
  try {
    const s = statSync(file);
    const owner = Number(readFileSync(file, "utf8")) || 0;
    if (owner !== process.pid && now - s.mtimeMs < MONITOR_EVERY_MS - 10_000) return false;
  } catch {
    // no existe
  }
  try {
    writeFileSync(file, String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Métricas como las guarda Firestore (enteros acotados, sin nada más). */
export function metricsDoc(m: MachineMetrics): Record<string, unknown> {
  const int = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)));
  return {
    cpuLoad: Math.min(1000, Math.max(0, m.cpuLoad)),
    cores: Math.min(1024, int(m.cores) ?? 1),
    ramTotal: int(m.ramTotal),
    pressure: m.pressure,
    memFreePct: m.memFreePct === null ? null : Math.min(100, int(m.memFreePct)!),
    sessionRam: int(m.sessionRam),
    diskFree: int(Math.min(m.diskFree, 1e15)),
    worktreesSize: int(m.worktreesSize),
    running: Math.min(1000, int(m.running) ?? 0),
    recommended: Math.min(MAX_PARALLEL, Math.max(1, int(m.recommended) ?? 1)),
    limitedBy: m.limitedBy,
  };
}
