import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { latestPublished, newer, RELEASES_REPO } from "./autoupdate.js";
import { VERSION } from "./assets.js";
import { parseEnv } from "./config.js";
import { adbPath } from "./devices.js";
import { ghPath } from "./github.js";
import { macAppVersion } from "./mac-app-update.js";
import { machineChecks } from "./machines.js";
import { projectFiles } from "./paths.js";
import { olderThan, PLUGIN_VERSION, pluginInstalls } from "./plugin.js";
import { claudeVersion, installedClaude } from "./preflight.js";

// «Serveis» de Perfil › Tu ordenador: las herramientas que el runner usa en este ordenador (Claude Code y su plugin,
// git, Node, gh/Bitbucket, EAS, CLIs de despliegue, Xcode/adb, la app de Mac) con su estado y versión. Solo se publica
// instalado sí/no, sesión sí/no, versión y la última publicada: nunca tokens, cuentas ni variables de entorno. Y solo las
// que pide algún proyecto conectado aquí (Expo → EAS, Xcode y adb; firebase.json → Firebase CLI…).

const run = promisify(execFile);

/** Lista cerrada de servicios (la app y las reglas de Firestore conocen los mismos). */
export const SERVICE_IDS = ["runner", "macApp", "claude", "plugin", "remoteControl", "git", "node", "gh", "bitbucket", "eas", "firebase", "wrangler", "supabase", "xcode", "android"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];
/** Los que el runner sabe poner al día él solo, con comandos fijos (acción `updateService`). */
export const UPDATABLE_SERVICES = ["runner", "macApp", "plugin", "claude", "eas"] as const satisfies readonly ServiceId[];
export type UpdatableService = (typeof UPDATABLE_SERVICES)[number];

/** `unknown`: su comprobación falló o no respondió a tiempo (no se sabe si está instalado). */
export type ServiceState = "ok" | "off" | "noSession" | "outdated" | "missing" | "unknown";
export interface ServiceRow {
  id: ServiceId;
  state: ServiceState;
  version: string | null;
  latest: string | null;
}

/** Qué piden los proyectos conectados en este ordenador. */
export interface ServiceNeeds {
  github: boolean;
  bitbucket: boolean;
  expo: boolean;
  firebase: boolean;
  wrangler: boolean;
  supabase: boolean;
}

/** Lo que se ha visto en el ordenador (null: no instalado). */
export interface ServiceProbe {
  platform: NodeJS.Platform;
  runner: { version: string; latest: string | null };
  macApp: { version: string; latest: string | null } | null;
  claude: { version: string; loggedIn: boolean | null; latest: string | null } | null;
  plugin: { version: string; enabled: boolean } | null;
  git: string | null;
  node: string | null;
  gh: { version: string; loggedIn: boolean } | null;
  bitbucket: boolean;
  eas: { version: string; loggedIn: boolean | null; latest: string | null } | null;
  firebase: { version: string; latest: string | null } | null;
  wrangler: { version: string; latest: string | null } | null;
  supabase: { version: string } | null;
  xcode: string | null;
  android: string | null;
  /** Servicios cuya comprobación falló o se colgó: salen como `unknown` en vez de «no instalado». */
  unknown?: ServiceId[];
}

const VERSION_RE = /\d+\.\d+(?:\.\d+)?/;
/** Solo el número de versión (nada más del texto que imprima la herramienta). */
export function versionIn(text: string | null | undefined): string | null {
  return text ? (VERSION_RE.exec(text)?.[0] ?? null) : null;
}

function row(id: ServiceId, version: string | null, latest: string | null, state?: ServiceState): ServiceRow {
  const v = versionIn(version);
  const l = versionIn(latest);
  return { id, version: v, latest: l, state: state ?? (v && l && newer(l, v) ? "outdated" : "ok") };
}

