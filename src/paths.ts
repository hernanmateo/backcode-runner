import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED } from "./embedded.js";

// Dónde vive cada cosa. El paquete (KIT_DIR) puede estar en una copia de git, en la caché de npx o en la instalación
// propia (~/.backcode/app), así que la configuración nunca se guarda dentro: va a ~/.backcode/config, que Claude no puede
// leer (como el kit). BACKCODE_HOME cambia la raíz (tests, varios usuarios de prueba en un mismo ordenador).

/** ¿Es el ejecutable sin Node (bun build --compile) en vez del paquete de npm o una copia de git? */
export const IS_BINARY = EMBEDDED !== null;
/** Carpeta del paquete (instructions/, panel/, dist/); en el ejecutable, la suya. Claude nunca puede leerla. */
export const KIT_DIR = IS_BINARY ? dirname(process.execPath) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOME_DIR = process.env.BACKCODE_HOME ? resolve(process.env.BACKCODE_HOME) : join(homedir(), ".backcode");
/** Configuración de cada proyecto (<proyecto>.env, con la runner key) y el token del panel. Permisos 700. */
export const CONFIG_DIR = join(HOME_DIR, "config");
/** Instalación propia del runner (npm install --prefix): la que usa el servicio y se actualiza sola. */
export const APP_DIR = join(HOME_DIR, "app");
export const LOGS_DIR = join(HOME_DIR, "logs");
/** Estado del panel (proyectos parados a mano, idioma). Sin secretos. */
export const STATE_FILE = join(HOME_DIR, "state.json");

export interface PanelState {
  /** Proyectos que se pararon desde el panel: no se arrancan solos. */
  stopped?: string[];
  /** Apagado con el botón general del panel: ningún runner arranca hasta volver a encenderlo. */
  off?: boolean;
  /** «Decretazos» de tu perfil en la app (lo apuntan los runners): si los admins pueden poner tareas en tu runner. */
  allowAdminAssign?: boolean;
  /** «Mantener el ordenador despierto» elegido en el panel: off, plugged (solo enchufado) o always (también con batería). */
  keepAwake?: string;
  /** Lo mismo desde tu perfil en la app (vale para todos tus ordenadores; lo apuntan los runners). Gana el más fuerte. */
  appKeepAwake?: string;
  /** (1.0.41) Antes de los modos: true = «plugged». */
  keepAwakePlugged?: boolean;
  /** «Arrancar al iniciar sesión» desactivado a mano: la app de Mac ya no lo vuelve a activar al abrirse. */
  autostartOff?: boolean;
  /** Idioma elegido en el panel. */
  panelLang?: string;
  /** Idioma del perfil en la app (lo apuntan los runners al iniciar sesión). */
  profileLang?: string;
  /** Nombre de cada proyecto en la app (lo apunta su runner al conectarse). */
  names?: Record<string, string>;
}

export function readState(): PanelState {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

/** Cambia parte del estado. Nunca falla: sin permisos en ~/.backcode simplemente no se recuerda. */
export function updateState(patch: Partial<PanelState>): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2) + "\n");
  } catch {
    // se vuelve a intentar la próxima vez
  }
}

