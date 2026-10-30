import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { t } from "./i18n.js";
import { ghPath } from "./github.js";
import { IS_BINARY } from "./paths.js";

/** Instalador oficial de Claude Code (nativo, sin Node). */
export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";

// Comprobaciones de este ordenador antes de conectar o arrancar: Node y Claude Code.
// El Agent SDK no usa el `claude` del PATH: trae su propio binario en un paquete opcional por plataforma
// (@anthropic-ai/claude-agent-sdk-<os>-<arch>). Lo imprescindible es ese binario y una sesión iniciada
// (la comparte con la Claude Code instalada: se inicia una vez ejecutando `claude`).

const exec = promisify(execFile);
/** stdout de un comando; nunca lanza (ni si spawn falla de forma síncrona, p. ej. ENOEXEC). */
async function run(bin: string, args: string[], timeout: number): Promise<string> {
  try {
    return (await exec(bin, args, { timeout })).stdout;
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "");
  }
}
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** null si la versión de Node vale; si no, el mensaje. */
export function nodeProblem(): string | null {
  return Number(process.versions.node.split(".")[0]) >= 22 ? null : t("pre.nodeOld", { version: process.version });
}

/** Paquetes candidatos del binario, con la misma lógica que el SDK. */
function sdkBinaryPackages(): string[] {
  const { platform, arch } = process;
  const base = "@anthropic-ai/claude-agent-sdk";
  const names = platform === "linux" ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${platform}-${arch}`];
  return names.map((n) => `${n}/claude${platform === "win32" ? ".exe" : ""}`);
}

/** Ruta del Claude Code que trae el SDK, o null si no se instaló (p. ej. npm install --omit=optional) o es el ejecutable. */
export function bundledClaude(): string | null {
  if (IS_BINARY) return null;
  const req = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  for (const p of sdkBinaryPackages()) {
    try {
      return req.resolve(p);
    } catch {
      // siguiente candidato
    }
  }
  return null;
}

/** El `claude` instalado (PATH o las rutas del instalador nativo), o null. */
export function installedClaude(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs.filter(Boolean)) {
    try {
      accessSync(join(dir, "claude"), constants.X_OK);
      return join(dir, "claude");
    } catch {
      // siguiente
    }
  }
  return null;
}

/**
 * Qué Claude Code lanza el Agent SDK: con npm, el suyo (undefined = el que trae el paquete); en el ejecutable sin Node,
 * el que tienes instalado.
 */
export function claudeExecutable(): string | undefined {
  return IS_BINARY ? (installedClaude() ?? undefined) : undefined;
}

/** Versión de un ejecutable de Claude Code (`claude -v`), o null si no está o no responde. */
export async function claudeVersion(bin: string): Promise<string | null> {
  return /\d+\.\d+\.\d+/.exec(await run(bin, ["-v"], 10_000))?.[0] ?? null;
}

/** ¿Hay sesión iniciada? null si no se puede saber (versión sin `auth status`, timeout…). */
export async function claudeLoggedIn(bin: string): Promise<boolean | null> {
  const out = await run(bin, ["auth", "status", "--json"], 15_000);
  try {
    const status = JSON.parse(out) as { loggedIn?: unknown };
    return typeof status.loggedIn === "boolean" ? status.loggedIn : null;
  } catch {
    return null;
  }
}

/**
 * Comprueba Node y Claude Code y lo cuenta en la terminal. Devuelve false si falta algo imprescindible (Node antiguo o el
 * binario del SDK); la sesión o la CLI que faltan solo se avisan (el runner arrancaría igual, pero las tareas fallarían).
 */
export async function checkMachine(opts: { verbose: boolean }): Promise<boolean> {
  const node = nodeProblem();
  if (node) {
    console.error(`\n✗ ${node}`);
    return false;
  }
  // En el ejecutable sin Node, Claude Code es el que tienes instalado: sin él no hay nada que hacer.
  const bundled = IS_BINARY ? installedClaude() : bundledClaude();
  if (!bundled) {
    console.error(`\n✗ ${IS_BINARY ? t("pre.claudeMissing", { cmd: CLAUDE_INSTALL }) : t("pre.sdkMissing", { pkg: sdkBinaryPackages()[0].replace(/\/claude(\.exe)?$/, "") })}`);
    return false;
  }
  if (opts.verbose && !IS_BINARY) console.log(`✓ Node ${process.versions.node}`);
  const cli = await claudeVersion(IS_BINARY ? bundled : "claude");
  if (cli && opts.verbose) console.log(`✓ Claude Code ${cli}`);
  const loggedIn = await claudeLoggedIn(cli ? "claude" : bundled);
  if (loggedIn === false) console.warn(YELLOW(`⚠ ${cli ? t("pre.notLoggedIn") : t("pre.noCli")}`));
  else if (!cli && loggedIn === null) console.warn(YELLOW(`⚠ ${t("pre.noCli")}`));
  else if (!cli && opts.verbose) console.log(t("pre.bundledOk", { version: (await claudeVersion(bundled)) ?? "" }));
  return true;
}

export interface Check {
  id: "node" | "claude" | "login" | "git" | "gh" | "plugin";
  /** ok · warn (funciona, pero algo fallará) · fail (no puede arrancar) */
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Comando que lo arregla, para copiarlo. */
  fix?: string;
  /** Qué falta: el programa o la sesión (decide la guía y el botón del panel). */
  missing?: "program" | "session";
  /** No hace falta para las tareas (el plugin de Claude Code): no cuenta como «falta algo». */
  optional?: boolean;
  /** El plugin está instalado pero es más antiguo que el del runner. */
  outdated?: boolean;
}

/** Lo mismo que checkMachine, más git y GitHub CLI, en datos para el panel. */
export async function machineReport(): Promise<Check[]> {
  const checks: Check[] = [];
  // El ejecutable sin Node no necesita Node: solo se comprueba con npm o una copia de git.
  if (!IS_BINARY) {
    const node = nodeProblem();
    checks.push(node ? { id: "node", status: "fail", detail: node, fix: "https://nodejs.org" } : { id: "node", status: "ok", detail: `Node ${process.versions.node}` });
  }
  const installed = installedClaude();
  const bundled = IS_BINARY ? installed : bundledClaude();
  const cli = installed ? await claudeVersion(installed) : null;
  if (!bundled) checks.push({ id: "claude", status: "fail", detail: IS_BINARY ? t("pre.claudeMissing", { cmd: CLAUDE_INSTALL }) : t("pre.sdkMissing", { pkg: sdkBinaryPackages()[0].replace(/\/claude(\.exe)?$/, "") }), fix: IS_BINARY ? CLAUDE_INSTALL : undefined });
  else checks.push(cli ? { id: "claude", status: "ok", detail: `Claude Code ${cli}` } : { id: "claude", status: "warn", detail: t("pre.noCli"), fix: CLAUDE_INSTALL });
  // Con una API key (guardada en el panel o en el entorno) no hace falta iniciar sesión.
  const apiKey = !!process.env.ANTHROPIC_API_KEY;
  const loggedIn = apiKey ? true : bundled ? await claudeLoggedIn(installed ?? bundled) : null;
  checks.push(loggedIn === false ? { id: "login", status: "warn", missing: "session", detail: t("pre.notLoggedIn"), fix: "claude" } : { id: "login", status: loggedIn ? "ok" : "warn", missing: loggedIn ? undefined : "session", detail: apiKey ? t("panel.check.apiKey") : loggedIn ? t("panel.check.loggedIn") : t("panel.check.loginUnknown"), fix: loggedIn ? undefined : "claude" });
  const git = /\d+\.\d+(\.\d+)?/.exec(await run("git", ["--version"], 10_000))?.[0];
  checks.push(git ? { id: "git", status: "ok", detail: `git ${git}` } : { id: "git", status: "fail", detail: t("panel.check.noGit"), fix: process.platform === "darwin" ? "xcode-select --install" : "sudo apt install git" });
  // El mismo gh que usa el runner (PATH, ~/.backcode/bin o Homebrew): el servicio no trae el PATH de tu terminal.
  const ghBin = ghPath() ?? "gh";
  const gh = /\d+\.\d+\.\d+/.exec(await run(ghBin, ["--version"], 10_000))?.[0];
  const ghAuth = gh ? await exec(ghBin, ["auth", "status"], { timeout: 15_000 }).then(() => true, () => false) : false;
  // El plugin de Claude Code (opcional: para trabajar con Claude Code fuera de las tareas). Solo con el `claude` instalado.
  if (installed && cli) {
    const { PLUGIN_INSTALL_CMDS, PLUGIN_UPDATE_CMDS, PLUGIN_VERSION, olderThan, pluginInstalls } = await import("./plugin.js");
    const plugins = await pluginInstalls(installed);
    if (plugins) {
      const old = plugins.find((p) => olderThan(p.version, PLUGIN_VERSION));
      const newest = plugins.map((p) => p.version).sort((a, b) => (olderThan(a, b) ? 1 : -1))[0];
      checks.push(!plugins.length
        ? { id: "plugin", status: "warn", optional: true, missing: "program", detail: t("panel.check.pluginMissing"), fix: PLUGIN_INSTALL_CMDS.join(" && ") }
        : old
          ? { id: "plugin", status: "warn", outdated: true, detail: t("panel.check.pluginOld", { installed: old.version, latest: PLUGIN_VERSION }), fix: PLUGIN_UPDATE_CMDS.join(" && ") }
          : { id: "plugin", status: "ok", detail: t("panel.check.pluginOk", { version: newest }) });
    }
  }
  checks.push(!gh ? { id: "gh", status: "warn", missing: "program", detail: t("panel.check.noGh"), fix: process.platform === "darwin" ? "brew install gh" : "https://cli.github.com" } : ghAuth ? { id: "gh", status: "ok", detail: `GitHub CLI ${gh}` } : { id: "gh", status: "warn", missing: "session", detail: t("panel.check.ghLogin"), fix: "gh auth login --hostname github.com --git-protocol https --web" });
  return checks;
}