/** Las filas de la app: solo los servicios relevantes para los proyectos de este ordenador. */
export function serviceRows(p: ServiceProbe, needs: ServiceNeeds): ServiceRow[] {
  const missing = (id: ServiceId, latest: string | null = null) => row(id, null, latest, p.unknown?.includes(id) ? "unknown" : "missing");
  const rows: ServiceRow[] = [row("runner", p.runner.version, p.runner.latest)];
  if (p.macApp) rows.push(row("macApp", p.macApp.version, p.macApp.latest));
  else if (p.unknown?.includes("macApp")) rows.push(missing("macApp"));
  rows.push(p.claude ? row("claude", p.claude.version, p.claude.latest, p.claude.loggedIn === false ? "noSession" : undefined) : missing("claude"));
  if (!p.plugin) rows.push(missing("plugin", PLUGIN_VERSION));
  else rows.push(row("plugin", p.plugin.version, PLUGIN_VERSION, !p.plugin.enabled ? "off" : olderThan(p.plugin.version, PLUGIN_VERSION) ? "outdated" : "ok"));
  const remote = p.platform === "darwin" || p.platform === "linux";
  rows.push(row("remoteControl", null, null, p.claude && remote ? "ok" : "off"));
  rows.push(p.git ? row("git", p.git, null) : missing("git"));
  rows.push(p.node ? row("node", p.node, null) : missing("node"));
  if (needs.github) rows.push(p.gh ? row("gh", p.gh.version, null, p.gh.loggedIn ? undefined : "noSession") : missing("gh"));
  if (needs.bitbucket) rows.push(row("bitbucket", null, null, p.bitbucket ? "ok" : "noSession"));
  if (needs.expo) rows.push(p.eas ? row("eas", p.eas.version, p.eas.latest, p.eas.loggedIn === false ? "noSession" : undefined) : missing("eas"));
  if (needs.firebase) rows.push(p.firebase ? row("firebase", p.firebase.version, p.firebase.latest) : missing("firebase"));
  if (needs.wrangler) rows.push(p.wrangler ? row("wrangler", p.wrangler.version, p.wrangler.latest) : missing("wrangler"));
  if (needs.supabase) rows.push(p.supabase ? row("supabase", p.supabase.version, null) : missing("supabase"));
  if (needs.expo && p.platform === "darwin") rows.push(p.xcode ? row("xcode", p.xcode, null) : missing("xcode"));
  if (needs.expo) rows.push(p.android ? row("android", p.android, null) : missing("android"));
  return rows;
}

/** Carpetas a mirar de un repo: la raíz y las de primer nivel (apps en monorepos), sin ocultas ni node_modules. */
function repoDirs(repo: string): string[] {
  try {
    const subs = readdirSync(repo, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .slice(0, 50)
      .map((d) => join(repo, d.name));
    return [repo, ...subs];
  } catch {
    return [];
  }
}

function isExpo(dir: string): boolean {
  if (existsSync(join(dir, "eas.json"))) return true;
  try {
    return !!(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as { expo?: unknown }).expo;
  } catch {
    return false;
  }
}

/** Qué piden los proyectos conectados (su proveedor de PR y lo que hay en su repo). */
export function serviceNeeds(): ServiceNeeds {
  const needs: ServiceNeeds = { github: false, bitbucket: false, expo: false, firebase: false, wrangler: false, supabase: false };
  for (const { file } of projectFiles()) {
    let env: Map<string, string>;
    try {
      env = new Map(parseEnv(readFileSync(file, "utf8")));
    } catch {
      continue;
    }
    const pr = env.get("BACKCODE_PULL_REQUEST");
    if (pr === "bitbucket") needs.bitbucket = true;
    else if (pr !== "push-only") needs.github = true;
    const repo = env.get("BACKCODE_REPO_PATH");
    if (!repo) continue;
    for (const dir of repoDirs(repo)) {
      needs.expo ||= isExpo(dir);
      needs.firebase ||= existsSync(join(dir, "firebase.json"));
      needs.wrangler ||= ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].some((f) => existsSync(join(dir, f)));
      needs.supabase ||= existsSync(join(dir, "supabase", "config.toml"));
    }
  }
  return needs;
}

/** Salida de un comando fijo (sin shell), o null si no está o falla. */
async function out(bin: string, args: string[], timeout = 15_000): Promise<string | null> {
  try {
    const r = await run(bin, args, { timeout });
    return `${r.stdout}${r.stderr}`.trim();
  } catch {
    return null;
  }
}

const LATEST_TTL_MS = 6 * 60 * 60_000;
const latestCache = new Map<string, { at: number; version: string | null }>();

