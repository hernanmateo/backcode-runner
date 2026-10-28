import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "./assets.js";
import { newer } from "./autoupdate.js";
import { openBrowser } from "./panel.js";
import { panelAlive, panelUrl } from "./panel-client.js";
import { BIN_DIR } from "./paths.js";
import { installService, serviceInstalled } from "./service.js";

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
export async function prepareApp(): Promise<string> {
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
  // BACKCODE_APP_NO_SERVICE (solo para probar la app sin instalar un LaunchAgent): el panel en segundo plano, sin más.
  if (process.env.BACKCODE_APP_NO_SERVICE === "1") {
    if (!(await panelAlive())) spawn(installed, ["serve"], { detached: true, stdio: "ignore" }).unref();
  } else if (!serviceInstalled()) await installService({ executable: installed });

  // El servicio tarda unos segundos en abrir el panel la primera vez.
  for (let i = 0; i < 60 && !(await panelAlive()); i++) await new Promise((r) => setTimeout(r, 500));
  return panelUrl();
}

/** Abierto sin la ventana nativa (el ejecutable directamente desde una .app): el panel en el navegador. */
export async function launchApp(): Promise<void> {
  openBrowser(await prepareApp());
  // Que dé tiempo a lanzar el navegador antes de salir.
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}
