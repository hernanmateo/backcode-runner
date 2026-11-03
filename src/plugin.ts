import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readState, updateState } from "./paths.js";

// El plugin de Claude Code (plugins/backcode) se publica con el runner, pero Claude Code no actualiza solo los
// marketplaces de terceros. El runner sabe cuál es la última versión (la suya) y avisa: en Claude Code al empezar la sesión
// (hook session-start), en el panel y en `backcode status`, con un botón o los comandos para ponerlo al día.

/** La versión del plugin que va con este runner (= plugins/backcode/.claude-plugin/plugin.json; lo comprueba un test). */
export const PLUGIN_VERSION = "1.1.12";
export const PLUGIN_ID = "backcode@backcode";
export const MARKETPLACE_REPO = "hernanmateo/backcode-dist";
/** Lo que hay que escribir en Claude Code para actualizarlo a mano (con `!`, o en una terminal sin él). */
export const PLUGIN_UPDATE_CMDS = ["claude plugin marketplace update backcode", `claude plugin update ${PLUGIN_ID}`];
export const PLUGIN_INSTALL_CMDS = [`claude plugin marketplace add ${MARKETPLACE_REPO}`, `claude plugin install ${PLUGIN_ID} --scope user`];
/** El repo de antes de publicar el plugin en backcode-dist: quien lo añadió entonces tiene el marketplace apuntando aquí. */
export const OLD_MARKETPLACE_REPO = "hernanmateo/backcode-runner";
/** Para pasar a mano el marketplace `backcode` de otro repo a MARKETPLACE_REPO. */
export const PLUGIN_MIGRATE_CMDS = ["claude plugin marketplace remove backcode", ...PLUGIN_INSTALL_CMDS];

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
  /** Desactivado con `claude plugin disable` (sigue instalado). */
  enabled: boolean;
  projectPath?: string;
}