/** Última versión de un paquete en el registro de npm (cacheada unas horas; null si no se pudo saber). */
async function npmLatestOf(pkg: string): Promise<string | null> {
  const hit = latestCache.get(pkg);
  if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.version;
  const version = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(15_000) })
    .then(async (r) => (r.ok ? versionIn(((await r.json()) as { version?: string }).version) : null))
    .catch(() => null);
  latestCache.set(pkg, { at: Date.now(), version });
  return version;
}

async function releaseLatestCached(): Promise<string | null> {
  const hit = latestCache.get("release");
  if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.version;
  const version = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) })
    .then(async (r) => (r.ok ? versionIn(((await r.json()) as { tag_name?: string }).tag_name) : null))
    .catch(() => null);
  latestCache.set("release", { at: Date.now(), version });
  return version;
}

async function runnerLatest(): Promise<string | null> {
  const hit = latestCache.get("runner");
  if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.version;
  const version = versionIn(await latestPublished());
  latestCache.set("runner", { at: Date.now(), version });
  return version;
}

/** Lo que tarda como mucho cada comprobación (los comandos ya tienen el suyo, pero un proceso hijo puede dejar la salida abierta). */
export const CHECK_TIMEOUT_MS = 20_000;

type Check = (() => unknown) | null;
type Settled<T extends Record<string, Check>> = { [K in keyof T]: NonNullable<T[K]> extends () => infer R ? Awaited<R> | null : null };

/**
 * Lanza todas las comprobaciones a la vez y espera cada una como mucho `ms`: la que falla o se cuelga vale null y se
 * apunta en `failed` (y en el log), sin impedir que se publiquen las demás.
 */
export async function settleChecks<T extends Record<string, Check>>(
  checks: T,
  ms = CHECK_TIMEOUT_MS,
  log: (msg: string) => void = (m) => console.warn(`[backcode] ${m}`),
): Promise<{ values: Settled<T>; failed: string[] }> {
  const failed: string[] = [];
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, fn]) => {
      if (!fn) return [name, null] as const;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        // Sin unref: si solo queda la comprobación colgada, el temporizador tiene que seguir vivo para cerrarla (se limpia en finally).
        timer = setTimeout(() => reject(new Error(`no response after ${Math.round(ms / 1000)} s`)), ms);
      });
      try {
        return [name, await Promise.race([Promise.resolve().then(fn), timeout])] as const;
      } catch (err) {
        failed.push(name);
        log(`tools check «${name}» failed: ${err instanceof Error ? err.message : String(err)}`);
        return [name, null] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { values: Object.fromEntries(entries) as Settled<T>, failed };
}

/** A qué servicio corresponde cada comprobación (para marcarlo `unknown` si falla). */
const CHECK_SERVICE: Record<string, ServiceId> = { claudeV: "claude", plugins: "plugin", git: "git", node: "node", ghV: "gh", easV: "eas", fbV: "firebase", wrV: "wrangler", sbV: "supabase", xcode: "xcode", adbV: "android", macV: "macApp" };

