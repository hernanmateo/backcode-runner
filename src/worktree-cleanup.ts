import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RunnerConfig } from "./config.js";
import { git, removeWorktree, worktreeInUse } from "./git.js";
import type { PrHost } from "./hosts.js";
import { t } from "./i18n.js";

// Limpieza periódica de las copias de trabajo (~/.backcode/worktrees/<proyecto>/): al arrancar y cada 6 h, cada runner
// borra las suyas que ya no sirven, sea quien sea quien mergeó o cerró el PR (otro miembro, la app o GitHub). Las de
// tareas solo se borran cuando la tarea ha terminado de verdad; las temporales (_chat-*, _checks-*…), por inactividad.

const run = promisify(execFile);
const DAY = 86_400_000;
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;
/** Tareas sin PR (solo subir la rama, o fallidas sin PR): sin usar este tiempo, limpias y subidas, se borran. */
export const TASK_STALE_MS = 14 * DAY;
const TASK_NAME = /^[A-Za-z0-9]{1,64}$/;
const ACTIVE = new Set(["backlog", "execute", "running", "waiting"]);

export type Decision = { remove: boolean; reason: string };

export interface TaskFacts {
  /** Se está ejecutando en este runner o la usa algo de este proceso (p. ej. Metro). */
  inUse: boolean;
  /** null: no se pudo leer (red, permisos). */
  feature: { exists: boolean; status?: string; merged?: boolean } | null;
  /** none: sin PR (o sin URL); unknown: hay PR pero no se pudo consultar. */
  pr: "open" | "merged" | "closed" | "none" | "unknown";
  /** null: no se pudo saber (git falló). */
  local: { dirty: boolean; unpushed: boolean } | null;
  idleMs: number;
}

/** ¿Se borra la copia de trabajo de una tarea? Ante cualquier duda, se conserva. */
export function decideTask(f: TaskFacts, staleMs = TASK_STALE_MS): Decision {
  if (f.inUse) return { remove: false, reason: "in use" };
  if (!f.feature) return { remove: false, reason: "task state unknown" };
  if (!f.feature.exists) return { remove: true, reason: "task deleted" };
  if (f.feature.status === "rejected") return { remove: true, reason: "task discarded" };
  if (f.feature.merged || f.pr === "merged") return { remove: true, reason: "PR merged" };
  if (f.pr === "closed") return { remove: true, reason: "PR closed" };
  if (f.feature.status && ACTIVE.has(f.feature.status)) return { remove: false, reason: `task ${f.feature.status}` };
  if (f.pr === "open") return { remove: false, reason: "PR open" };
  if (f.pr === "unknown") return { remove: false, reason: "PR state unknown" };
  // Terminada o fallida sin PR: solo si lleva tiempo sin usarse y no tiene trabajo que se perdería.
  if (!f.local) return { remove: false, reason: "local state unknown" };
  if (f.local.dirty) return { remove: false, reason: "uncommitted changes" };
  if (f.local.unpushed) return { remove: false, reason: "commits not pushed" };
  if (f.idleMs < staleMs) return { remove: false, reason: "recently used" };
  return { remove: true, reason: `unused ${Math.floor(f.idleMs / DAY)} days` };
}

/** ¿Se borra una copia temporal (_chat-*, _checks-*, _install…)? Nunca en uso; si no, por días sin usar. */
export function decideTemp(name: string, idleMs: number, inUse: boolean): Decision {
  if (inUse) return { remove: false, reason: "in use" };
  // Las que se reutilizan (o pueden guardar trabajo sin subir, como el chat) duran más; el resto son restos de un corte.
  const keepDays = /^_(chat-|install$|dev$)/.test(name) || !name.startsWith("_") ? 14 : 1;
  if (idleMs < keepDays * DAY) return { remove: false, reason: "recently used" };
  return { remove: true, reason: `unused ${Math.floor(idleMs / DAY)} days` };
}

/**
 * Último uso real de una copia de trabajo: lo más reciente entre la carpeta y el HEAD, el index y el reflog de su gitdir
 * (cambian al hacer checkout, commit, status o add), no solo la carpeta (que solo cambia si cambian sus entradas).
 */
export function lastUse(path: string): number {
  const times: number[] = [];
  const mtime = (p: string) => {
    try {
      times.push(statSync(p).mtimeMs);
    } catch {
      // no existe
    }
  };
  mtime(path);
  mtime(join(path, ".git"));
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"));
    if (m) {
      const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(path, m[1].trim());
      for (const f of ["HEAD", "index", join("logs", "HEAD")]) mtime(join(gitdir, f));
    }
  } catch {
    // sin fichero .git (copia rota): cuenta la carpeta
  }
  return times.length ? Math.max(...times) : 0;
}

