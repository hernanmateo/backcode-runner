import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ENV_KEYS } from "./config.js";
import { readCredentials, saveBitbucketCredentials } from "./credentials.js";
import { publicRepoUrl } from "./git.js";
import { t } from "./i18n.js";
import { ensureConfigDir, projectFile, projectFiles } from "./paths.js";

// Conectar un proyecto con la configuración que genera la app (Proyecto → Conectar → Copiar configuración). Lo usan la
// terminal (`backcode connect`) y el panel: los dos pegan el texto y contestan lo que haga falta (clonar el repo, el token
// de Bitbucket) volviendo a llamar a connectProject con la respuesta.

const END_MARK = "# fin";
const allowed = new Set(ENV_KEYS);

export type Pasted = { values: Map<string, string>; ignored: string[] } | { error: string };

/** Lee la configuración pegada. Solo acepta variables BACKCODE_* (nada de NODE_OPTIONS, PATH…). */
export function parseConfig(text: string): Pasted {
  const values = new Map<string, string>();
  const ignored: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(END_MARK)) break;
    // La primera línea de la app lleva el nombre del proyecto: # Backcode runner · proyecto "Nombre"
    const name = /^#.*"(.+)"\s*$/.exec(line)?.[1];
    if (name && !values.has("BACKCODE_PROJECT_NAME")) values.set("BACKCODE_PROJECT_NAME", name.replace(/["\n]/g, "").slice(0, 80));
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m || !m[1].startsWith("BACKCODE_")) return { error: t("connect.badLine", { line: line.slice(0, 60) }) };
    // La app puede ser más nueva que este runner: se ignora y se sugiere actualizar.
    if (!allowed.has(m[1])) ignored.push(m[1]);
    else values.set(m[1], m[2]);
  }
  if (!values.has("BACKCODE_PROJECT_ID")) return { error: t("connect.noProject") };
  return { values, ignored };
}

/** Respuestas a lo que pidió connectProject en una llamada anterior. */
export interface Answers {
  /** true: clonar el repo en la ruta de la configuración; false: no. */
  clone?: boolean;
  /** Credenciales de Bitbucket nuevas, o "skip" para seguir sin PR. */
  bitbucket?: { email: string; token: string } | "skip";
}

export type ConnectResult =
  | { ok: true; projectId: string; file: string; notes: string[] }
  | { need: "clone"; url: string; path: string; notes: string[] }
  /** retry: el problema es de las credenciales que se acaban de dar (no de las guardadas o de que no haya). */
  | { need: "bitbucket"; problem: string; email?: string; retry: boolean; notes: string[] }
  | { error: string; notes: string[] };

/** Otras configuraciones de este ordenador, de la más reciente a la más antigua. */
function otherConfigs(except: string): { file: string; text: string }[] {
  return projectFiles()
    .filter((p) => p.id !== except)
    .map(({ file }) => ({ file, mtime: statSync(file).mtimeMs, text: readFileSync(file, "utf8") }))
    .sort((a, b) => b.mtime - a.mtime);
}
export const valueIn = (text: string, key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(text)?.[1]?.trim() || undefined;

/** Comprueba la llave contra el servidor (runnerSignIn) antes de guardarla. */
async function keyWorks(values: Map<string, string>, key: string): Promise<boolean> {
  const project = values.get("BACKCODE_FIREBASE_PROJECT_ID");
  const region = values.get("BACKCODE_FUNCTIONS_REGION") || "us-central1";
  const url = values.get("BACKCODE_USE_EMULATORS") === "1" ? `http://127.0.0.1:5001/${project}/${region}/runnerSignIn` : `https://${region}-${project}.cloudfunctions.net/runnerSignIn`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { key } }) });
    return !!((await res.json()) as { result?: { token?: string } }).result?.token;
  } catch {
    return false;
  }
}