/** ¿Este runner se ejecuta desde un paquete de npm (npx, global o la instalación propia) y no desde una copia de git? */
export const FROM_NPM = !IS_BINARY && KIT_DIR.split(sep).includes("node_modules");
/** Dónde instala el ejecutable install.sh (y donde se actualiza solo), y donde el panel instala GitHub CLI si falta. */
export const BIN_DIR = join(HOME_DIR, "bin");
// El runner encuentra `backcode`, `gh`, `claude`, `eas`… aunque su PATH no los tenga: abierto desde la app de Mac o como
// servicio no hereda el de tu terminal. Se añaden ~/.backcode/bin, ~/.local/bin (Claude Code), Homebrew y los gestores de
// paquetes que se instalan en tu carpeta y solo se añaden en el .zshrc (bun, pnpm, Volta): sin ellos, `bun install` falla.
{
  const current = (process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  const bun = join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "bin");
  const pnpm = process.env.PNPM_HOME ?? join(homedir(), "Library", "pnpm");
  const extra = [BIN_DIR, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", bun, pnpm, join(homedir(), ".volta", "bin")].filter((d) => !current.includes(d) && existsSync(d));
  // Y el PATH de tu shell de login (rbenv con `pod`, nvm, bun…): lo que funciona en tu terminal funciona en el runner. Se
  // pregunta una vez; los procesos hijos (un runner por proyecto) lo heredan.
  const login = process.platform === "win32" || process.env.BACKCODE_SHELL_PATH ? null : loginShellEnv();
  process.env.BACKCODE_SHELL_PATH = "1";
  const shell = login?.PATH?.split(":").filter((d) => isAbsolute(d)) ?? [];
  const merged = [...new Set([...extra, ...current, ...shell.filter((d) => existsSync(d))])];
  if (merged.length !== current.length) process.env.PATH = merged.join(":");
  // Android: el SDK y el Java de tu shell; si no los define, los habituales. Sin ANDROID_HOME, Gradle falla con «SDK
  // location not found» (como servicio el runner no hereda tu terminal) y React Native compila con el JDK 17, no con el
  // que macOS tenga por defecto (p. ej. el 19).
  for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME"] as const) {
    if (!process.env[key] && login?.[key] && existsSync(login[key]!)) process.env[key] = login[key];
  }
  if (!process.env.ANDROID_HOME) {
    const sdk = [process.env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk"), join(homedir(), "Android", "Sdk")].find((d): d is string => !!d && existsSync(d));
    if (sdk) process.env.ANDROID_HOME = sdk;
  }
  if (process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) process.env.ANDROID_SDK_ROOT = process.env.ANDROID_HOME;
  if (!process.env.JAVA_HOME && process.platform === "darwin") {
    try {
      process.env.JAVA_HOME = execFileSync("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      // sin JDK 17: Gradle usará el que haya (y dirá qué versión le falta)
    }
  }
}

/** PATH, ANDROID_HOME, ANDROID_SDK_ROOT y JAVA_HOME de tu shell de login (zsh -il), o null si no responde en unos segundos. */
function loginShellEnv(): Partial<Record<"PATH" | "ANDROID_HOME" | "ANDROID_SDK_ROOT" | "JAVA_HOME", string>> | null {
  try {
    const keys = ["PATH", "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME"] as const;
    const script = keys.map((k) => `printf "\n__BACKCODE_${k}__%s__BACKCODE_${k}__\n" "$${k}"`).join("; ");
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", script], { encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "ignore"] });
    return Object.fromEntries(keys.map((k) => [k, new RegExp(`__BACKCODE_${k}__(.*)__BACKCODE_${k}__`).exec(out)?.[1] || undefined]).filter(([, v]) => v));
  } catch {
    return null;
  }
}

/**
 * Cómo lanzar este mismo runner con otros argumentos (un runner por proyecto, relanzarse, el servicio): el ejecutable
 * directamente o Node con dist/cli.js.
 */
export function selfCommand(args: string[]): [string, string[]] {
  return IS_BINARY ? [process.execPath, args] : [process.execPath, [join(KIT_DIR, "dist", "cli.js"), ...args]];
}

/** Argumentos con los que se lanzó este proceso, sin el ejecutable (para relanzarse igual). */
export const ownArgs = () => (IS_BINARY ? process.argv.slice(2) : process.argv.slice(1));
/** ¿Es la instalación propia de ~/.backcode/app (la que se puede actualizar sin permisos de administrador)? */
export const MANAGED = KIT_DIR.startsWith(APP_DIR + sep);

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700);
}

const PROJECT_FILE = /^([A-Za-z0-9_-]{1,64})\.env$/;

/** Fichero de configuración de un proyecto. */
export const projectFile = (projectId: string) => join(CONFIG_DIR, `${projectId}.env`);

/** Proyectos conectados en este ordenador: { id, file }, en orden alfabético. */
export function projectFiles(): { id: string; file: string }[] {
  if (!existsSync(CONFIG_DIR)) return [];
  return readdirSync(CONFIG_DIR)
    .map((name) => PROJECT_FILE.exec(name)?.[1])
    .filter((id): id is string => !!id)
    .sort()
    .map((id) => ({ id, file: projectFile(id) }));
}

/**
 * El fichero de `--env`: una ruta que exista tal cual, o el nombre antiguo `.env.<proyecto>` (que ahora es
 * ~/.backcode/config/<proyecto>.env). Así siguen valiendo los comandos que ya tenía cada uno (`npm start -- --env .env.x`).
 */
export function resolveEnvFile(arg: string): string {
  const direct = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  if (existsSync(direct)) return direct;
  const inKit = resolve(KIT_DIR, arg);
  if (existsSync(inKit)) return inKit;
  const id = /^\.env\.([A-Za-z0-9_-]+)$/.exec(basename(arg))?.[1] ?? PROJECT_FILE.exec(basename(arg))?.[1];
  return id ? projectFile(id) : direct;
}

/**
 * Mueve las configuraciones que `npm run connect` guardaba en la carpeta del kit (.env y .env.<proyecto>) a
 * ~/.backcode/config/<proyecto>.env. Si ya hay una en el destino, manda esa y la antigua se deja donde estaba.
 */