async function localState(path: string, remote: string): Promise<TaskFacts["local"]> {
  try {
    const dirty = !!(await git(path, ["status", "--porcelain"]));
    // Sin fetch: con refs remotas viejas, más commits parecen sin subir (y se conserva).
    const unpushed = Number(await git(path, ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`])) > 0;
    return { dirty, unpushed };
  } catch {
    return null;
  }
}

/** Tamaño en bytes (du -sk), o undefined si tarda o falla. */
async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await run("du", ["-sk", path], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const kb = Number(stdout.split(/\s/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

const human = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

export interface CleanupDeps {
  cfg: Pick<RunnerConfig, "repoPath" | "worktreesDir" | "remote">;
  store: { worktreeFeature(id: string): Promise<{ exists: boolean; status?: string; merged?: boolean; prUrl?: string }> };
  prHost: () => PrHost | undefined;
  /** La tarea se está ejecutando en este runner. */
  isRunning: (featureId: string) => boolean;
  /** Las operaciones sobre los worktrees del repo, de una en una con las del resto del runner. */
  withRepoLock: <T>(fn: () => Promise<T>) => Promise<T>;
  stopped?: () => boolean;
}

/** Una pasada de limpieza. Devuelve cuántas copias se borraron y cuánto espacio se liberó (aprox.). */
export async function cleanWorktrees(d: CleanupDeps): Promise<{ removed: number; freed: number }> {
  const { repoPath, worktreesDir, remote } = d.cfg;
  let removed = 0;
  let freed = 0;
  if (!existsSync(worktreesDir)) return { removed, freed };
  for (const name of readdirSync(worktreesDir)) {
    if (d.stopped?.()) break;
    if (name.startsWith(".")) continue;
    const path = join(worktreesDir, name);
    try {
      if (!lstatSync(path).isDirectory()) continue; // ni ficheros ni enlaces
    } catch {
      continue;
    }
    const idleMs = Date.now() - lastUse(path);
    const isTask = TASK_NAME.test(name);
    let decision: Decision;
    if (isTask) {
      if (d.isRunning(name) || worktreeInUse(path)) continue;
      const feature = await d.store.worktreeFeature(name).catch(() => null);
      let pr: TaskFacts["pr"] = "none";
      if (feature?.exists && feature.status !== "rejected" && !feature.merged && feature.prUrl) {
        const host = d.prHost();
        pr = host && feature.prUrl.startsWith("https://") ? ((await host.prState(feature.prUrl).catch(() => null))?.state ?? "unknown") : "unknown";
      }
      const local = await localState(path, remote);
      decision = decideTask({ inUse: false, feature, pr, local, idleMs });
      // Trabajo local que se conserva a propósito: que se vea en el log.
      if (!decision.remove && /uncommitted|not pushed/.test(decision.reason)) console.log(`[cleanup] ${t("wt.kept", { name, reason: decision.reason })}`);
    } else {
      decision = decideTemp(name, idleMs, worktreeInUse(path));
    }
    if (!decision.remove) continue;
    const size = await sizeOf(path);
    // Dentro del lock y comprobando otra vez: entre medias pudo empezar la tarea o crearse la copia.
    const result = await d.withRepoLock(async () => {
      if ((isTask && d.isRunning(name)) || worktreeInUse(path)) return null;
      return removeWorktree(repoPath, path, worktreesDir);
    });
    if (!result?.removed) continue;
    removed++;
    freed += size ?? 0;
    console.log(`[cleanup] ${t("wt.removed", { name, reason: decision.reason, size: size ? `, ${human(size)}` : "" })}`);
  }
  await git(repoPath, ["worktree", "prune"]).catch(() => undefined);
  if (removed) console.log(`[cleanup] ${t("wt.summary", { count: removed, size: freed ? ` (${human(freed)})` : "" })}`);
  return { removed, freed };
}

/** Limpieza al arrancar y cada `intervalMs` (6 h), sin pasadas solapadas. Devuelve cómo pararla. */
export function startWorktreeCleanup(d: CleanupDeps, intervalMs = CLEANUP_INTERVAL_MS): () => void {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await cleanWorktrees({ ...d, stopped: () => stopped });
    } catch (err) {
      console.warn(`[cleanup] ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
