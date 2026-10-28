import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { CLAUDE_INSTALL, type Check } from "./preflight.js";

// Lo que el panel puede arreglar por ti cuando falta algo en este ordenador. Es una lista cerrada: el panel solo pide
// una acción por su nombre y aquí está el comando exacto (nunca viene de la página). Lo que necesita tu interacción
// (iniciar sesión) se abre en la Terminal, a la vista.

export type FixAction = "install-claude" | "login-claude" | "install-git" | "install-gh" | "login-gh";

const GH_LOGIN = "gh auth login --hostname github.com --git-protocol https --web";
const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

const brew = (): string | null => {
  for (const b of BREW) {
    try {
      accessSync(b, constants.X_OK);
      return b;
    } catch {
      // siguiente
    }
  }
  return null;
};

/** Qué botones ofrecer para un requisito, según el sistema. */
export function fixesFor(check: Check): FixAction[] {
  if (check.status === "ok") return [];
  const mac = process.platform === "darwin";
  switch (check.id) {
    case "claude":
      return ["install-claude"];
    case "login":
      return mac ? ["login-claude"] : [];
    case "git":
      return mac ? ["install-git"] : [];
    case "gh":
      // Sin instalar: con Homebrew se instala aquí; sin él, el panel enlaza al instalador oficial.
      if (check.missing === "program") return mac && brew() ? ["install-gh"] : [];
      return mac ? ["login-gh"] : [];
    default:
      return [];
  }
}

/** Abre la Terminal con un comando a la vista (macOS). */
function openTerminal(command: string): Promise<void> {
  const script = `tell application "Terminal"\nactivate\ndo script "${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nend tell`;
  return new Promise((resolve, reject) => execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve())));
}

/** Ejecuta un comando y devuelve las últimas líneas de su salida. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, NONINTERACTIVE: "1", HOMEBREW_NO_AUTO_UPDATE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (d: Buffer) => (output = (output + d.toString()).slice(-4000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim().split("\n").slice(-12).join("\n") });
    });
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
  });
}

export async function runFix(action: FixAction): Promise<{ ok: boolean; output?: string; terminal?: boolean }> {
  switch (action) {
    case "install-claude":
      // El instalador oficial de Anthropic (nativo, sin Node), el mismo que en su documentación.
      return run("/bin/bash", ["-c", CLAUDE_INSTALL], 10 * 60_000);
    case "login-claude":
      await openTerminal("claude");
      return { ok: true, terminal: true };
    case "install-git":
      // Abre la ventana de macOS para instalar las herramientas de desarrollador (incluye git).
      await run("xcode-select", ["--install"], 30_000);
      return { ok: true };
    case "install-gh": {
      const b = brew();
      if (!b) return { ok: false, output: "Homebrew not found" };
      return run(b, ["install", "gh"], 15 * 60_000);
    }
    case "login-gh":
      await openTerminal(GH_LOGIN);
      return { ok: true, terminal: true };
  }
}

export const FIX_ACTIONS: readonly FixAction[] = ["install-claude", "login-claude", "install-git", "install-gh", "login-gh"];
