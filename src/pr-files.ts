// Lo que la app necesita para avisar de que un PR cambia lo que ejecuta el runner con tus credenciales
// (app/src/lib/runner-config.ts): los ficheros que cambia el PR (result.changedFiles), qué package.json tocan sus scripts
// `backcode:deploy:*` (result.deployScriptFiles) y el comando real de cada despliegue (capabilities.deploys[].run).
// Va aparte de git.ts porque usa looksSecret (diagnostics.ts importa git.ts).

import { looksSecret } from "./diagnostics.js";
import { DEPLOY_PREFIX, deployCapabilities, type DeployTarget } from "./git.js";

/** Tope de ficheros que se guardan en la tarea (los de configuración del runner, siempre, aunque haya más). */
export const CHANGED_FILES_MAX = 200;
/** Tope del comando que se publica (la app lo recorta a 500 de todas formas). */
export const DEPLOY_RUN_MAX = 500;

/** Ficheros que declaran comandos que ejecuta el runner: van siempre en la lista, aunque el PR cambie muchos más. */
const RUNNER_CONFIG = /(^|\/)(backcode\.(toml|json)|package\.json)$/;

/** La lista que se guarda: sin vacíos ni duplicados, los de configuración del runner primero y como mucho `max`. */
export function capChangedFiles(files: string[], max = CHANGED_FILES_MAX): string[] {
  const clean = [...new Set(files.map((f) => f.trim()).filter(Boolean))];
  const config = clean.filter((f) => RUNNER_CONFIG.test(f));
  const rest = clean.filter((f) => !RUNNER_CONFIG.test(f));
  return [...config, ...rest].slice(0, max);
}

/** Scripts `backcode:deploy:*` de un package.json (texto), o {} si no se puede leer. */
export function deployScripts(pkg: string | null | undefined): Record<string, string> {
  if (!pkg) return {};
  try {
    const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return Object.fromEntries(Object.entries(scripts).filter((e): e is [string, string] => e[0].startsWith(DEPLOY_PREFIX) && typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** ¿Cambian los scripts `backcode:deploy:*` entre dos versiones de un package.json (null = no existía)? */
export function deployScriptsChanged(before: string | null, after: string | null): boolean {
  const a = deployScripts(before);
  const b = deployScripts(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].some((k) => a[k] !== b[k]);
}

/**
 * package.json del PR cuyos scripts `backcode:deploy:*` cambian respecto a la base. `show(rev, path)` devuelve el
 * contenido o null si no existe en esa revisión.
 */
export async function changedDeployScriptFiles(changed: string[], show: (rev: "base" | "head", path: string) => Promise<string | null>): Promise<string[]> {
  const out: string[] = [];
  for (const file of changed.filter((f) => /(^|\/)package\.json$/.test(f)).slice(0, 20)) {
    const [before, after] = await Promise.all([show("base", file), show("head", file)]);
    if (deployScriptsChanged(before, after)) out.push(file);
  }
  return out;
}

const quote = (arg: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** El comando que ejecuta un despliegue, tal como se enseña (sin secretos y recortado); undefined si no se publica. */
export function deployRun(target: Pick<DeployTarget, "script" | "auto">): string | undefined {
  const cmd = target.auto?.cmd;
  const raw = target.script ?? (cmd?.length ? (cmd[0] === "sh" && cmd[1] === "-c" && cmd.length === 3 ? cmd[2] : cmd.map(quote).join(" ")) : undefined);
  const run = raw?.trim();
  if (!run || looksSecret(run)) return undefined;
  return run.length > DEPLOY_RUN_MAX ? `${run.slice(0, DEPLOY_RUN_MAX - 1)}…` : run;
}

/** Lo que la app ve de cada destino, con su comando (`run`) cuando se puede enseñar. */
export function deployCapabilitiesWithRun(targets: DeployTarget[]) {
  const caps = deployCapabilities(targets);
  return caps.map((c, i) => {
    const run = deployRun(targets[i]);
    return run ? { ...c, run } : c;
  });
}
