import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { providerOfCommand } from "./deploy-detect.js";
import { type DeployTarget, findDeployTargets, git, isAncestor } from "./git.js";
import { HOME_DIR } from "./paths.js";
import { scopeOf } from "./pending.js";

// Despliegues hechos fuera de la app, para que «Pendiente de desplegar» refleje la realidad:
// - Claude Code (hook PostToolUse del plugin): si un comando de Bash despliega un destino del proyecto y acabó bien, el
//   hook deja una petición en ~/.backcode/deploylog/<proyecto>.jsonl (paso y commit, nunca el comando ni su salida) y
//   vuelve al momento. El runner del proyecto la recoge, comprueba que el commit está en la rama principal remota y lo
//   apunta en projects/{pid}/deployLog.
// - A mano: `backcode deployed <nombre> [--sha <commit>] [--project <id>]`, o «Ya lo desplegué» en la app (admins).
// - Reglas de Firebase: el runner compara las publicadas con las del repo (rules-check.ts).

export type DeployVia = "claude" | "manual" | "verified" | "app";

/** Lo que despliega un destino, para reconocer el comando directo y saber qué imprime al acabar bien. */
type Kind = "firebase" | "wrangler-deploy" | "wrangler-d1" | "supabase-db" | "supabase-functions";

/** La marca de éxito de cada herramienta (la salida de Bash no trae el código de salida). */
const MARKERS: Record<Kind, RegExp> = {
  firebase: /Deploy complete!/,
  "wrangler-deploy": /Current Version ID:|Deployed \S+ triggers/,
  "wrangler-d1": /No migrations to apply|✅/,
  "supabase-db": /Finished supabase db push|Remote database is up to date/,
  "supabase-functions": /Deployed Functions/,
};
const KINDS_OF: Record<string, Kind[]> = { firebase: ["firebase"], wrangler: ["wrangler-deploy", "wrangler-d1"], supabase: ["supabase-db", "supabase-functions"] };

const parts = (only: string) => only.split(",").map((s) => s.trim()).filter(Boolean);

/** Qué hace un destino (y, en Firebase, qué partes de `--only` despliega; null = todo). */
function kindOf(t: DeployTarget): { kind: Kind; only?: string[] | null } | null {
  const cmd = t.auto && t.auto.cmd[1] !== "run" ? t.auto.cmd.join(" ") : "";
  const provider = t.provider ?? (cmd ? providerOfCommand(cmd) : null);
  if (provider === "firebase") {
    const only = t.env?.only ?? /--only\s+(\S+)/.exec(cmd)?.[1];
    if (only) return { kind: "firebase", only: parts(only) };
    if (t.source === "detected" && t.name === "firebase-functions") return { kind: "firebase", only: ["functions"] };
    if (t.source === "detected" && t.name === "firebase-rules") {
      const p = t.auto?.paths ?? [];
      return { kind: "firebase", only: [p.some((f) => /firestore\./.test(f)) ? "firestore" : "", p.some((f) => /storage\.rules$/.test(f)) ? "storage" : ""].filter(Boolean) };
    }
    // Sin --only: todo (salvo un canal de preview de Hosting, que no deja la rama principal publicada).
    if (t.env?.channel && t.env.channel !== "live") return null;
    return t.env || /\bdeploy\b/.test(cmd) ? { kind: "firebase", only: null } : null;
  }
  if (provider === "wrangler") {
    if (t.source === "detected") return { kind: t.auto?.rank === 0 && t.name.endsWith("-db") ? "wrangler-d1" : "wrangler-deploy" };
    if (/\bd1\s+migrations\s+apply\b/.test(cmd)) return { kind: "wrangler-d1" };
    return /\bwrangler\s+deploy\b/.test(cmd) ? { kind: "wrangler-deploy" } : null;
  }
  if (provider === "supabase") {
    if (t.source === "detected") return { kind: t.name === "supabase-db" ? "supabase-db" : "supabase-functions" };
    if (/\bdb\s+push\b/.test(cmd)) return { kind: "supabase-db" };
    return /\bfunctions\s+deploy\b/.test(cmd) ? { kind: "supabase-functions" } : null;
  }
  return null;
}

/** Las partes de reglas de Firebase (firestore, storage…) que despliega un destino; null si no es solo de reglas. */
export function firebaseRulesParts(t: DeployTarget): string[] | null {
  const k = kindOf(t);
  if (k?.kind !== "firebase" || !k.only?.length) return null;
  return k.only.every((p) => /^(firestore|storage)(:(rules|indexes))?$/.test(p)) ? k.only : null;
}

