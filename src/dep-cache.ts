import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./paths.js";

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
  return { dir, env: depCacheEnv(dir) };
}
