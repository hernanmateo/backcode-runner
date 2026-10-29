import { spawn, type ChildProcess } from "node:child_process";
import { t } from "./i18n.js";

// Que el ordenador no entre en reposo por inactividad (BACKCODE_KEEP_AWAKE): "working", solo mientras hay una tarea, una
// acción o un refinado en marcha; "always", mientras el runner esté abierto; "off", nunca. En macOS con caffeinate y en
// Linux con systemd-inhibit; en otros sistemas no hace nada. Cerrar la tapa sin corriente duerme el Mac igual.

export type KeepAwakeMode = "off" | "working" | "always";

/** El inhibidor vive lo que este proceso: caffeinate lo vigila con -w; en Linux, un bucle con kill -0. */
function inhibitor(): ChildProcess | null {
  const pid = String(process.pid);
  if (process.platform === "darwin") return spawn("caffeinate", ["-i", "-w", pid], { stdio: "ignore" });
  if (process.platform === "linux") {
    return spawn(
      "systemd-inhibit",
      ["--what=idle:sleep", "--who=Backcode runner", `--why=${t("awake.why")}`, "--mode=block", "sh", "-c", `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`],
      { stdio: "ignore" },
    );
  }
  return null;
}

export class KeepAwake {
  private child: ChildProcess | null = null;
  private holds = 0;
  private unavailable = false;

  constructor(private readonly mode: KeepAwakeMode) {
    if (mode === "always") this.on();
  }

  /** Mientras dure un trabajo; devuelve con qué soltarlo. */
  hold(): () => void {
    this.holds++;
    if (this.mode === "working") this.on();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.mode === "working" && this.holds === 0) this.off();
    };
  }

  stop(): void {
    this.off();
  }

  private on(): void {
    if (this.child || this.unavailable) return;
    const child = inhibitor();
    if (!child) {
      this.unavailable = true;
      return;
    }
    this.child = child;
    child.on("error", (err) => {
      // Sin caffeinate/systemd-inhibit (p. ej. Linux sin systemd): se avisa una vez y se sigue sin él.
      this.unavailable = true;
      console.warn(`\x1b[33m⚠ ${t("awake.unavailable", { error: err.message })}\x1b[0m`);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
  }

  private off(): void {
    this.child?.kill();
    this.child = null;
  }
}

/**
 * «Mantener despierto enchufado» del panel (para todo el ordenador, no por proyecto): mientras está activado y el runner
 * encendido, el ordenador no entra en reposo por inactividad, así sigue cogiendo tareas cuando no lo usas. En macOS con
 * `caffeinate -s`, que solo actúa con el cargador puesto (con batería no la gasta); en Linux, systemd-inhibit (siempre).
 * La pantalla se apaga igual, y cerrar la tapa sin pantalla externa lo duerme igual.
 */
export class PluggedAwake {
  private child: ChildProcess | null = null;

  static supported(): boolean {
    return process.platform === "darwin" || process.platform === "linux";
  }

  set(on: boolean): void {
    if (!on) {
      this.child?.kill();
      this.child = null;
      return;
    }
    if (this.child || !PluggedAwake.supported()) return;
    const pid = String(process.pid);
    const child =
      process.platform === "darwin"
        ? spawn("caffeinate", ["-s", "-w", pid], { stdio: "ignore" })
        : spawn("systemd-inhibit", ["--what=idle:sleep", "--who=Backcode runner", `--why=${t("awake.why")}`, "--mode=block", "sh", "-c", `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`], { stdio: "ignore" });
    child.on("error", () => undefined);
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
  }

  get active(): boolean {
    return !!this.child;
  }
}

/** ¿Enchufado? (macOS: pmset). null si no se sabe (Linux u otros). */
export function onAcPower(): Promise<boolean | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn("pmset", ["-g", "batt"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(/AC Power/.test(out) ? true : /Battery Power/.test(out) ? false : null));
  });
}
