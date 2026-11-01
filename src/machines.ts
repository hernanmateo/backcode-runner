import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "./assets.js";
import { readCredentials } from "./credentials.js";
import { ghPath } from "./github.js";
import { t } from "./i18n.js";
import { validProjectsDir } from "./machine.js";
import { claudeLoggedIn, claudeVersion, installedClaude } from "./preflight.js";
import { HOME_DIR, projectFiles } from "./paths.js";
import { connectProject, valueIn } from "./setup.js";

// Estado de este ordenador para la app (users/{uid}/machines/{machineId}), independiente de los proyectos: qué hay
// instalado y con sesión (Claude Code, git, gh, token de Bitbucket) y qué proyectos tiene conectados. Solo booleanos y
// metadatos: nunca tokens. Y las peticiones «Conectar en <host>» / «Clonar en <host>» de la app
// (users/{uid}/machines/{machineId}/requests/{id}): las atiende el runner con la llave que ya hay en este ordenador.

const run = promisify(execFile);

/** Cada cuánto se renueva el latido (la app considera la máquina online si es de hace menos de 5 min). */
export const MACHINE_BEAT_MS = 2 * 60_000;
/** Las comprobaciones lentas (gh, claude) se repiten como mucho cada 10 min. */
const CHECKS_TTL_MS = 10 * 60_000;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Id estable de este ordenador (~/.backcode/machine-id). Se crea una vez, de forma exclusiva (varios procesos a la vez). */
export function machineId(): string {
  const file = join(HOME_DIR, "machine-id");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  const current = read();
  if (MACHINE_ID_RE.test(current)) return current;
  mkdirSync(HOME_DIR, { recursive: true });
  try {
    writeFileSync(file, randomBytes(16).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    // Otro proceso lo acaba de crear: vale el suyo.
  }
  const id = read();
  if (MACHINE_ID_RE.test(id)) return id;
  // Fichero estropeado: se rehace.
  const fresh = randomBytes(16).toString("hex");
  writeFileSync(file, fresh + "\n", { mode: 0o600 });
  return fresh;
}

export interface MachineChecks {
  claude: { installed: boolean; loggedIn: boolean | null };
  git: boolean;
  gh: { installed: boolean; loggedIn: boolean; login: string | null };
  bitbucket: boolean;
}

let cached: { at: number; checks: MachineChecks } | null = null;

/** Qué hay en este ordenador. `gh api user` solo devuelve el login: el token nunca sale de gh. */
export async function machineChecks(projectBitbucket?: { email: string; token: string }): Promise<MachineChecks> {
  if (cached && Date.now() - cached.at < CHECKS_TTL_MS) return cached.checks;
  const claudeBin = installedClaude();
  const gh = ghPath();
  const [claudeOk, loggedIn, git, login] = await Promise.all([
    claudeBin ? claudeVersion(claudeBin).then((v) => !!v, () => false) : Promise.resolve(false),
    claudeBin ? claudeLoggedIn(claudeBin).catch(() => null) : Promise.resolve(null),
    run("git", ["--version"], { timeout: 10_000 }).then(() => true, () => false),
    gh ? run(gh, ["api", "user", "--jq", ".login"], { timeout: 15_000 }).then((o) => o.stdout.trim(), () => "") : Promise.resolve(""),
  ]);
  const checks: MachineChecks = {
    claude: { installed: claudeOk, loggedIn: claudeOk ? loggedIn : false },
    git,
    gh: { installed: !!gh, loggedIn: /^[A-Za-z0-9-]{1,39}$/.test(login), login: /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null },
    bitbucket: !!(readCredentials().bitbucket ?? projectBitbucket),
  };
  cached = { at: Date.now(), checks };
  return checks;
}

/** Documento users/{uid}/machines/{machineId} (sin lastSeen, que pone el servidor). */
export async function machineStatus(projectBitbucket?: { email: string; token: string }): Promise<Record<string, unknown>> {
  return {
    host: hostname().replace(/\.local$/, "").slice(0, 100),
    version: VERSION.slice(0, 32),
    platform: process.platform.slice(0, 32),
    ...(await machineChecks(projectBitbucket)),
    projectIds: projectFiles().map((p) => p.id).filter((id) => ID_RE.test(id)).slice(0, 200),
  };
}

/** Rama válida para git (las mismas comprobaciones que las reglas). */
export function validBranch(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".lock") && !name.endsWith(".");
}

/**
 * Ruta que llega de la app (repo existente o carpeta donde clonar): absoluta, con ~ o relativa a tu $HOME, y siempre
 * dentro de él, fuera de ~/.backcode y sin carpetas ocultas (Firestore nunca decide rutas fuera de ahí).
 */
export function homePath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 300 || /[\x00-\x1f\x7f]/.test(raw)) return null;
  const path = raw.trim();
  return validProjectsDir(path.startsWith("/") || path.startsWith("~") ? path : `~/${path}`);
}

export interface LinkRequest {
  projectId: string;
  baseBranch: string;
  pullRequest: "github" | "bitbucket" | "push-only";
  /** Repo que ya está en este ordenador. */
  repoPath?: string;
  /** Clonar el repo del proyecto (project.repoUrl) en esta carpeta. */
  clonePath?: string;
}