export function migrateLegacyConfigs(): string[] {
  if (FROM_NPM || IS_BINARY || !existsSync(KIT_DIR)) return [];
  const moved: string[] = [];
  for (const name of readdirSync(KIT_DIR)) {
    if (!/^\.env(\.[A-Za-z0-9_-]+)?$/.test(name) || name === ".env.example") continue;
    const from = join(KIT_DIR, name);
    let text: string;
    try {
      text = readFileSync(from, "utf8");
    } catch {
      continue; // otro runner lo acaba de mover
    }
    const id = /^BACKCODE_PROJECT_ID=([A-Za-z0-9_-]{1,64})\s*$/m.exec(text)?.[1] ?? name.slice(5);
    if (!id) continue;
    ensureConfigDir();
    const to = projectFile(id);
    if (existsSync(to)) continue;
    try {
      copyFileSync(from, to);
      chmodSync(to, 0o600);
      unlinkSync(from);
      moved.push(`${name} → ${to}`);
    } catch {
      // carrera con otro runner que arranca a la vez: el que gane la mueve
    }
  }
  return moved;
}

/**
 * Configuraciones de copias antiguas del runner (git clone) que aún no están en ~/.backcode/config: las de la carpeta de
 * los runners que estén en marcha y la de ~/Projects/backcode-runner. No se mueven (los runners antiguos las buscan ahí al
 * reiniciarse): el panel ofrece importarlas, copiándolas.
 */
export function legacyConfigs(): { dir: string; ids: string[]; running: boolean }[] {
  const running = new Set<string>();
  try {
    const ps = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8", timeout: 5000 });
    for (const m of ps.matchAll(/(\/\S+)\/dist\/(?:index|all|connect)\.js/g)) running.add(m[1]);
  } catch {
    // sin ps: solo la ruta por defecto
  }
  const dirs = new Set([...running, join(homedir(), "Projects", "backcode-runner")]);
  const out: { dir: string; ids: string[]; running: boolean }[] = [];
  for (const dir of dirs) {
    if (dir === KIT_DIR && !FROM_NPM && !IS_BINARY) continue; // la propia copia: se migra sola
    let names: string[];
    try {
      if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "backcode-runner") continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const ids = legacyIds(dir, names).filter((id) => !existsSync(projectFile(id)));
    if (ids.length) out.push({ dir, ids, running: running.has(dir) });
  }
  return out;
}

function legacyIds(dir: string, names: string[]): string[] {
  const ids: string[] = [];
  for (const name of names) {
    if (!/^\.env(\.[A-Za-z0-9_-]+)?$/.test(name) || name === ".env.example") continue;
    try {
      const id = /^BACKCODE_PROJECT_ID=([A-Za-z0-9_-]{1,64})\s*$/m.exec(readFileSync(join(dir, name), "utf8"))?.[1];
      if (id) ids.push(id);
    } catch {
      // ilegible: se ignora
    }
  }
  return ids;
}

/** Copia a ~/.backcode/config las configuraciones de una copia antigua (sin borrarlas de allí). */
export function importLegacy(dir: string): string[] {
  const found = legacyConfigs().find((l) => l.dir === dir);
  if (!found) return [];
  ensureConfigDir();
  const imported: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^\.env(\.[A-Za-z0-9_-]+)?$/.test(name) || name === ".env.example") continue;
    const text = readFileSync(join(dir, name), "utf8");
    const id = /^BACKCODE_PROJECT_ID=([A-Za-z0-9_-]{1,64})\s*$/m.exec(text)?.[1];
    if (!id || !found.ids.includes(id) || existsSync(projectFile(id))) continue;
    writeFileSync(projectFile(id), text, { mode: 0o600 });
    imported.push(id);
  }
  return imported;
}

/**
 * Ruta de la prueba de arranque para el script ota:publish del repo, que la lanza con `node "$BACKCODE_SMOKE_CLI"`. En el
 * ejecutable sin Node se deja al lado un .mjs que lo llama (en un proyecto Expo siempre hay Node).
 */
export function smokeCliPath(): string {
  if (!IS_BINARY) return join(KIT_DIR, "dist", "smoke-cli.js");
  const shim = join(KIT_DIR, "smoke-cli.mjs");
  const body = `// Generado por el runner de Backcode: la prueba de arranque vive en el ejecutable.\nimport { spawnSync } from "node:child_process";\nprocess.exit(spawnSync(${JSON.stringify(process.execPath)}, ["smoke", ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);\n`;
  if (!existsSync(shim) || readFileSync(shim, "utf8") !== body) writeFileSync(shim, body);
  return shim;
}