/** Las instalaciones del plugin según `claude plugin list --json` (una por alcance: user, project, local). */
export function parsePluginList(json: string): PluginInstall[] {
  try {
    const list = JSON.parse(json) as { id?: string; version?: string; scope?: string; enabled?: boolean; projectPath?: string }[];
    return Array.isArray(list) ? list.filter((p) => p.id === PLUGIN_ID && typeof p.version === "string").map((p) => ({ version: p.version!, scope: p.scope ?? "user", enabled: p.enabled !== false, ...(p.projectPath ? { projectPath: p.projectPath } : {}) })) : [];
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

/** ¿El .claude/settings.json del repo lo activa para todo el equipo? (`projectEnabled` de `claude plugin list` en esa carpeta). */
export function parseRepoEnabled(json: string): boolean {
  try {
    const list = JSON.parse(json) as { id?: string; projectEnabled?: boolean }[];
    return Array.isArray(list) && list.some((p) => p.id === PLUGIN_ID && p.projectEnabled === true);
  } catch {
    return false;
  }
}

/**
 * En cada repo: `repo` = activado en el repo para el equipo; `user` = te funciona a ti (instalado para tu usuario o en
 * ese proyecto) pero el repo no lo activa; `off` = no está activo ahí.
 */
export type RepoPlugin = "repo" | "user" | "off";

export function repoPlugin(installs: PluginInstall[], repoPath: string, repoEnabled: boolean): RepoPlugin {
  if (repoEnabled) return "repo";
  const mine = installs.some((i) => i.enabled && (i.scope === "user" || i.projectPath === repoPath));
  return mine ? "user" : "off";
}

/** El estado del plugin en cada repo conectado (una llamada a `claude plugin list` por repo, en paralelo). */
export async function pluginInRepos(claude: string, installs: PluginInstall[], repoPaths: string[]): Promise<Record<string, RepoPlugin>> {
  const entries = await Promise.all(
    // La clave es la ruta tal como está en la configuración (puede empezar por ~): así la encuentran el panel y status.
    [...new Set(repoPaths)].map((p) => [p, p.replace(/^~(?=\/|$)/, homedir())] as const).filter(([, dir]) => existsSync(dir)).map(async ([p, dir]) => {
      const r = await claudeRun(claude, ["plugin", "list", "--json"], dir, 20_000);
      return [p, repoPlugin(installs, dir, r.ok && parseRepoEnabled(r.output))] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * El marketplace `backcode` de este ordenador: `missing` (no está), `current` (MARKETPLACE_REPO), `stale` (otro repo o URL,
 * p. ej. el antiguo hernanmateo/backcode-runner: hay que quitarlo y volver a añadirlo) o `local` (una carpeta o un archivo,
 * para desarrollar: no se toca).
 */
export type MarketplaceState = "missing" | "current" | "stale" | "local";
export interface BackcodeMarketplace {
  state: MarketplaceState;
  /** De dónde lee: el repo de GitHub, la URL o la ruta. */
  source?: string;
}
type MarketplaceSource = { source?: string; repo?: string; url?: string; path?: string };

/** Un repo de GitHub (`owner/repo`) o una URL de git de github.com, como `owner/repo` en minúsculas; null si no lo es. */
function githubRepo(s: string): string | null {
  const m = /^(?:(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(s.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Clasifica la fuente de un marketplace (`{ source, repo | url | path }`, como en `marketplace list --json` o known_marketplaces.json). */
export function classifyMarketplace(src: MarketplaceSource | null | undefined): BackcodeMarketplace {
  if (!src) return { state: "missing" };
  const remote = src.source === "github" ? src.repo : src.source === "git" || src.source === "url" ? src.url : undefined;
  if (!remote) return { state: "local", source: src.path ?? src.repo ?? src.url };
  return { state: githubRepo(remote) === MARKETPLACE_REPO.toLowerCase() ? "current" : "stale", source: remote };
}

/** El marketplace `backcode` según `claude plugin marketplace list --json` (los demás no se miran). null si no se entiende. */
export function parseMarketplaceList(json: string): BackcodeMarketplace | null {
  try {
    const list = JSON.parse(json) as ({ name?: string } & MarketplaceSource)[];
    return Array.isArray(list) ? classifyMarketplace(list.find((m) => m.name === "backcode")) : null;
  } catch {
    return null;
  }
}

/** Lo mismo desde ~/.claude/plugins/known_marketplaces.json (solo la entrada `backcode`). */
export function parseKnownMarketplaces(json: string): BackcodeMarketplace | null {
  try {
    const known = JSON.parse(json) as Record<string, { source?: MarketplaceSource } | undefined> | null;
    return known && typeof known === "object" && !Array.isArray(known) ? classifyMarketplace(known.backcode?.source) : null;
  } catch {
    return null;
  }
}

/** De dónde lee el marketplace `backcode` (solo lectura). null si no se pudo saber. */
export async function backcodeMarketplace(claude: string, knownFile = join(homedir(), ".claude", "plugins", "known_marketplaces.json")): Promise<BackcodeMarketplace | null> {
  const r = await claudeRun(claude, ["plugin", "marketplace", "list", "--json"], undefined, 20_000);
  const listed = r.ok ? parseMarketplaceList(r.output) : null;
  if (listed) return listed;
  // Claude Code sin `--json`: el archivo donde guarda los marketplaces.
  try {
    return existsSync(knownFile) ? parseKnownMarketplaces(readFileSync(knownFile, "utf8")) : null;
  } catch {
    return null;
  }
}

/** Activa el plugin desactivado (para tu usuario). */
export function enablePlugin(claude: string): Promise<{ ok: boolean; output: string }> {
  return claudeRun(claude, ["plugin", "enable", PLUGIN_ID, "--scope", "user"]);
}

/**
 * Instala el plugin (para tu usuario) o pone al día cada instalación antigua. Lo mismo que los comandos de la guía. Si el
 * marketplace `backcode` lee de otro repo (el antiguo hernanmateo/backcode-runner), lo quita, lo vuelve a añadir desde
 * MARKETPLACE_REPO y reinstala el plugin con los mismos alcances. Uno local (para desarrollar) y los demás no se tocan.
 */
export async function installOrUpdatePlugin(claude: string, knownFile?: string): Promise<{ ok: boolean; output: string }> {
  const out: string[] = [];
  const step = async (args: string[], cwd?: string) => {
    const r = await claudeRun(claude, args, cwd, 120_000);
    out.push(`$ claude ${args.join(" ")}`, r.output);
    return r.ok;
  };
  const market = await backcodeMarketplace(claude, knownFile);
  const before = (await pluginInstalls(claude)) ?? [];
  // `add` falla si ya hay un marketplace `backcode`, aunque lea de otro repo: primero se quita (si no estaba, da igual).
  const readd = async () => {
    await step(["plugin", "marketplace", "remove", "backcode"]);
    return step(["plugin", "marketplace", "add", MARKETPLACE_REPO]);
  };
  const marketOk =
    market?.state === "stale" ? await readd()
    : market?.state === "missing" ? await step(["plugin", "marketplace", "add", MARKETPLACE_REPO])
    // Existe (o no se sabe): se actualiza; si falla (repo privado, borrado…), otra vez desde MARKETPLACE_REPO, salvo si es local.
    : (await step(["plugin", "marketplace", "update", "backcode"])) || (market?.state !== "local" && (await readd()));
  if (!marketOk) return { ok: false, output: out.join("\n").split("\n").slice(-16).join("\n") };
  let installs = (await pluginInstalls(claude)) ?? [];
  let ok = true;
  // Lo que se perdió al quitar el marketplace, otra vez con el mismo alcance (los de proyecto, desde ese proyecto).
  const same = (a: PluginInstall, b: PluginInstall) => a.scope === b.scope && (a.scope === "user" || a.projectPath === b.projectPath);
  const lost = before.filter((b) => !installs.some((i) => same(i, b)) && (b.scope === "user" || (!!b.projectPath && existsSync(b.projectPath))));
  for (const b of lost) ok = (await step(["plugin", "install", PLUGIN_ID, "--scope", b.scope], b.scope === "user" ? undefined : b.projectPath)) && ok;
  if (lost.length) installs = (await pluginInstalls(claude)) ?? installs;
  else if (!installs.length) ok = await step(["plugin", "install", PLUGIN_ID, "--scope", "user"]);
  for (const i of installs.filter((i) => olderThan(i.version, PLUGIN_VERSION))) {
    // Las de proyecto se actualizan desde ese proyecto.
    if (i.scope !== "user" && (!i.projectPath || !existsSync(i.projectPath))) continue;
    ok = (await step(["plugin", "update", PLUGIN_ID, "--scope", i.scope], i.scope === "user" ? undefined : i.projectPath)) && ok;
  }
  return { ok, output: out.join("\n").split("\n").slice(-16).join("\n") };
}

let migrating: Promise<boolean> | null = null;

/**
 * Sin que nadie haga nada: si el marketplace `backcode` aún lee de otro repo (el antiguo hernanmateo/backcode-runner), lo
 * pasa a MARKETPLACE_REPO y reinstala el plugin. Solo toca la configuración de Claude Code de este ordenador, nunca los
 * repos. Uno a la vez (varios runners en el mismo proceso); si falla, se reintenta la próxima vez. true si lo cambió.
 */
export function migrateStaleMarketplace(claude: string): Promise<boolean> {
  migrating ??= (async () => {
    try {
      const market = await backcodeMarketplace(claude);
      if (market?.state !== "stale") return false;
      const r = await installOrUpdatePlugin(claude);
      console.log(`[plugin] marketplace backcode: ${market.source} → ${MARKETPLACE_REPO} ${r.ok ? "✓" : `✗\n${r.output}`}`);
      return r.ok;
    } finally {
      migrating = null;
    }
  })();
  return migrating;
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
