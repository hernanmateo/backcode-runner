import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "./assets.js";
import { newer } from "./autoupdate.js";
import { openBrowser } from "./panel.js";
import { panelAlive, panelUrl } from "./panel-client.js";
import { BIN_DIR, readState } from "./paths.js";
import { installService, kickService, restartService, serviceInstalled } from "./service.js";

// «Backcode Runner.app» (macOS): al abrirla con doble clic no hay terminal. Copia su ejecutable a ~/.backcode/bin (las
// actualizaciones del runner van a esa copia; la app la sustituye entera mac-app-update.ts), deja el runner como servicio («Arrancar al
// iniciar sesión») y abre el panel. Si ya está todo, solo abre el panel.

const exec = promisify(execFile);

/** ¿Este ejecutable es el de dentro de una .app (doble clic desde el Finder, sin argumentos propios)? */
export function launchedAsApp(): boolean {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-psn_")); // macOS antiguo añade -psn_… al abrir una app
  return process.platform === "darwin" && process.execPath.includes(".app/Contents/MacOS/") && args.length === 0;
}

/**
 * Lo que hace la app al abrirse: instala o pone al día la copia de ~/.backcode/bin, deja el servicio y espera al panel.
 * Devuelve su dirección (con el token). La ventana nativa de la app (mac/BackcodeRunner.swift) la carga con `backcode app-url`.
 */
export async function prepareApp(opts: { retry?: boolean } = {}): Promise<string> {
  const installed = join(BIN_DIR, "backcode");
  const current = existsSync(installed) ? await exec(installed, ["--version"], { timeout: 15_000 }).then((r) => r.stdout.trim(), () => "") : "";
  // Solo hacia delante: si la copia instalada ya se actualizó sola a una versión más nueva que la de la app, se queda.
  if (!current || newer(VERSION, current)) {
    mkdirSync(BIN_DIR, { recursive: true });
    const tmp = `${installed}.new`;
    copyFileSync(process.execPath, tmp);
    chmodSync(tmp, 0o755);
    // La copia hereda la cuarentena de la descarga: fuera (la app ya pasó Gatekeeper al abrirla).
    await exec("xattr", ["-d", "com.apple.quarantine", tmp]).catch(() => undefined);
    renameSync(tmp, installed);
  }
  // BACKCODE_APP_NO_SERVICE (solo para probar la app sin instalar un LaunchAgent) o «Arrancar al iniciar sesión»
  // desactivado a mano: el panel en segundo plano, sin más (no se vuelve a activar por abrir la app).
  if (process.env.BACKCODE_APP_NO_SERVICE === "1" || readState().autostartOff) {
    if (!(await panelAlive())) spawn(installed, ["serve"], { detached: true, stdio: "ignore" }).unref();
    await waitForPanel(panelAlive, sleep);
  } else if (!serviceInstalled()) {
    await installService({ executable: installed });
    await waitForPanel(panelAlive, sleep);
  } else await wakeService({ retry: !!opts.retry, alive: panelAlive, kick: kickService, restart: restartService, sleep });
  return panelUrl();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** El servicio tarda unos segundos en abrir el panel la primera vez: hasta ~30 s. */
async function waitForPanel(alive: () => Promise<boolean>, wait: (ms: number) => Promise<void>): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await alive()) return true;
    await wait(500);
  }
  return alive();
}

/**
 * Servicio ya instalado y el panel no responde. Primera vez: `kickstart` sin -k (instalado pero sin arrancar, launchd lo
 * deja en espera; si solo está arrancando, no se toca). Solo con el panel ya visto sin responder (tras la espera, o al
 * darle a «Reintentar» en la app) se relanza con -k: el proceso puede existir colgado o con un ejecutable viejo.
 */
export async function wakeService(d: {
  retry: boolean;
  alive: () => Promise<boolean>;
  kick: () => Promise<void>;
  restart: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  if (await d.alive()) return true;
  if (d.retry) await d.restart().catch(() => undefined);
  else {
    await d.kick();
    if (await waitForPanel(d.alive, d.sleep)) return true;
    await d.restart().catch(() => undefined);
  }
  return waitForPanel(d.alive, d.sleep);
}

/** Abierto sin la ventana nativa (el ejecutable directamente desde una .app): el panel en el navegador. */
export async function launchApp(): Promise<void> {
  openBrowser(await prepareApp());
  // Que dé tiempo a lanzar el navegador antes de salir.
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}
