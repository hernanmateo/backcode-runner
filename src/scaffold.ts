import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunnerConfig } from "./config.js";
import { readCredentials } from "./credentials.js";
import { publicRepoUrl } from "./git.js";
import { t } from "./i18n.js";
import { bitbucketUsesSsh, resolveProjectsDir } from "./machine.js";
import { ensureConfigDir, projectFile } from "./paths.js";
import { valueIn } from "./setup.js";
import type { Store } from "./store.js";

// Proyecto nuevo desde una idea (lo pide un admin en la app; el servidor deja el encargo en users/{uid}/scaffolds). Lo
// hace el runner, nunca Claude, con tus credenciales: crea la carpeta dentro de tu carpeta de proyectos, el repo con un
// README y un primer commit, el remoto en GitHub (gh) o Bitbucket (API token) y la configuración del proyecto para que
// el supervisor arranque su runner. La primera tarea (montar el proyecto) ya está aceptada y la hace ese runner.
// De Firestore solo se usan nombres con formato seguro: la ruta la decide este ordenador.

const run = promisify(execFile);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Las mismas comprobaciones que firestore.rules y PLAN.md §7.
const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Claves del .env de este runner que se copian al del proyecto nuevo: instalación de Backcode, llave y preferencias. */
const COPIED_KEYS = ["BACKCODE_FIREBASE_API_KEY", "BACKCODE_FIREBASE_AUTH_DOMAIN", "BACKCODE_FIREBASE_PROJECT_ID", "BACKCODE_FIREBASE_STORAGE_BUCKET", "BACKCODE_FUNCTIONS_REGION", "BACKCODE_USE_EMULATORS", "BACKCODE_RUNNER_KEY", "BACKCODE_LANG", "BACKCODE_KEEP_AWAKE"];

export interface ScaffoldJob {
  projectId: string;
  host: "github" | "bitbucket";
  owner: string;
  repoName: string;
  private: boolean;
  name: string;
  description?: string;
}