/** workspace/repo de Bitbucket del remoto del proyecto (o null si no es Bitbucket o no se puede leer). */
function bitbucketRepo(repo: string, remote: string): string | null {
  try {
    const url = execFileSync("git", ["-C", repo, "remote", "get-url", remote], { encoding: "utf8" }).trim();
    const m = /bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/**
 * Comprueba un API token de Bitbucket con la API (lectura): cuenta, acceso al repo y a sus PR. Devuelve el problema en
 * lenguaje llano o null si está bien. Los permisos de escritura no se pueden comprobar sin escribir.
 */
async function bitbucketProblem(email: string, token: string, repo: string | null): Promise<string | null> {
  const headers = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, Accept: "application/json" };
  const get = (path: string) => fetch(`https://api.bitbucket.org/2.0${path}`, { headers }).then((r) => r.status, () => 0);
  const user = await get("/user");
  if (user === 0) return null; // sin red: no se puede comprobar ahora; el runner avisará si falla
  if (user === 401) return t("bb.badCreds");
  if (user === 403) return t("bb.noReadUser");
  if (user >= 400) return t("bb.status", { status: user });
  if (!repo) return null;
  const r = await get(`/repositories/${repo}`);
  if (r === 403 || r === 404) return t("bb.noRepo", { repo });
  const prs = await get(`/repositories/${repo}/pullrequests?pagelen=1`);
  if (prs === 403) return t("bb.noReadPr");
  return null;
}

/** git clone con tus credenciales. Sin terminal (panel), git no puede preguntar: falla en vez de quedarse esperando. */
function gitClone(url: string, path: string, interactive: boolean): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true });
  const env = interactive ? process.env : { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  return new Promise((resolve) => {
    const child = execFile("git", ["clone", url, path], { env, timeout: 15 * 60_000 }, (err) => resolve(!err));
    if (interactive) {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }
  });
}

/**
 * Valida y guarda la configuración pegada como ~/.backcode/config/<proyecto>.env (permisos 600). Si necesita algo más
 * (clonar el repo, un token de Bitbucket válido), lo devuelve en `need` y hay que volver a llamarla con la respuesta.
 */
export async function connectProject(pasted: Map<string, string>, answers: Answers = {}, opts: { interactive?: boolean } = {}): Promise<ConnectResult> {
  const values = new Map(pasted);
  const notes: string[] = [];
  const projectId = values.get("BACKCODE_PROJECT_ID") ?? "";
  const repoPath = (values.get("BACKCODE_REPO_PATH") ?? "").replace(/^~(?=\/)/, homedir());
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) return { error: t("connect.noProject"), notes };
  ensureConfigDir();
  const others = otherConfigs(projectId);

  /** Misma instalación de Backcode (mismo proyecto de Firebase y mismo modo emulador/producción). */
  const sameBackend = (text: string) =>
    valueIn(text, "BACKCODE_FIREBASE_PROJECT_ID") === values.get("BACKCODE_FIREBASE_PROJECT_ID") &&
    (valueIn(text, "BACKCODE_USE_EMULATORS") ?? "0") === (values.get("BACKCODE_USE_EMULATORS") ?? "0");

  // La llave es por usuario: se usa la pegada o, si no hay, la de otro proyecto de este ordenador. Se valida contra el
  // servidor (generar una nueva revoca la anterior) y la válida se copia a tus otras configuraciones de la misma instalación.
  const pastedKey = values.get("BACKCODE_RUNNER_KEY");
  const candidates = [...new Set([pastedKey, ...others.filter((c) => sameBackend(c.text)).map((c) => valueIn(c.text, "BACKCODE_RUNNER_KEY"))].filter((k): k is string => !!k))];
  let valid: string | undefined;
  for (const key of candidates) {
    if (await keyWorks(values, key)) {
      valid = key;
      break;
    }
  }
  if (!valid) return { error: t(pastedKey ? "connect.keyInvalid" : "connect.noKey"), notes };
  if (valid !== pastedKey) notes.push(t("connect.keyReused"));
  values.set("BACKCODE_RUNNER_KEY", valid);
  for (const c of others.filter((x) => sameBackend(x.text) && valueIn(x.text, "BACKCODE_RUNNER_KEY") !== valid)) {
    writeFileSync(c.file, c.text.replace(/^BACKCODE_RUNNER_KEY=.*$/m, `BACKCODE_RUNNER_KEY=${valid}`), { mode: 0o600 });
    notes.push(t("connect.keyCopied", { file: c.file }));
  }

  // ¿Aún no tienes el repo? Si la ruta no existe y la app sabe de dónde viene, se ofrece clonarlo ahí (con tus credenciales
  // de git: https o ssh, como lo tengas configurado). Solo URLs de GitHub o Bitbucket sin credenciales.
  if (!existsSync(join(repoPath, ".git"))) {
    const url = publicRepoUrl(values.get("BACKCODE_REPO_URL") ?? "");
    if (url && !existsSync(repoPath)) {
      if (answers.clone === undefined) return { need: "clone", url, path: repoPath, notes };
      if (answers.clone) {
        if (!(await gitClone(url, repoPath, !!opts.interactive))) return { error: t("connect.cloneFailed", { url }), notes };
        notes.push(t("connect.cloned", { path: repoPath }));
      }
    }
  }
  values.delete("BACKCODE_REPO_URL");

  // Bitbucket: el API token no pasa por la app; se reutiliza el de este ordenador o se pide aquí, y siempre se valida
  // contra la API de Bitbucket antes de guardarlo (así un error de copia o un permiso que falta se ve ahora, no en el
  // primer PR). Si cambia, se actualiza en todos tus proyectos de Bitbucket.
  if (values.get("BACKCODE_PULL_REQUEST") === "bitbucket" && answers.bitbucket !== "skip") {
    const fromOthers = (key: string) => others.map((c) => valueIn(c.text, key)).find(Boolean);
    const repo = bitbucketRepo(repoPath, values.get("BACKCODE_REMOTE") || "origin");
    const given = answers.bitbucket;
    const account = readCredentials().bitbucket;
    const email = given?.email || values.get("BACKCODE_BITBUCKET_EMAIL") || account?.email || fromOthers("BACKCODE_BITBUCKET_EMAIL");
    const token = given?.token || values.get("BACKCODE_BITBUCKET_TOKEN") || account?.token || fromOthers("BACKCODE_BITBUCKET_TOKEN");
    const problem = email && token ? await bitbucketProblem(email, token, repo) : given ? t("bb.missing") : t("bb.noToken");
    if (problem) return { need: "bitbucket", problem, email, retry: !!given, notes };
    notes.push(t(given ? "bb.ok" : "bb.reused"));
    values.set("BACKCODE_BITBUCKET_EMAIL", email!);
    values.set("BACKCODE_BITBUCKET_TOKEN", token!);
    // Y queda como el token de tu cuenta en este ordenador: lo usan los proyectos que crees desde la app.
    if (account?.email !== email || account?.token !== token) saveBitbucketCredentials(email!, token!);
    // El mismo token sirve para todos tus proyectos de Bitbucket de este ordenador.
    for (const c of others.filter((x) => valueIn(x.text, "BACKCODE_PULL_REQUEST") === "bitbucket" && valueIn(x.text, "BACKCODE_BITBUCKET_TOKEN") !== token)) {
      let text = c.text;
      for (const [k, v] of [["BACKCODE_BITBUCKET_EMAIL", email!], ["BACKCODE_BITBUCKET_TOKEN", token!]] as const) {
        text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
      }
      writeFileSync(c.file, text, { mode: 0o600 });
      notes.push(t("bb.copied", { file: c.file }));
    }
  } else if (values.get("BACKCODE_PULL_REQUEST") === "bitbucket") {
    values.delete("BACKCODE_BITBUCKET_TOKEN");
  }
  if (!existsSync(join(repoPath, ".git"))) return { error: t("connect.notRepo", { path: repoPath }), notes };

  const file = projectFile(projectId);
  writeFileSync(file, [...values].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600); // por si ya existía con otros permisos
  return { ok: true, projectId, file, notes };
}

