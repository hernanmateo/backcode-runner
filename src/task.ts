import { explainRemoteError } from "./remote-retry.js";
import { remoteTexts } from "./i18n.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { collection, doc, getDoc, serverTimestamp, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import type { Functions } from "firebase/functions";
import { httpsCallable } from "firebase/functions";
import { copyLocalFiles } from "./actions.js";
import { followUpPrompt, parseFollowUp } from "./follow-ups.js";
import { loadConfig, type RunnerConfig } from "./config.js";
import { checkRepo, commitsAhead, createWorktree, git, gitPush, SECRET_PATTERNS } from "./git.js";
import { bitbucketHost, githubHost } from "./hosts.js";
import { lang, t } from "./i18n.js";
import { connect } from "./store.js";
import { guardFor } from "./workflow-guard.js";

// Trabajo con Claude Code fuera de Backcode, con las mismas pautas que una tarea (lo usa la skill /backcode:feature del
// plugin, o tú a mano):
//   backcode task start "<título>" [--json]         worktree y rama backcode/<handle>/<id> desde <remoto>/<base> al día,
//                                                   y la tarea en el tablero, ya «En curso» (hecha en Claude Code)
//   backcode task pr --title "<título>" [--body-file f | --body "<texto>"] [--json]
//                                                   desde ese worktree: comprueba que no hay cambios sin commit ni
//                                                   secretos, sube la rama, abre (o actualiza) el PR y la registra en
//                                                   Backcode como tarea en «PR listo», a tu nombre
//   backcode task follow-up <proyecto> <tarea> <n> [--desktop] [--json]
//                                                   una siguiente tarea que propuso Claude al abrir el PR de <tarea>
//                                                   (result.followUps[n]) y que necesita algo que el runner no tiene
//                                                   (una key, un login…): como start, y la abre en tu Claude Code
//                                                   (terminal o app de escritorio) con su encargo. Desde cualquier carpeta
//   backcode task import <url del PR> [--deployed production|preview]…
//                                                   historial: un PR ya mergeado (GitHub), como tarea ya Mergeada (y
//                                                   Desplegada en esos canales). Solo admins
// Funciona en cualquier repo conectado a Backcode en este ordenador (el runner del proyecto no tiene que estar en marcha).

const BRANCH_RE = /^backcode\/[a-z0-9-]+\/([A-Za-z0-9]{20})$/;

const flag = (args: string[], name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** La configuración del proyecto al que pertenece esta carpeta (el repo o uno de sus worktrees). */
function configFor(dir: string) {
  const guard = guardFor(dir);
  if (!guard) fail(t("task.notConnected", { dir }));
  // loadConfig elige el proyecto por --project.
  process.argv.push("--project", guard.projectId);
  return { cfg: loadConfig(), guard };
}

/** La sesión de Claude Code que ejecuta el comando (si lo ejecuta Claude): la tarea la guarda para seguirla desde la app. */
function claudeSession(): { sessionId?: string } {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  return id && /^[A-Za-z0-9-]{1,100}$/.test(id) ? { sessionId: id } : {};
}

/** Worktree y rama de una tarea nueva y, ya «En curso» en el tablero, la tarea (hecha en Claude Code). */
async function begin(cfg: RunnerConfig, db: Firestore, uid: string, fns: Functions, title: string) {
  const profile = await getDoc(doc(db, "users", uid));
  const handle = ((profile.get("handle") as string | undefined) ?? uid.slice(0, 8).toLowerCase()).replaceAll(/[^a-z0-9-]/g, "-");
  // Un id como los de Firestore: el de la tarea que se registrará al abrir el PR.
  const featureId = doc(collection(db, "projects", cfg.projectId, "features")).id;
  const branch = `backcode/${handle}/${featureId}`;
  const wt = await createWorktree({ repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir, remote: cfg.remote, baseBranch: cfg.baseBranch, featureId, branch });
  // Los .env locales (no van en git): que el worktree arranque igual que el repo.
  await copyLocalFiles(cfg.repoPath, wt.path, [".env", ".env.local"]).catch(() => undefined);
  // Ya en el tablero, «En curso»: así se ve desde que empieza (y avisa). Con un servidor antiguo, se registra al abrir el PR.
  const registered = await httpsCallable(fns, "registerLocalWork")({ projectId: cfg.projectId, featureId, title, branch, stage: "start", ...claudeSession(), lang: lang() })
    .then(() => true)
    .catch((err: Error) => {
      console.warn(`  · ${t("task.notRegistered", { error: err.message })}`);
      return false;
    });
  return { featureId, branch, path: wt.path, base: `${cfg.remote}/${cfg.baseBranch}`, registered };
}

async function start(args: string[], json: boolean): Promise<void> {
  const title = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!title) fail(t("task.noStartTitle"));
  const { cfg } = configFor(process.cwd());
  const { db, uid, fns } = await connect(cfg);
  const { featureId, branch, path, base } = await begin(cfg, db, uid, fns, title);
  if (json) console.log(JSON.stringify({ featureId, branch, path, base, title }));
  else console.log(t("task.started", { path, branch, base }));
}

