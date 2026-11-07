import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, projectFiles } from "./paths.js";

// Caché de los gestores de paquetes para las sesiones de Claude con sandbox (tareas, conversaciones con el runner,
// «arreglar checks»). Las dependencias de la rama base las instala el runner antes de empezar (task-deps.ts), pero cuando
// Claude añade una nueva (`bun add`, `npm install <pkg>`…) tiene que instalarla él, dentro del sandbox, para que el
// lockfile del PR quede al día. Sin esto fallaba siempre: cada gestor escribe en su caché del HOME (~/.bun/install/cache,
// ~/.npm, ~/Library/Caches/…), fuera de lo único que el sandbox deja escribir (el worktree), y el lockfile se quedaba sin
// regenerar (un paso «a mano» tras mergear y la CI con --frozen-lockfile en rojo).
//
// Seguridad:
// - La instalación sigue DENTRO del sandbox: los scripts de postinstall de los paquetes que elige el agente no ven tus
//   credenciales, no salen de la red permitida y solo escriben en el worktree y aquí.
// - Una caché propia del runner y por proyecto, nunca la global del usuario: una tarea no puede envenenar la caché que usan
//   tus otros proyectos (ni tus instalaciones fuera del sandbox), ni la de otro proyecto conectado en este ordenador.
// - No abre el HOME: cada sitio donde escribe un gestor se apunta por variable de entorno a una subcarpeta de esta.
// - La red no cambia: registry.npmjs.org (el de bun, npm, pnpm y corepack por defecto). yarn 1 usa registry.yarnpkg.com,
//   que no está en la lista: con yarn hay que añadirlo a BACKCODE_ALLOWED_DOMAINS (README del runner).

/** Raíz de las cachés de todos los proyectos. */
export const DEP_CACHE_ROOT = join(HOME_DIR, "dep-cache");

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Carpeta de la caché de un proyecto (no la crea). */
export function depCacheDir(projectId: string): string {
  if (!SAFE_ID.test(projectId)) throw new Error(`id de proyecto no válido para la caché: ${projectId}`);
  return join(DEP_CACHE_ROOT, projectId);
}

/**
 * Variables de entorno que llevan cada escritura de los gestores a la caché del proyecto. bun: caché de paquetes y
 * global (`bun add -g`); npm: caché (incluye _logs) y sin aviso de versiones (escribe en ~/.config); pnpm: store, caché
 * de metadatos y estado; yarn: caché y carpeta global (1 y berry); corepack: donde descarga pnpm/yarn.
 */
export function depCacheEnv(dir: string): Record<string, string> {
  return {
    BUN_INSTALL_CACHE_DIR: join(dir, "bun"),
    BUN_INSTALL_GLOBAL_DIR: join(dir, "bun-global"),
    BUN_INSTALL_BIN: join(dir, "bun-global", "bin"),
    npm_config_cache: join(dir, "npm"),
    npm_config_update_notifier: "false",
    npm_config_store_dir: join(dir, "pnpm-store"),
    npm_config_cache_dir: join(dir, "pnpm-cache"),
    npm_config_state_dir: join(dir, "pnpm-state"),
    YARN_CACHE_FOLDER: join(dir, "yarn"),
    YARN_GLOBAL_FOLDER: join(dir, "yarn-global"),
    YARN_ENABLE_TELEMETRY: "0",
    COREPACK_HOME: join(dir, "corepack"),
  };
}