/** ¿La salida dice que ese destino se desplegó bien? Sin marca conocida para su plataforma, no (ante la duda, nada). */
export function deployedOk(t: DeployTarget, output: string): boolean {
  const k = kindOf(t)?.kind;
  if (k) return MARKERS[k].test(output);
  return (KINDS_OF[t.provider ?? ""] ?? []).some((x) => MARKERS[x].test(output));
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
const flagValue = (args: string[], ...names: string[]) => {
  for (const [i, a] of args.entries()) {
    for (const n of names) {
      if (a === n) return args[i + 1] ?? "";
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
};
const has = (args: string[], ...names: string[]) => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

/**
 * Los destinos que despliega este comando de shell, ejecutado en `cwd` dentro del repo `top`: `npm|pnpm|yarn|bun run
 * <script>` (el `backcode:deploy:<nombre>` o el script detectado de esa carpeta, sin argumentos de más) o el comando
 * directo de la plataforma (`firebase deploy --only …`, `wrangler deploy`, `wrangler d1 migrations apply … --remote`,
 * `supabase db push`, `supabase functions deploy`). Sigue los `cd` del propio comando. Lo dudoso (otro entorno, otro
 * proyecto, un despliegue parcial, en seco o en local) no cuenta.
 */
export function matchDeploy(command: string, cwd: string, top: string, targets: DeployTarget[]): DeployTarget[] {
  const found = new Set<DeployTarget>();
  let dir: string | null = relative(top, cwd).split("\\").join("/");
  const rel = (from: string | null, to: string): string | null => {
    if (from === null || /^[~$]/.test(to)) return null;
    const r = isAbsolute(to) ? relative(top, to).split("\\").join("/") : posix.normalize(posix.join(from, to));
    return r === "." ? "" : r.startsWith("..") ? null : r.replace(/\/$/, "");
  };
  if (dir.startsWith("..")) return [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    let args = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) args = args.slice(1);
    if (!args.length) continue;
    if (args[0] === "cd") {
      dir = args[1] ? rel(dir, args[1]) : null;
      continue;
    }
    if (dir === null) continue;
    // <pm> [--prefix|-C|--cwd|--dir <carpeta>] run <script>: el destino de ese script en esa carpeta.
    if (/^(npm|pnpm|yarn|bun)$/.test(args[0])) {
      let rest = args.slice(1);
      let runDir: string | null = dir;
      while (rest.length && /^(--prefix|-C|--cwd|--dir)$/.test(rest[0])) {
        runDir = rel(dir, rest[1] ?? "");
        rest = rest.slice(2);
      }
      if (rest[0] === "run" || rest[0] === "run-script") rest = rest.slice(1);
      else if (args[0] === "npm" || args[0] === "bun") rest = [];
      if (rest.length !== 1 || runDir === null) continue;
      for (const t of targets) {
        const scripts = [t.source === "script" ? `backcode:deploy:${t.name}` : "", t.auto?.cmd[1] === "run" ? t.auto.cmd[2] : ""];
        if (t.dir === runDir && scripts.includes(rest[0])) found.add(t);
      }
      continue;
    }
    // Comando directo de la plataforma (también con npx/bunx/pnpm dlx/pnpm exec/yarn delante).
    while (args.length && /^(npx|bunx|pnpx)$/.test(args[0])) args = args.slice(1).filter((a, i) => i > 0 || !/^(--yes|-y)$/.test(a));
    if (/^(pnpm|yarn)$/.test(args[0]) && /^(dlx|exec)$/.test(args[1] ?? "")) args = args.slice(2);
    while (/^(--yes|-y)$/.test(args[0] ?? "")) args = args.slice(1);
    const tool = (args[0] ?? "").replace(/^firebase-tools$/, "firebase");
    const rest = args.slice(1);
    if (has(rest, "--dry-run", "--local", "--db-url", "--env", "-e")) continue;
    let kind: Kind | null = null;
    if (tool === "firebase" && rest[0] === "deploy") kind = "firebase";
    else if (tool === "wrangler" && rest[0] === "deploy") kind = "wrangler-deploy";
    else if (tool === "wrangler" && rest[0] === "d1" && rest[1] === "migrations" && rest[2] === "apply" && has(rest, "--remote")) kind = "wrangler-d1";
    else if (tool === "supabase" && rest[0] === "db" && rest[1] === "push") kind = "supabase-db";
    // `supabase functions deploy <una>` despliega solo esa: no deja el destino al día.
    else if (tool === "supabase" && rest[0] === "functions" && rest[1] === "deploy" && !rest.slice(2).some((a) => !a.startsWith("-"))) kind = "supabase-functions";
    if (!kind) continue;
    const only = kind === "firebase" ? flagValue(rest, "--only") : undefined;
    const project = kind === "firebase" ? flagValue(rest, "--project", "-P") : undefined;
    for (const t of targets) {
      const k = kindOf(t);
      if (k?.kind !== kind) continue;
      if (kind === "firebase") {
        // Firebase busca su firebase.json hacia arriba: la carpeta no importa. Sí el proyecto, si ambos lo dicen.
        if (project && t.env?.project && project !== t.env.project) continue;
        // El comando tiene que cubrir todo lo del destino: `firestore` cubre `firestore:rules`; al revés, no.
        const cmdOnly = only === undefined ? null : parts(only);
        const covered = (p: string) => cmdOnly === null || cmdOnly.includes(p) || cmdOnly.includes(p.split(":")[0]);
        if (k.only === null ? cmdOnly !== null : !k.only?.length || !k.only.every(covered)) continue;
      } else if (t.dir !== dir) continue;
      found.add(t);
    }
  }
  return [...found];
}

// --- Petición del hook al runner (fichero local, sin secretos) ---

export interface QueuedDeploy {
  step: string;
  sha: string;
  at: number;
  via: "claude";
}

const QUEUE_DIR = join(HOME_DIR, "deploylog");
const queueFile = (projectId: string) => join(QUEUE_DIR, `${projectId.replace(/[^A-Za-z0-9_-]/g, "")}.jsonl`);
const SHA_RE = /^[0-9a-f]{40}$/;
export const STEP_RE = /^(deploy:[A-Za-z0-9._/@-]{0,200}#[a-z0-9][a-z0-9-]{0,39}|ota:(production|preview))$/;
/** Lo que no llega a la rama principal en un día (desplegado desde una rama que no se mergeó) se descarta. */
const KEEP_MS = 24 * 60 * 60_000;

export const hasQueuedDeploys = (projectId: string) => existsSync(queueFile(projectId));

export function queueDeploy(projectId: string, entry: QueuedDeploy): void {
  mkdirSync(QUEUE_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(queueFile(projectId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

const gitSync = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();

export interface HookPayload {
  tool_name?: string;
  tool_input?: { command?: string };
  tool_response?: { stdout?: string; stderr?: string; interrupted?: boolean };
}

const DEPLOYISH = /\b(firebase|firebase-tools|wrangler|supabase|npm|pnpm|yarn|bun)\b/;
const ANY_MARKER = new RegExp(Object.values(MARKERS).map((r) => r.source).join("|"));

/** ¿Merece la pena mirar este comando? Sin tocar git: el hook corre tras cada comando de Bash. */
export function looksLikeDeploy(p: HookPayload): boolean {
  const r = p.tool_response;
  if (p.tool_name !== "Bash" || !p.tool_input?.command || !r || r.interrupted === true) return false;
  return DEPLOYISH.test(p.tool_input.command) && ANY_MARKER.test(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
}

/**
 * Hook PostToolUse: si el comando desplegó bien destinos del proyecto, deja la petición para el runner y devuelve sus
 * nombres. Solo con el commit tal cual (sin cambios sin commit en lo que cubre cada destino).
 */
export async function noteHookDeploy(p: HookPayload, cwd: string, projectId: string): Promise<string[]> {
  if (!looksLikeDeploy(p)) return [];
  const output = `${p.tool_response?.stdout ?? ""}\n${p.tool_response?.stderr ?? ""}`;
  const top = realpathSync(gitSync(cwd, ["rev-parse", "--show-toplevel"]));
  const targets = await findDeployTargets(top, "HEAD");
  const matched = matchDeploy(p.tool_input!.command!, realpathSync(cwd), top, targets).filter((t) => deployedOk(t, output));
  if (!matched.length) return [];
  const sha = gitSync(top, ["rev-parse", "HEAD"]);
  const dirty = gitSync(top, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const clean = matched.filter((t) => !dirty.some(scopeOf(t).match));
  for (const t of clean) queueDeploy(projectId, { step: `deploy:${t.id}`, sha, at: Date.now(), via: "claude" });
  return clean.map((t) => t.name);
}

/**
 * El runner recoge las peticiones del hook: apunta las que ya están en la rama principal remota y son de un destino que
 * existe; guarda para luego las de un commit que aún no ha llegado (menos de un día) y descarta el resto.
 */
export async function flushDeployQueue(opts: { projectId: string; repoPath: string; remote: string; baseBranch: string; targets: DeployTarget[]; log: (step: string, sha: string, via: DeployVia) => Promise<void> }): Promise<number> {
  const file = queueFile(opts.projectId);
  if (!existsSync(file)) return 0;
  const work = `${file}.${process.pid}.work`;
  renameSync(file, work);
  const lines = readFileSync(work, "utf8").split("\n").filter(Boolean);
  unlinkSync(work);
  await git(opts.repoPath, ["fetch", "--quiet", opts.remote, opts.baseBranch]).catch(() => undefined);
  const base = `${opts.remote}/${opts.baseBranch}`;
  const ids = new Set(opts.targets.map((t) => `deploy:${t.id}`));
  let logged = 0;
  for (const line of lines) {
    let e: QueuedDeploy;
    try {
      e = JSON.parse(line) as QueuedDeploy;
    } catch {
      continue;
    }
    if (e.via !== "claude" || typeof e.step !== "string" || !ids.has(e.step) || typeof e.sha !== "string" || !SHA_RE.test(e.sha) || typeof e.at !== "number") continue;
    if (await isAncestor(opts.repoPath, e.sha, base)) {
      await opts.log(e.step, e.sha, e.via).then(
        () => logged++,
        (err: Error) => console.warn(`[deploy] ${err.message}`), // solo el runner de un admin puede (las reglas lo comprueban)
      );
    } else if (Date.now() - e.at < KEEP_MS) queueDeploy(opts.projectId, e);
  }
  return logged;
}

// --- `backcode deployed` ---

const flag = (args: string[], name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);

/** `backcode deployed <nombre> [--sha <commit>] [--project <id>]`: apunta un despliegue hecho a mano. */
export async function deployedMain(args: string[]): Promise<void> {
  const { t } = await import("./i18n.js");
  const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    process.exit(1);
  };
  const name = args.find((a, i) => !a.startsWith("--") && !["--sha", "--project"].includes(args[i - 1]));
  const projectId = flag(args, "--project");
  if (!name) fail(t("deployed.usage"));
  const { guardById, guardFor } = await import("./workflow-guard.js");
  const guard = projectId ? guardById(projectId) : guardFor(process.cwd());
  if (!guard) fail(projectId ? t("ready.unknownProject", { id: projectId }) : t("task.notConnected", { dir: process.cwd() }));
  const dir = projectId ? guard!.repoPath : process.cwd();
  try {
    await git(guard!.repoPath, ["fetch", "--quiet", guard!.remote, guard!.baseBranch]);
    const base = await git(guard!.repoPath, ["rev-parse", `${guard!.remote}/${guard!.baseBranch}`]);
    const targets = await findDeployTargets(guard!.repoPath, base);
    const target = targets.find((d) => d.name === name);
    if (!target) fail(targets.length ? t("deployed.unknown", { name: name!, list: targets.map((d) => d.name).join(", ") }) : t("ready.noDeploys"));
    const wanted = flag(args, "--sha") ?? "HEAD";
    const sha = await git(dir, ["rev-parse", "--verify", "--quiet", `${wanted}^{commit}`]).catch(() => "");
    if (!sha) fail(t("deployed.badSha", { sha: wanted }));
    if (!(await isAncestor(guard!.repoPath, sha, base))) fail(t("deployed.notInBase", { sha: sha.slice(0, 7), base: `${guard!.remote}/${guard!.baseBranch}` }));
    process.argv.push("--project", guard!.projectId);
    const { loadConfig } = await import("./config.js");
    const { connect } = await import("./store.js");
    const { addDoc, collection, serverTimestamp } = await import("firebase/firestore");
    const { db, uid } = await connect(loadConfig());
    await addDoc(collection(db, "projects", guard!.projectId, "deployLog"), { step: `deploy:${target!.id}`, sha, at: serverTimestamp(), by: uid, via: "manual" });
    console.log(t("deployed.done", { name: target!.name, sha: sha.slice(0, 7) }));
  } catch (err) {
    fail((err as Error).message.split("\n").slice(0, 4).join("\n"));
  }
  process.exit(0);
}