const ID_RE = /^[A-Za-z0-9]{1,64}$/;

/**
 * Una siguiente tarea bloqueada (le falta una key, un login o algo externo), en el Claude Code de la persona: tarea y
 * worktree como `start`, la siguiente tarea marcada como creada (features/{fid}/followUps/{n}) y Claude Code abierto en
 * el worktree con el encargo. La key la pone la persona en su ordenador: no pasa por la app ni por Firestore.
 */
async function followUp(args: string[], json: boolean): Promise<void> {
  const [pid, fid, n] = args.filter((a) => !a.startsWith("--"));
  const index = Number(n);
  if (!pid || !fid || !ID_RE.test(pid) || !ID_RE.test(fid) || !/^[0-4]$/.test(n ?? "")) fail(t("task.followUpUsage"));
  process.argv.push("--project", pid);
  const cfg = loadConfig();
  const { db, uid, fns } = await connect(cfg);
  const parent = await getDoc(doc(db, "projects", pid, "features", fid));
  const proposed = parseFollowUp((parent.get("result") as { followUps?: unknown[] } | undefined)?.followUps?.[index]);
  if (!proposed) fail(t("task.noFollowUp", { n: String(index) }));
  // Trabajo del mismo PR (antes o después de fusionar): no es una tarea nueva con su rama; se sigue desde la tarea.
  if (proposed.stage) fail(t("task.followUpStaged", { n: String(index) }));
  const state = doc(db, "projects", pid, "features", fid, "followUps", String(index));
  const taken = await getDoc(state).catch(() => null);
  if (taken?.get("state") === "created") fail(t("task.followUpTaken", { id: String(taken.get("taskId")) }));

  const task = await begin(cfg, db, uid, fns, proposed.title);
  // Que la tarjeta de la tarea de origen la enlace (y no la ofrezca otra vez). Sin la tarea en el tablero, no se puede.
  if (task.registered) {
    await setDoc(state, { state: "created", taskId: task.featureId, by: uid, at: serverTimestamp() }).catch((err: Error) => console.warn(`  · ${t("task.followUpNotLinked", { error: err.message })}`));
  }
  const prompt = followUpPrompt(proposed, { title: String(parent.get("title") ?? ""), prUrl: (parent.get("result") as { prUrl?: string } | undefined)?.prUrl, branch: task.branch, base: task.base });
  if (json) {
    console.log(JSON.stringify({ featureId: task.featureId, branch: task.branch, path: task.path, base: task.base, title: proposed.title, prompt }));
    return;
  }
  console.log(t("task.followUpStarted", { path: task.path, branch: task.branch }));
  const desktop = args.includes("--desktop");
  const code = await new Promise<number>((resolve) => {
    const child = spawn("claude", [...(desktop ? ["--desktop"] : []), prompt], { cwd: task.path, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("exit", (c) => resolve(c ?? 0));
  });
  if (code === 127) fail(t("task.noClaude", { path: task.path }));
}

/** Secretos en lo que añade la rama respecto a la base (lo mismo que mira el runner antes de subir una tarea). */
async function secretsInBranch(dir: string, base: string): Promise<string[]> {
  const diff = await git(dir, ["diff", "-U0", "--no-color", `${base}...HEAD`]);
  const found: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+")) for (const [re, label] of SECRET_PATTERNS) if (re.test(line)) found.push(t("git.secretIn", { label: t(label), file }));
  }
  return [...new Set(found)];
}

async function pr(args: string[], json: boolean): Promise<void> {
  const dir = process.cwd();
  const { cfg } = configFor(dir);
  const branch = await git(dir, ["branch", "--show-current"]).catch(() => "");
  const featureId = BRANCH_RE.exec(branch)?.[1];
  if (!featureId) fail(t("task.notTaskBranch", { branch: branch || "HEAD" }));
  const title = flag(args, "--title")?.trim();
  if (!title) fail(t("task.noTitle"));
  const bodyFile = flag(args, "--body-file");
  if (bodyFile && !existsSync(bodyFile)) fail(t("task.noBodyFile", { file: bodyFile }));
  const body = (bodyFile ? readFileSync(bodyFile, "utf8") : (flag(args, "--body") ?? "")).trim();

  if (await git(dir, ["status", "--porcelain"])) fail(t("task.dirty"));
  await git(dir, ["fetch", "--quiet", cfg.remote, cfg.baseBranch]);
  if ((await commitsAhead(dir, cfg.remote, cfg.baseBranch)) === 0) fail(t("task.noCommits", { base: `${cfg.remote}/${cfg.baseBranch}` }));
  const secrets = await secretsInBranch(dir, `${cfg.remote}/${cfg.baseBranch}`);
  if (secrets.length) fail(`${t("task.secrets")}\n  - ${secrets.join("\n  - ")}`);

  const repo = await checkRepo(cfg.repoPath, cfg.remote, cfg.baseBranch, cfg.pullRequest, !!cfg.bitbucket);
  const host = repo.pullRequest === "github" ? githubHost(cfg.repoPath) : repo.pullRequest === "bitbucket" && cfg.bitbucket ? bitbucketHost(repo.remoteUrl, cfg.bitbucket.email, cfg.bitbucket.token) : undefined;
  if (!host) fail(t("task.noHost"));
  const footer = `\n\n---\n${t("task.footer")}`;
  // Push y PR con reintentos ante caídas del host (remote-retry.ts); si aun así falla, se dice si GitHub tiene una incidencia.
  const url = await (async () => {
    await gitPush(dir, ["--quiet", "-u", cfg.remote, `${branch}:${branch}`]);
    return host.openOrUpdatePr({ cwd: dir, branch, base: repo.baseBranch, title, body: body + footer });
  })().catch(async (e: Error) => fail(await explainRemoteError(String(e.message ?? e), remoteTexts())));

  const { db, fns } = await connect(cfg);
  await httpsCallable(fns, "registerLocalWork")({ projectId: cfg.projectId, featureId, title, summary: body.slice(0, 4000), prUrl: url, branch, ...claudeSession(), lang: lang() });
  const auto = await queueForAutoMerge(db, cfg.projectId, featureId);
  if (json) console.log(JSON.stringify({ featureId, branch, prUrl: url, ...(auto ? { autoMerge: true } : {}) }));
  else console.log(t("task.registered", { url }) + (auto ? `\n  ${t("task.autoMerge")}` : ""));
}

/**
 * Con el modo auto del proyecto, deja la tarea «waiting» (intentos a 0): el runner de este usuario la encola y la mergea
 * cuando la CI esté en verde (index.ts › myLocalPrReady). Un `task pr` nuevo sobre una que quedó para revisar la vuelve a
 * poner en marcha. Devuelve si el proyecto tiene el modo auto. Nunca falla el comando.
 */
async function queueForAutoMerge(db: Firestore, projectId: string, featureId: string): Promise<boolean> {
  try {
    const project = await getDoc(doc(db, "projects", projectId));
    if (project.get("autoMerge") !== true) return false;
    await updateDoc(doc(db, "projects", projectId, "features", featureId), { autoMerge: { state: "waiting", attempts: 0, reason: t("auto.waiting"), at: serverTimestamp() } });
    return true;
  } catch {
    return false;
  }
}

/** Historial: un PR de GitHub ya mergeado, como tarea ya Mergeada (y Desplegada en los canales que se digan). */
async function importPr(args: string[], json: boolean): Promise<void> {
  const url = args.find((a) => /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/.test(a));
  if (!url) fail(t("task.importUsage"));
  const deployed = args.flatMap((a, i) => (args[i - 1] === "--deployed" ? [a] : []));
  if (deployed.some((c) => c !== "production" && c !== "preview")) fail(t("task.importUsage"));
  const { cfg } = configFor(process.cwd());
  const pr = JSON.parse(await new Promise<string>((resolve, reject) => execFile("gh", ["pr", "view", url, "--json", "title,body,headRefName,state,mergeCommit"], { cwd: cfg.repoPath }, (err, out) => (err ? reject(err) : resolve(out))))) as { title: string; body: string; headRefName: string; state: string; mergeCommit?: { oid?: string } | null };
  if (pr.state !== "MERGED" || !pr.mergeCommit?.oid) fail(t("task.notMerged", { url }));
  const { db, fns } = await connect(cfg);
  const featureId = doc(collection(db, "projects", cfg.projectId, "features")).id;
  await httpsCallable(fns, "registerLocalWork")({ projectId: cfg.projectId, featureId, title: pr.title.slice(0, 200), summary: (pr.body ?? "").slice(0, 4000), prUrl: url, branch: pr.headRefName.slice(0, 200), merged: { sha: pr.mergeCommit.oid }, deployed, lang: lang() });
  if (json) console.log(JSON.stringify({ featureId, prUrl: url }));
  else console.log(t("task.imported", { url, title: pr.title }));
}

/** `backcode task <start|pr|follow-up|import> …` */
export async function taskMain(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  try {
    if (sub === "start") await start(rest, json);
    else if (sub === "pr") await pr(rest, json);
    else if (sub === "import") await importPr(rest, json);
    else if (sub === "follow-up") await followUp(rest, json);
    else fail(t("task.usage"));
  } catch (err) {
    fail((err as Error).message.split("\n").slice(0, 6).join("\n"));
  }
  process.exit(0);
}
