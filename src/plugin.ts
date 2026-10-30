import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readState, updateState } from "./paths.js";

// El plugin de Claude Code (plugins/backcode) se publica con el runner, pero Claude Code no actualiza solo los
// marketplaces de terceros. El runner sabe cuál es la última versión (la suya) y avisa: en Claude Code al empezar la sesión
// (hook session-start), en el panel y en `backcode status`, con un botón o los comandos para ponerlo al día.

/** La versión del plugin que va con este runner (= plugins/backcode/.claude-plugin/plugin.json; lo comprueba un test). */
export const PLUGIN_VERSION = "1.1.5";
export const PLUGIN_ID = "backcode@backcode";
export const MARKETPLACE_REPO = "hernanmateo/backcode-runner";
/** Lo que hay que escribir en Claude Code para actualizarlo a mano (con `!`, o en una terminal sin él). */
export const PLUGIN_UPDATE_CMDS = ["claude plugin marketplace update backcode", `claude plugin update ${PLUGIN_ID}`];
export const PLUGIN_INSTALL_CMDS = [`claude plugin marketplace add ${MARKETPLACE_REPO}`, `claude plugin install ${PLUGIN_ID} --scope user`];

/** ¿a es más antigua que b? (x.y.z; lo que no se entiende, nunca es «más antiguo»). */
export function olderThan(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if ([...pa, ...pb].some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export interface PluginInstall {
  version: string;
  scope: string;
  projectPath?: string;
}

/** Las instalaciones del plugin según `claude plugin list --json` (una por alcance: user, project, local). */
export function parsePluginList(json: string): PluginInstall[] {
  try {
    const list = JSON.parse(json) as { id?: string; version?: string; scope?: string; projectPath?: string }[];
    return Array.isArray(list) ? list.filter((p) => p.id === PLUGIN_ID && typeof p.version === "string").map((p) => ({ version: p.version!, scope: p.scope ?? "user", ...(p.projectPath ? { projectPath: p.projectPath } : {}) })) : [];
  } catch {
    return [];
  }
}

function claudeRun(claude: string, args: string[], cwd?: string, timeout = 60_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(claude, args, { timeout, cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }));
  });
}

/** Qué hay instalado. null si no se pudo saber (Claude Code antiguo, sin el comando `plugin`). */
export async function pluginInstalls(claude: string): Promise<PluginInstall[] | null> {
  const r = await claudeRun(claude, ["plugin", "list", "--json"], undefined, 20_000);
  return r.ok ? parsePluginList(r.output) : null;
}

/** Instala el plugin (para tu usuario) o pone al día cada instalación antigua. Lo mismo que los comandos de la guía. */
export async function installOrUpdatePlugin(claude: string): Promise<{ ok: boolean; output: string }> {
  const out: string[] = [];
  const step = async (args: string[], cwd?: string) => {
    const r = await claudeRun(claude, args, cwd, 120_000);
    out.push(`$ claude ${args.join(" ")}`, r.output);
    return r.ok;
  };
  // El marketplace: se actualiza, o se añade si no estaba.
  if (!(await step(["plugin", "marketplace", "update", "backcode"])) && !(await step(["plugin", "marketplace", "add", MARKETPLACE_REPO]))) return { ok: false, output: out.join("\n") };
  const installs = (await pluginInstalls(claude)) ?? [];
  let ok = true;
  if (!installs.length) ok = await step(["plugin", "install", PLUGIN_ID, "--scope", "user"]);
  for (const i of installs.filter((i) => olderThan(i.version, PLUGIN_VERSION))) {
    // Las de proyecto se actualizan desde ese proyecto.
    if (i.scope !== "user" && (!i.projectPath || !existsSync(i.projectPath))) continue;
    ok = (await step(["plugin", "update", PLUGIN_ID, "--scope", i.scope], i.scope === "user" ? undefined : i.projectPath)) && ok;
  }
  return { ok, output: out.join("\n").split("\n").slice(-16).join("\n") };
}

/** La versión del plugin que está ejecutando el hook (Claude Code pasa su carpeta en CLAUDE_PLUGIN_ROOT). */
export function runningPluginVersion(root = process.env.CLAUDE_PLUGIN_ROOT): string | null {
  if (!root) return null;
  try {
    return (JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Aviso para Claude al empezar la sesión si el plugin es más antiguo que el del runner: como mucho uno al día (si no,
 * saldría en cada sesión). null si está al día, no se sabe o ya se avisó hoy.
 */
export function pluginUpdateNotice(installed: string | null, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!installed || !olderThan(installed, PLUGIN_VERSION)) return null;
  if (readState().pluginNoticeDay === today) return null;
  updateState({ pluginNoticeDay: today });
  return [
    `The Backcode plugin for Claude Code is out of date (installed ${installed}, latest ${PLUGIN_VERSION}); Claude Code doesn't update this marketplace by itself.`,
    "At a natural moment (don't interrupt the user's request), tell the user briefly, in their language, and how to update:",
    ...PLUGIN_UPDATE_CMDS.map((c) => `- \`! ${c}\``),
    "- then restart Claude Code. Or press “Update the plugin” in the Backcode panel (`backcode`).",
    "To keep it up to date from now on: /plugin › Marketplaces › backcode › enable auto-update.",
  ].join("\n");
}