/** Lo que necesita una sesión con sandbox: la carpeta (para allowWrite, ya creada) y sus variables de entorno. */
export function depCache(projectId: string): { dir: string; env: Record<string, string> } {
  const dir = depCacheDir(projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  touchDepCache(projectId);
  return { dir, env: depCacheEnv(dir) };
}

// --- Limpieza (al arrancar el runner y una vez al día) ---
//
// La caché solo guarda lo que Claude instala dentro del sandbox, pero crece y no se vaciaba nunca. Cada runner, al
// arrancar y cada 24 h, recorre DEP_CACHE_ROOT y vacía (borra la carpeta; depCache() la vuelve a crear al usarla):
//   1. la de los proyectos que ya no están conectados en este ordenador,
//   2. la que lleva más de 30 días sin usarse (marca `.last-used`, que pone depCache() y renueva una tarea larga),
//   3. la que pasa del tope (BACKCODE_DEP_CACHE_MAX_GB, 2 GB por defecto): entera, sin LRU fino.
// Nunca la de un proyecto con trabajo en marcha: la del propio proyecto si este runner está ocupado y, como cada proyecto
// tiene su runner y uno no sabe qué hace otro, cualquiera usada en las últimas 2 h. Solo dentro de DEP_CACHE_ROOT, solo
// carpetas con un id válido y sin seguir enlaces simbólicos (lstat; rm borra el enlace, no su destino).

/** Fichero marca: su fecha es la última vez que una sesión usó la caché del proyecto. */
export const LAST_USED = ".last-used";
export const DEP_CACHE_IDLE_MS = 30 * 24 * 60 * 60_000;
/** Usada hace menos de esto: puede haber una sesión en marcha (de este u otro runner), no se toca. */
export const DEP_CACHE_ACTIVE_MS = 2 * 60 * 60_000;
export const DEP_CACHE_CLEAN_INTERVAL_MS = 24 * 60 * 60_000;

/** Marca la caché del proyecto como usada ahora (al empezar una sesión y, en una tarea larga, cada pocos minutos). */
export function touchDepCache(projectId: string): void {
  try {
    const dir = depCacheDir(projectId);
    if (existsSync(dir)) writeFileSync(join(dir, LAST_USED), new Date().toISOString() + "\n");
  } catch {
    // Sin marca, la limpieza usa la fecha de la carpeta: no es motivo para fallar una sesión.
  }
}

/** Bytes que ocupa una carpeta, sin seguir enlaces simbólicos. */
export function dirBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop()!;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      try {
        for (const name of readdirSync(p)) stack.push(join(p, name));
      } catch {
        // Ilegible: se cuenta lo que se pueda.
      }
    } else total += st.size;
  }
  return total;
}

function lastUsed(dir: string): number {
  try {
    return statSync(join(dir, LAST_USED)).mtimeMs;
  } catch {
    try {
      return lstatSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  }
}

export type DepCacheCleanReason = "disconnected" | "idle" | "tooBig";

export interface DepCacheCleanResult {
  removed: { id: string; reason: DepCacheCleanReason; bytes: number }[];
  freedBytes: number;
}

/** Una pasada de limpieza. Pura salvo el disco: los tests le pasan otra raíz y otra hora. */
export function cleanDepCache(opts: {
  root?: string;
  /** Proyectos conectados en este ordenador. */
  connected: ReadonlySet<string>;
  /** Proyectos con trabajo en marcha ahora (de los que este runner lo sabe). */
  busy?: ReadonlySet<string>;
  maxBytes: number;
  now?: number;
  log?: (msg: string) => void;
}): DepCacheCleanResult {
  const root = opts.root ?? DEP_CACHE_ROOT;
  const now = opts.now ?? Date.now();
  const out: DepCacheCleanResult = { removed: [], freedBytes: 0 };
  let names: string[];
  try {
    if (!lstatSync(root).isDirectory()) return out;
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const id of names) {
    if (!SAFE_ID.test(id)) continue;
    const dir = join(root, id);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue; // un enlace o un fichero suelto: no es una caché nuestra, no se sigue ni se toca
    if (opts.busy?.has(id)) continue;
    const used = lastUsed(dir);
    if (now - used < DEP_CACHE_ACTIVE_MS) continue;
    const bytes = dirBytes(dir);
    const reason: DepCacheCleanReason | null = !opts.connected.has(id) ? "disconnected" : now - used > DEP_CACHE_IDLE_MS ? "idle" : bytes > opts.maxBytes ? "tooBig" : null;
    if (!reason) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      out.removed.push({ id, reason, bytes });
      out.freedBytes += bytes;
    } catch (err) {
      opts.log?.(`[dep-cache] no se pudo vaciar ${id}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Limpieza al arrancar y cada 24 h. `isBusy`: si este runner tiene trabajo en marcha en su proyecto. Devuelve cómo pararla. */
export function startDepCacheCleanup(d: { projectId: string; maxGb: number; isBusy: () => boolean }, intervalMs = DEP_CACHE_CLEAN_INTERVAL_MS): () => void {
  const tick = () => {
    try {
      const connected = new Set(projectFiles().map((p) => p.id));
      const busy = new Set(d.isBusy() ? [d.projectId] : []);
      const r = cleanDepCache({ connected, busy, maxBytes: d.maxGb * 1024 ** 3, log: (m) => console.warn(m) });
      if (r.removed.length) console.log(`[dep-cache] liberados ${Math.round(r.freedBytes / 1024 ** 2)} MB: ${r.removed.map((x) => `${x.id} (${x.reason})`).join(", ")}`);
    } catch (err) {
      console.warn(`[dep-cache] ${(err as Error).message}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
