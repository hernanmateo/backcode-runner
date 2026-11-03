import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "./assets.js";
import { newer } from "./autoupdate.js";
import { openBrowser } from "./panel.js";
import { panelAlive, panelUrl, panelVersion } from "./panel-client.js";
import { BIN_DIR, readState } from "./paths.js";
import { diagnose, systemDiagnoseDeps, type Diagnosis } from "./app-diagnose.js";
import { installService, kickService, launchesExecutable, restartService, serviceInstalled, serviceProgram } from "./service.js";

// «Backcode Runner.app» (macOS): al abrirla con doble clic no hay terminal. Copia su ejecutable a ~/.backcode/bin (las
// actualizaciones del runner van a esa copia; la app la sustituye entera mac-app-update.ts), deja el runner como servicio («Arrancar al
// iniciar sesión») y abre el panel. Si ya está todo, solo abre el panel.

const exec = promisify(execFile);

/** ¿Este ejecutable es el de dentro de una .app (doble clic desde el Finder, sin argumentos propios)? */
export function launchedAsApp(): boolean {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-psn_")); // macOS antiguo añade -psn_… al abrir una app
  return process.platform === "darwin" && process.execPath.includes(".app/Contents/MacOS/") && args.length === 0;
}

/** Lo que devuelve la preparación: la dirección del panel o, si no ha respondido nunca, el porqué. */
export type AppLaunch = { url: string } | { diagnosis: Diagnosis };

/**
 * Lo que hace la app al abrirse: instala o pone al día la copia de ~/.backcode/bin, deja el servicio y espera al panel.
 * Devuelve su dirección (con el token) o, si el panel no ha respondido, un diagnóstico. La ventana nativa de la app
 * (mac/BackcodeRunner.swift) lo pide con `backcode app-url`. `onStep`: cada paso, para enseñarlo bajo el spinner.
 * `noService`: el botón «Start without service» de la app: el panel en segundo plano, sin launchd.
 */
export async function prepareApp(opts: { retry?: boolean; noService?: boolean; onStep?: (step: string) => void } = {}): Promise<AppLaunch> {
  const step = opts.onStep ?? (() => undefined);
  step("Preparing the runner…");
  const installed = join(BIN_DIR, "backcode");
  const current = existsSync(installed) ? await exec(installed, ["--version"], { timeout: 15_000 }).then((r) => r.stdout.trim(), () => "") : "";
  // Solo hacia delante: si la copia instalada ya se actualizó sola a una versión más nueva que la de la app, se queda.
  if (!current || newer(VERSION, current)) {
    step("Installing the runner…");
    mkdirSync(BIN_DIR, { recursive: true });
    const tmp = `${installed}.new`;
    copyFileSync(process.execPath, tmp);
    chmodSync(tmp, 0o755);
    // La copia hereda la cuarentena de la descarga: fuera (la app ya pasó Gatekeeper al abrirla).
    await exec("xattr", ["-d", "com.apple.quarantine", tmp], { timeout: 10_000 }).catch(() => undefined);
    renameSync(tmp, installed);
  }
  // La versión que debe tener el panel: la de la app o, si la copia instalada ya es más nueva, la suya (nunca hacia atrás).
  const target = current && !newer(VERSION, current) ? current : VERSION;
  // BACKCODE_APP_NO_SERVICE (solo para probar la app sin instalar un LaunchAgent) o «Arrancar al iniciar sesión»
  // desactivado a mano: el panel en segundo plano, sin más (no se vuelve a activar por abrir la app).
  const noService = !!opts.noService || process.env.BACKCODE_APP_NO_SERVICE === "1" || !!readState().autostartOff;
  return bringUpPanel({
    mode: noService ? "no-service" : serviceInstalled() ? "wake" : "install",
    retry: !!opts.retry,
    alive: panelAlive,
    serve: () => spawn(installed, ["serve"], { detached: true, stdio: "ignore" }).unref(),
    install: () => installService({ executable: installed }),
    kick: kickService,
    restart: restartService,
    executable: installed,
    program: serviceProgram,
    version: target,
    panelVersion,
    sleep,
    step,
    url: panelUrl,
    diagnose: () => diagnose(systemDiagnoseDeps(!noService)),
  });
}

/**
 * El panel en marcha según el modo (`no-service`: proceso suelto; `install`: instalar el servicio; `wake`: despertar el
 * que ya está). Si no responde en el tiempo previsto, no devuelve la dirección como si nada: devuelve el diagnóstico.
 * En `wake`, antes se comprueba que el servicio lance `executable serve` (`program`: ProgramArguments del plist); si
 * lanza otra cosa (node + cli.js de una instalación antigua, npx…) se reinstala. Y si el panel responde con una versión
 * más antigua que `version`, se relanza una sola vez para que coja el ejecutable nuevo (sin bucles ni vuelta atrás).
 */