/** Mira cada herramienta (solo las que hacen falta) con comandos fijos de solo lectura. */
export async function probeServices(needs: ServiceNeeds): Promise<ServiceProbe> {
  const claudeBin = installedClaude();
  const gh = ghPath();
  const adb = adbPath();
  const darwin = process.platform === "darwin";
  const first = await settleChecks({
    checks: () => machineChecks(),
    claudeV: claudeBin ? () => claudeVersion(claudeBin) : null,
    plugins: claudeBin ? () => pluginInstalls(claudeBin) : null,
    git: () => out("git", ["--version"]),
    node: () => out("node", ["--version"]),
    ghV: needs.github && gh ? () => out(gh, ["--version"]) : null,
    easV: needs.expo ? () => out("eas", ["--version"]) : null,
    easWho: needs.expo ? () => run("eas", ["whoami"], { timeout: 20_000 }).then(() => true, (err: { code?: unknown }) => (err.code === "ENOENT" ? null : false)) : null,
    fbV: needs.firebase ? () => out("firebase", ["--version"]) : null,
    wrV: needs.wrangler ? () => out("wrangler", ["--version"]) : null,
    sbV: needs.supabase ? () => out("supabase", ["--version"]) : null,
    xcode: needs.expo && darwin ? () => out("xcodebuild", ["-version"]) : null,
    adbV: needs.expo && adb ? () => out(adb, ["version"]) : null,
    macV: darwin ? () => macAppVersion() : null,
  });
  const { checks, claudeV, plugins, git, node, ghV, easV, easWho, fbV, wrV, sbV, xcode, adbV, macV } = first.values;
  const { runnerL, releaseL, claudeL, easL, fbL, wrL } = (
    await settleChecks({
      runnerL: () => runnerLatest(),
      releaseL: macV ? () => releaseLatestCached() : null,
      claudeL: claudeV ? () => npmLatestOf("@anthropic-ai/claude-code") : null,
      easL: easV ? () => npmLatestOf("eas-cli") : null,
      fbL: fbV ? () => npmLatestOf("firebase-tools") : null,
      wrL: wrV ? () => npmLatestOf("wrangler") : null,
    })
  ).values;
  const plugin = plugins?.find((p) => p.scope === "user") ?? plugins?.[0] ?? null;
  const easVersion = versionIn(easV?.match(/eas-cli\/(\S+)/)?.[1] ?? easV);
  const unknown = first.failed.map((name) => CHECK_SERVICE[name]).filter((id): id is ServiceId => !!id);
  // `claude plugin list` sin respuesta válida con Claude Code instalado: no se sabe, no es «no instalado».
  if (claudeBin && plugins === null && !unknown.includes("plugin")) {
    unknown.push("plugin");
    console.warn("[backcode] tools check «plugins» failed: `claude plugin list --json` gave no answer");
  }
  return {
    platform: process.platform,
    runner: { version: VERSION, latest: runnerL },
    macApp: macV ? { version: macV, latest: releaseL } : null,
    claude: claudeV ? { version: claudeV, loggedIn: checks?.claude.loggedIn ?? null, latest: claudeL } : null,
    plugin: plugin ? { version: plugin.version, enabled: plugin.enabled } : null,
    git: versionIn(git),
    node: versionIn(node),
    gh: ghV ? { version: versionIn(ghV) ?? "", loggedIn: !!checks?.gh.loggedIn } : null,
    bitbucket: !!checks?.bitbucket,
    eas: easVersion ? { version: easVersion, loggedIn: easWho, latest: easL } : null,
    firebase: fbV ? { version: versionIn(fbV) ?? "", latest: fbL } : null,
    wrangler: wrV ? { version: versionIn(wrV) ?? "", latest: wrL } : null,
    supabase: sbV ? { version: versionIn(sbV) ?? "" } : null,
    xcode: versionIn(xcode),
    android: adbV ? (versionIn(/Version (\S+)/.exec(adbV)?.[1]) ?? versionIn(adbV)) : null,
    unknown,
  };
}

/** Cada cuánto se vuelven a mirar (las comprobaciones lanzan procesos: no en cada latido). */
const SERVICES_TTL_MS = 10 * 60_000;
let cached: { at: number; rows: ServiceRow[] } | null = null;
let inflight: Promise<ServiceRow[]> | null = null;

/** Estado de los servicios para el documento del ordenador (cacheado; `fresh` lo vuelve a mirar ya). */
export async function machineServices(fresh = false): Promise<ServiceRow[]> {
  if (!fresh && cached && Date.now() - cached.at < SERVICES_TTL_MS) return cached.rows;
  const needs = serviceNeeds();
  inflight ??= probeServices(needs)
    .then((p) => serviceRows(p, needs))
    .then((rows) => ((cached = { at: Date.now(), rows }), rows))
    .finally(() => (inflight = null));
  return inflight;
}

/** Lo último que se sabe, sin esperar (y lo vuelve a mirar en segundo plano si toca): para el latido de cada 5 s. */
export function currentServices(): ServiceRow[] | null {
  if (!cached || Date.now() - cached.at >= SERVICES_TTL_MS) void machineServices().catch((err) => console.warn(`[backcode] tools check failed: ${err instanceof Error ? err.message : String(err)}`));
  return cached?.rows ?? null;
}

/** Tras actualizar algo, que la próxima publicación lo vuelva a mirar (y sin la última versión cacheada). */
export function invalidateServices(): void {
  cached = null;
  latestCache.delete("runner");
  latestCache.delete("release");
}

/** ¿Es un servicio que el runner puede actualizar solo? (la acción de la app solo acepta estos). */
export function isUpdatableService(id: unknown): id is UpdatableService {
  return typeof id === "string" && (UPDATABLE_SERVICES as readonly string[]).includes(id);
}