/** Estado del token de Bitbucket de tu cuenta en este ordenador (para el panel; nunca devuelve el token). */
export async function bitbucketAccountState(): Promise<{ email: string; problem: string | null } | null> {
  const account = readCredentials().bitbucket;
  return account ? { email: account.email, problem: await bitbucketProblem(account.email, account.token, null) } : null;
}

/**
 * Comprueba y guarda el token de Bitbucket de tu cuenta (panel → Cuentas). También lo cambia en los proyectos que
 * llevaban uno propio en su .env, y devuelve sus ids para reiniciarlos cuando queden libres.
 */
export async function saveAccountBitbucket(email: string, token: string): Promise<{ error: string } | { ok: true; updated: string[] }> {
  if (!email || !token) return { error: t("bb.missing") };
  const problem = await bitbucketProblem(email, token, null);
  if (problem) return { error: problem };
  saveBitbucketCredentials(email, token);
  const updated: string[] = [];
  for (const { id, file } of projectFiles()) {
    const text = readFileSync(file, "utf8");
    if (!valueIn(text, "BACKCODE_BITBUCKET_TOKEN") || valueIn(text, "BACKCODE_BITBUCKET_TOKEN") === token) continue;
    writeFileSync(file, text.replace(/^BACKCODE_BITBUCKET_EMAIL=.*$/m, `BACKCODE_BITBUCKET_EMAIL=${email}`).replace(/^BACKCODE_BITBUCKET_TOKEN=.*$/m, `BACKCODE_BITBUCKET_TOKEN=${token}`), { mode: 0o600 });
    updated.push(id);
  }
  return { ok: true, updated };
}