export async function bringUpPanel(d: {
  mode: "no-service" | "install" | "wake";
  retry: boolean;
  alive: () => Promise<boolean>;
  serve: () => void;
  install: () => Promise<void>;
  kick: () => Promise<void>;
  restart: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  step: (step: string) => void;
  url: () => string;
  diagnose: () => Promise<Diagnosis>;
  executable?: string;
  program?: () => Promise<string[] | null>;
  version?: string;
  panelVersion?: () => Promise<string | null>;
}): Promise<AppLaunch> {
  let up: boolean;
  if (d.mode === "no-service") {
    if (!(await d.alive())) {
      d.step("Starting the panel in the background…");
      d.serve();
    }
    d.step("Waiting for the panel…");
    up = await waitForPanel(d.alive, d.sleep, 20_000);
  } else if (d.mode === "install") {
    d.step("Installing the service…");
    up = await installAndWait(d);
  } else if (await staleProgram(d)) {
    // El plist lanza otro ejecutable: despertarlo arrancaría la versión vieja. Se reescribe (bootout + bootstrap + kickstart).
    d.step("Updating the service…");
    up = await installAndWait(d);
  } else {
    up = await wakeService(d);
    if (up && (await stalePanel(d))) {
      d.step("Updating the service…");
      await d.restart().catch(() => undefined);
      d.step("Waiting for the panel…");
      // Una sola vez: si sigue respondiendo el viejo (otro proceso con el puerto), se abre igualmente.
      up = await waitForPanel(d.alive, d.sleep, 20_000);
    }
  }
  if (up) return { url: d.url() };
  d.step("Checking what went wrong…");
  return { diagnosis: await d.diagnose() };
}

/** Instala (o reinstala) el servicio y espera al panel. Si launchctl falla al cargarlo, el diagnóstico dirá por qué. */
async function installAndWait(d: {
  install: () => Promise<void>;
  alive: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  step: (step: string) => void;
}): Promise<boolean> {
  const installed = await d.install().then(() => true, () => false);
  if (installed) d.step("Waiting for the panel…");
  return installed && (await waitForPanel(d.alive, d.sleep, 35_000));
}

/** ¿El plist instalado lanza algo distinto de `executable serve`? Sin plist legible, no (no se toca nada). */
async function staleProgram(d: { executable?: string; program?: () => Promise<string[] | null> }): Promise<boolean> {
  if (!d.executable || !d.program) return false;
  const program = await d.program().catch(() => null);
  return !!program && !launchesExecutable(program, d.executable);
}

/** ¿El panel que responde es de una versión más antigua que la esperada? (solo hacia delante: si es más nueva, no). */
async function stalePanel(d: { version?: string; panelVersion?: () => Promise<string | null> }): Promise<boolean> {
  if (!d.version || !d.panelVersion) return false;
  const running = await d.panelVersion().catch(() => null);
  return !!running && newer(d.version, running);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Espera al panel hasta `ms` (por defecto ~30 s): cuenta tanto las vueltas (cada una, 500 ms de espera) como el reloj,
 * porque cada consulta puede tardar hasta 3 s si el puerto acepta la conexión pero no contesta.
 */
async function waitForPanel(alive: () => Promise<boolean>, wait: (ms: number) => Promise<void>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (let i = 0; i < ms / 500 && Date.now() < end; i++) {
    if (await alive()) return true;
    await wait(500);
  }
  return alive();
}

/**
 * Servicio ya instalado y el panel no responde. Primera vez: `kickstart` sin -k (instalado pero sin arrancar, launchd lo
 * deja en espera; si solo está arrancando, no se toca). Solo con el panel ya visto sin responder (tras la espera, o al
 * darle a «Reintentar» en la app) se relanza con -k: el proceso puede existir colgado o con un ejecutable viejo.
 * Las esperas suman como mucho ~40 s, para que la app reciba el diagnóstico antes de su propio límite (60 s).
 */
export async function wakeService(d: {
  retry: boolean;
  alive: () => Promise<boolean>;
  kick: () => Promise<void>;
  restart: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  step?: (step: string) => void;
}): Promise<boolean> {
  const step = d.step ?? (() => undefined);
  if (await d.alive()) return true;
  if (d.retry) {
    step("Restarting the service…");
    await d.restart().catch(() => undefined);
    step("Waiting for the panel…");
    return waitForPanel(d.alive, d.sleep, 30_000);
  }
  step("Starting the service…");
  await d.kick();
  step("Waiting for the panel…");
  if (await waitForPanel(d.alive, d.sleep, 15_000)) return true;
  step("Restarting the service…");
  await d.restart().catch(() => undefined);
  step("Waiting for the panel…");
  return waitForPanel(d.alive, d.sleep, 22_000);
}

/** Una línea de `backcode app-url` para la app: progreso, la dirección (siempre la última) o el error en JSON. */
export const appLine = {
  step: (text: string) => `status: ${text}`,
  result: (r: AppLaunch) => ("url" in r ? r.url : `error: ${JSON.stringify(r.diagnosis)}`),
};

/** Abierto sin la ventana nativa (el ejecutable directamente desde una .app): el panel en el navegador. */
export async function launchApp(): Promise<void> {
  const result = await prepareApp();
  if ("url" in result) openBrowser(result.url);
  else console.error(`${result.diagnosis.message}\n${result.diagnosis.hint}`);
  // Que dé tiempo a lanzar el navegador antes de salir.
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}
