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

/** Modo de «Mantener el ordenador despierto» (panel y app): nunca, solo enchufado, o siempre (también con batería). */
export type MachineAwakeMode = "off" | "plugged" | "always";
export const asAwakeMode = (v: unknown): MachineAwakeMode => (v === "plugged" || v === "always" ? v : "off");
/** El más fuerte de dos (lo pide el panel de este ordenador o tu perfil en la app). */
export const strongerAwake = (a: MachineAwakeMode, b: MachineAwakeMode): MachineAwakeMode => (a === "always" || b === "always" ? "always" : a === "plugged" || b === "plugged" ? "plugged" : "off");

/**
 * «Mantener el ordenador despierto» (para todo el ordenador, no por proyecto): mientras está activado y el runner encendido,
 * el ordenador no entra en reposo por inactividad, así sigue cogiendo tareas cuando no lo usas. En macOS con caffeinate:
 * «plugged» con -s, que solo actúa con el cargador puesto (con batería no la gasta); «always» con -i -s, también con
 * batería. En Linux, systemd-inhibit en los dos. La pantalla se apaga igual, y cerrar la tapa sin pantalla externa lo
 * duerme igual (eso solo lo cambia macOS con permisos de administrador).
 */
export class MachineAwake {
  private child: ChildProcess | null = null;
  private mode: MachineAwakeMode = "off";

  static supported(): boolean {
    return process.platform === "darwin" || process.platform === "linux";
  }

  set(mode: MachineAwakeMode): void {
    if (mode === this.mode && (mode === "off" || this.child)) return;
    this.child?.kill();
    this.child = null;
    this.mode = mode;
    if (mode === "off" || !MachineAwake.supported()) return;
    const pid = String(process.pid);
    const child =
      process.platform === "darwin"
        ? spawn("caffeinate", [...(mode === "always" ? ["-i"] : []), "-s", "-w", pid], { stdio: "ignore" })
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