/** Valida la petición tal como llega de Firestore. */
export function parseLinkRequest(raw: Record<string, unknown>): LinkRequest | { error: string } {
  const bad = (field: string) => ({ error: t("scaffold.bad", { field }) });
  const { projectId, baseBranch, pullRequest } = raw;
  if (typeof projectId !== "string" || !ID_RE.test(projectId)) return bad("projectId");
  if (!validBranch(baseBranch)) return bad("baseBranch");
  if (pullRequest !== "github" && pullRequest !== "bitbucket" && pullRequest !== "push-only") return bad("pullRequest");
  const job: LinkRequest = { projectId, baseBranch, pullRequest };
  if (raw.repoPath !== undefined && raw.repoPath !== null && raw.repoPath !== "") {
    const p = homePath(raw.repoPath);
    if (!p) return bad("repoPath");
    job.repoPath = p;
  }
  if (raw.clonePath !== undefined && raw.clonePath !== null && raw.clonePath !== "") {
    const p = homePath(raw.clonePath);
    if (!p) return bad("clonePath");
    job.clonePath = p;
  }
  if (job.repoPath && job.clonePath) return bad("clonePath");
  return job;
}

/** Claves del .env de este runner que se copian al del proyecto: instalación de Backcode, llave y preferencias. */
const COPIED_KEYS = ["BACKCODE_FIREBASE_API_KEY", "BACKCODE_FIREBASE_AUTH_DOMAIN", "BACKCODE_FIREBASE_PROJECT_ID", "BACKCODE_FIREBASE_STORAGE_BUCKET", "BACKCODE_FUNCTIONS_REGION", "BACKCODE_USE_EMULATORS", "BACKCODE_RUNNER_KEY", "BACKCODE_LANG", "BACKCODE_KEEP_AWAKE"];

const tilde = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);

export type LinkOutcome =
  | { status: "done"; repoPath: string; restart: boolean }
  /** El repo no está en este ordenador: la app ofrece «Clonar en <host>» con esta carpeta (si hay repoUrl). */
  | { status: "needsRepo"; clonePath: string; canClone: boolean }
  | { status: "failed"; error: string };

/**
 * Conecta un proyecto en este ordenador sin pegar nada: escribe ~/.backcode/config/{pid}.env con la llave de este runner
 * (`ownEnvFile`), el repo que encuentre (o el indicado, o lo clona de project.repoUrl) y lo que pide la app. El
 * supervisor lo arranca solo; si ya estaba conectado, `restart` pide reiniciarlo.
 */
export async function linkProject(
  ownEnvFile: string,
  job: LinkRequest,
  project: { name: string; repoUrl?: string; projectsDir: string },
  activity: (text: string) => void,
): Promise<LinkOutcome> {
  const own = readFileSync(ownEnvFile, "utf8");
  const values = new Map<string, string>();
  for (const key of COPIED_KEYS) {
    const v = valueIn(own, key);
    if (v) values.set(key, v);
  }
  const wasConnected = projectFiles().some((p) => p.id === job.projectId);
  values.set("BACKCODE_PROJECT_ID", job.projectId);
  values.set("BACKCODE_PROJECT_NAME", project.name.replaceAll(/[\r\n"]+/g, " ").slice(0, 80));
  values.set("BACKCODE_BASE_BRANCH", job.baseBranch);
  values.set("BACKCODE_PULL_REQUEST", job.pullRequest);
  // La URL del repo es siempre la del proyecto en Firestore (la valida al guardarla), nunca una de la petición.
  if (project.repoUrl) values.set("BACKCODE_REPO_URL", project.repoUrl);
  const repoName = (project.repoUrl?.split(/[/:]/).pop() ?? "").replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "") || job.projectId;
  const proposed = join(project.projectsDir, repoName.startsWith(".") ? job.projectId : repoName);

  const answers: Parameters<typeof connectProject>[1] = {};
  if (job.repoPath) {
    if (!existsSync(join(job.repoPath, ".git"))) return { status: "failed", error: t("link.notRepo", { path: tilde(job.repoPath) }) };
    answers.repoPath = job.repoPath;
  } else if (job.clonePath) {
    if (!project.repoUrl) return { status: "failed", error: t("link.noRepoUrl") };
    if (existsSync(job.clonePath)) {
      if (!statSync(job.clonePath).isDirectory()) return { status: "failed", error: t("link.notEmpty", { path: tilde(job.clonePath) }) };
      if (existsSync(join(job.clonePath, ".git"))) answers.repoPath = job.clonePath;
      else if (readdirSync(job.clonePath).length) return { status: "failed", error: t("link.notEmpty", { path: tilde(job.clonePath) }) };
      // Vacía: git clone la quiere sin crear.
      else rmdirSync(job.clonePath);
    }
    if (!answers.repoPath) {
      answers.clone = true;
      answers.clonePath = job.clonePath;
      activity(t("link.cloning", { path: tilde(job.clonePath) }));
    }
  }
  if (!answers.repoPath && !answers.clone) activity(t("link.searching"));
  else activity(t("link.connecting"));

  const r = await connectProject(values, answers, { interactive: false });
  if ("ok" in r) return { status: "done", repoPath: valueIn(readFileSync(r.file, "utf8"), "BACKCODE_REPO_PATH") ?? "", restart: wasConnected };
  if ("error" in r) return { status: "failed", error: r.error.slice(0, 1500) };
  if (r.need === "repo") return { status: "needsRepo", clonePath: tilde(proposed), canClone: !!project.repoUrl };
  if (r.need === "bitbucket") return { status: "failed", error: t("link.bitbucket", { problem: r.problem }) };
  return { status: "needsRepo", clonePath: tilde(proposed), canClone: !!project.repoUrl };
}