/** Valida el encargo tal como llega de Firestore. */
export function parseScaffold(raw: Record<string, unknown>): ScaffoldJob | { error: string } {
  const { projectId, host, owner, repoName, name, description } = raw;
  if (typeof projectId !== "string" || !ID_RE.test(projectId)) return { error: t("scaffold.bad", { field: "projectId" }) };
  if (host !== "github" && host !== "bitbucket") return { error: t("scaffold.bad", { field: "host" }) };
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) return { error: t("scaffold.bad", { field: "owner" }) };
  if (typeof repoName !== "string" || !REPO_RE.test(repoName) || repoName.includes("..")) return { error: t("scaffold.bad", { field: "repoName" }) };
  const oneLine = (s: unknown, max: number) => String(s ?? "").replaceAll(/[\r\n"]+/g, " ").trim().slice(0, max);
  return { projectId, host, owner, repoName, private: raw.private !== false, name: oneLine(name, 80) || repoName, description: typeof description === "string" ? description.slice(0, 2000) : undefined };
}

const NO_PROMPT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
const git = (cwd: string, args: string[]) => run("git", ["-C", cwd, ...args], { env: NO_PROMPT_ENV, timeout: 5 * 60_000 });
const errText = (err: unknown) => String((err as { stderr?: string }).stderr || (err as Error).message || err).trim().slice(0, 800);

/** Crea el proyecto. Devuelve la URL del repo y su carpeta, o el error en lenguaje llano. */
export async function runScaffold(cfg: RunnerConfig, store: Store, job: ScaffoldJob, activity: (text: string) => void): Promise<{ ok: boolean; result: { repoUrl?: string; repoPath?: string; error?: string } }> {
  const { dir: projectsDir } = resolveProjectsDir((await store.workspace()).projectsDir);
  const repoPath = join(projectsDir, job.repoName);
  if (existsSync(repoPath)) return { ok: false, result: { error: t("scaffold.exists", { path: repoPath }) } };
  if (existsSync(projectFile(job.projectId))) return { ok: false, result: { error: t("scaffold.alreadyConnected") } };
  const bitbucket = readCredentials().bitbucket ?? cfg.bitbucket;
  if (job.host === "bitbucket" && !bitbucket) return { ok: false, result: { error: t("scaffold.noBitbucket") } };

  // Si falla antes de crear el remoto, se borra la carpeta: así se puede volver a intentar con el mismo nombre.
  let remoteCreated = false;
  try {
    activity(t("scaffold.step.folder", { path: repoPath }));
    mkdirSync(repoPath, { recursive: true });
    await git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), `# ${job.name}\n${job.description ? `\n${job.description.trim()}\n` : ""}`);
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "--no-verify", "-m", "Initial commit"]).catch((err) => {
      throw new Error(/user\.(email|name)|identity/i.test(errText(err)) ? t("scaffold.noGitIdentity") : errText(err));
    });

    let repoUrl: string;
    if (job.host === "github") {
      activity(t("scaffold.step.github", { repo: `${job.owner}/${job.repoName}` }));
      await run("gh", ["repo", "create", `${job.owner}/${job.repoName}`, job.private ? "--private" : "--public", "--source", repoPath, "--remote", "origin", "--push"], { env: NO_PROMPT_ENV, timeout: 5 * 60_000 }).catch((err) => {
        throw new Error(t("scaffold.githubFailed", { error: errText(err) }));
      });
      remoteCreated = true;
      repoUrl = `https://github.com/${job.owner}/${job.repoName}`;
    } else {
      activity(t("scaffold.step.bitbucket", { repo: `${job.owner}/${job.repoName}` }));
      const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${job.owner}/${job.repoName}`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${bitbucket!.email}:${bitbucket!.token}`).toString("base64")}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ scm: "git", is_private: job.private, ...(job.description ? { description: job.description.slice(0, 255) } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(res.status === 403 || res.status === 401 ? t("scaffold.bitbucketScope") : t("scaffold.bitbucketFailed", { status: res.status, body }));
      }
      remoteCreated = true;
      const remote = (await bitbucketUsesSsh()) ? `git@bitbucket.org:${job.owner}/${job.repoName}.git` : `https://bitbucket.org/${job.owner}/${job.repoName}.git`;
      await git(repoPath, ["remote", "add", "origin", remote]);
      activity(t("scaffold.step.push"));
      await git(repoPath, ["push", "-u", "origin", "main"]).catch((err) => {
        throw new Error(t("scaffold.pushFailed", { path: repoPath, error: errText(err) }));
      });
      repoUrl = `https://bitbucket.org/${job.owner}/${job.repoName}`;
    }

    // Configuración del proyecto nuevo, como la que guarda `backcode connect` (600). El supervisor la ve y lo arranca.
    activity(t("scaffold.step.connect"));
    const own = readFileSync(cfg.envFile, "utf8");
    const values = new Map<string, string>();
    for (const key of COPIED_KEYS) {
      const v = valueIn(own, key);
      if (v) values.set(key, v);
    }
    values.set("BACKCODE_PROJECT_ID", job.projectId);
    values.set("BACKCODE_PROJECT_NAME", job.name);
    values.set("BACKCODE_REPO_PATH", repoPath);
    values.set("BACKCODE_BASE_BRANCH", "main");
    values.set("BACKCODE_PULL_REQUEST", job.host);
    // Bitbucket: si el token es el de tu cuenta (credentials), no se copia; el runner lo lee de ahí al arrancar.
    if (job.host === "bitbucket" && !readCredentials().bitbucket && bitbucket) {
      values.set("BACKCODE_BITBUCKET_EMAIL", bitbucket.email);
      values.set("BACKCODE_BITBUCKET_TOKEN", bitbucket.token);
    }
    ensureConfigDir();
    const file = projectFile(job.projectId);
    writeFileSync(file, [`# Backcode runner · proyecto "${job.name}"`, ...[...values].map(([k, v]) => `${k}=${v}`)].join("\n") + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);

    const url = publicRepoUrl(repoUrl);
    if (url) await store.saveRepoUrlOf(job.projectId, url).catch((err) => console.warn(`[scaffold] repoUrl: ${(err as Error).message}`));
    return { ok: true, result: { repoUrl, repoPath } };
  } catch (err) {
    if (!remoteCreated) rmSync(repoPath, { recursive: true, force: true });
    return { ok: false, result: { error: (err as Error).message.slice(0, 1500) } };
  }
}
