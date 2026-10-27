import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ENV_KEYS, KIT_DIR } from "./config.js";
import { publicRepoUrl } from "./git.js";
import { t } from "./i18n.js";
import { checkMachine } from "./preflight.js";

// `npm run connect`: pega la configuración que genera la app (Proyecto → Conectar mi Claude Code),
// se guarda como .env.<proyecto> con permisos 600 y arranca el runner. Leerla desde un prompt (y no
// como argumento o heredoc) evita que la runner key acabe en el historial de la terminal.

const END_MARK = "# fin";
const allowed = new Set(ENV_KEYS);

console.log(`\n${t("connect.title")}\n`);
// Antes de pedir nada: Node y Claude Code (sin el binario del SDK no hay nada que hacer; la sesión solo se avisa).
if (!(await checkMachine({ verbose: true }))) process.exit(1);
console.log(`\n${t("connect.step1")}`);
console.log(`${t("connect.step2")}\n`);

const rl = createInterface({ input: process.stdin, terminal: false });
const values = new Map<string, string>();
for await (const raw of rl) {
  const line = raw.trim();
  if (line.startsWith(END_MARK) || (line === "" && values.size > 0)) break;
  if (line === "" || line.startsWith("#")) continue;
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m || !m[1].startsWith("BACKCODE_")) {
    // Solo variables de Backcode: nada de NODE_OPTIONS, PATH… que cambiarían cómo se ejecuta el runner.
    console.error(`\n✗ ${t("connect.badLine", { line: line.slice(0, 60) })}`);
    process.exit(1);
  }
  if (!allowed.has(m[1])) {
    // La app puede ser más nueva que este runner: se ignora y se sugiere actualizar.
    console.warn(`  · ${t("connect.unknownKey", { key: m[1] })}`);
    continue;
  }
  values.set(m[1], m[2]);
}
rl.close();

/** Configuraciones de este ordenador (otros proyectos conectados), de la más reciente a la más antigua. */
function otherConfigs(): { file: string; text: string }[] {
  return readdirSync(KIT_DIR)
    .filter((n) => /^\.env(\.[A-Za-z0-9_-]+)?$/.test(n) && n !== ".env.example")
    .map((file) => ({ file, mtime: statSync(join(KIT_DIR, file)).mtimeMs, text: readFileSync(join(KIT_DIR, file), "utf8") }))
    .sort((a, b) => b.mtime - a.mtime);
}
const valueIn = (text: string, key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(text)?.[1]?.trim() || undefined;

/** Valor de una variable en las otras configuraciones de este ordenador. */
function fromOtherProjects(key: string): string | undefined {
  for (const c of otherConfigs()) {
    const v = valueIn(c.text, key);
    if (v) return v;
  }
  return undefined;
}

/** Misma instalación de Backcode (mismo proyecto de Firebase y mismo modo emulador/producción). */
const sameBackend = (text: string) =>
  valueIn(text, "BACKCODE_FIREBASE_PROJECT_ID") === values.get("BACKCODE_FIREBASE_PROJECT_ID") &&
  (valueIn(text, "BACKCODE_USE_EMULATORS") ?? "0") === (values.get("BACKCODE_USE_EMULATORS") ?? "0");

/** Comprueba la llave contra el servidor (runnerSignIn) antes de guardarla. */
async function keyWorks(key: string): Promise<boolean> {
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

/** Pregunta en la terminal. */
async function ask(question: string): Promise<string> {
  const q = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = await q.question(question);
  q.close();
  return answer.trim();
}

/** Pregunta sin mostrar lo que se escribe (ni al pegar). */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
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

const projectId = values.get("BACKCODE_PROJECT_ID") ?? "";
const repoPath = (values.get("BACKCODE_REPO_PATH") ?? "").replace(/^~(?=\/)/, homedir());
if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
  console.error(`\n✗ ${t("connect.noProject")}`);
  process.exit(1);
}

// La llave es por usuario: se usa la pegada o, si no hay, la de otro proyecto de este ordenador. Se valida contra el
// servidor (generar una nueva revoca la anterior) y la válida se copia a tus otras configuraciones de la misma instalación.
{
  const pasted = values.get("BACKCODE_RUNNER_KEY");
  const candidates = [...new Set([pasted, ...otherConfigs().filter((c) => sameBackend(c.text)).map((c) => valueIn(c.text, "BACKCODE_RUNNER_KEY"))].filter((k): k is string => !!k))];
  let valid: string | undefined;
  for (const key of candidates) {
    if (await keyWorks(key)) {
      valid = key;
      break;
    }
  }
  if (!valid) {
    console.error(`\n✗ ${t(pasted ? "connect.keyInvalid" : "connect.noKey")}`);
    process.exit(1);
  }
  if (valid !== pasted) console.log(`  · ${t("connect.keyReused")}`);
  values.set("BACKCODE_RUNNER_KEY", valid);
  for (const c of otherConfigs().filter((x) => sameBackend(x.text) && x.file !== `.env.${projectId}` && valueIn(x.text, "BACKCODE_RUNNER_KEY") !== valid)) {
    writeFileSync(join(KIT_DIR, c.file), c.text.replace(/^BACKCODE_RUNNER_KEY=.*$/m, `BACKCODE_RUNNER_KEY=${valid}`), { mode: 0o600 });
    console.log(`  · ${t("connect.keyCopied", { file: c.file })}`);
  }
}

// ¿Aún no tienes el repo? Si la ruta no existe y la app sabe de dónde viene, se ofrece clonarlo ahí (con tus credenciales
// de git: https o ssh, como lo tengas configurado). Solo URLs de GitHub o Bitbucket sin credenciales.
if (!existsSync(join(repoPath, ".git"))) {
  const url = publicRepoUrl(values.get("BACKCODE_REPO_URL") ?? "");
  if (url && !existsSync(repoPath) && process.stdin.isTTY) {
    const answer = (await ask(`\n${t("connect.askClone", { path: repoPath, url })} `)).trim().toLowerCase();
    if (["", "s", "si", "sí", "y", "yes"].includes(answer)) {
      mkdirSync(dirname(repoPath), { recursive: true });
      const ok = spawnSync("git", ["clone", url, repoPath], { stdio: "inherit" }).status === 0;
      if (!ok) {
        console.error(`\n✗ ${t("connect.cloneFailed", { url })}`);
        process.exit(1);
      }
      console.log(`  ${t("connect.cloned", { path: repoPath })}`);
    }
  }
}
values.delete("BACKCODE_REPO_URL");

// Bitbucket: el API token no pasa por la app; se reutiliza el de este ordenador o se pide aquí, y siempre se valida
// contra la API de Bitbucket antes de guardarlo (así un error de copia o un permiso que falta se ve ahora, no en el
// primer PR). Si cambia, se actualiza en todos tus proyectos de Bitbucket.
if (values.get("BACKCODE_PULL_REQUEST") === "bitbucket") {
  const repo = bitbucketRepo(repoPath, values.get("BACKCODE_REMOTE") || "origin");
  let email = values.get("BACKCODE_BITBUCKET_EMAIL") || fromOtherProjects("BACKCODE_BITBUCKET_EMAIL");
  let token = values.get("BACKCODE_BITBUCKET_TOKEN") || fromOtherProjects("BACKCODE_BITBUCKET_TOKEN");
  let problem = email && token ? await bitbucketProblem(email, token, repo) : t("bb.noToken");
  if (!problem) console.log(`  · ${t("bb.reused")}`);
  else if (email && token) console.warn(`\n⚠ ${t("bb.savedBad", { problem })}`);
  for (let attempt = 0; problem && attempt < 3 && process.stdin.isTTY; attempt++) {
    if (attempt === 0) {
      console.log(`\n${t("bb.intro")}`);
      console.log(`  ${t("bb.step1")}`);
      console.log(`  ${t("bb.step2")}`);
      console.log("     read:pullrequest:bitbucket, write:pullrequest:bitbucket");
      console.log(`  ${t("bb.step3")}`);
      console.log(`  ${t("bb.step4")}\n`);
    } else console.warn(`\n✗ ${t("bb.retry", { problem })}\n`);
    email = (await ask(t("bb.askEmail", { current: email ? ` [${email}]` : "" }))) || email;
    token = await askHidden(t("bb.askToken"));
    problem = email && token ? await bitbucketProblem(email, token, repo) : t("bb.missing");
    if (!problem) console.log(`  ${t("bb.ok")}`);
  }
  if (!problem && email && token) {
    values.set("BACKCODE_BITBUCKET_EMAIL", email);
    values.set("BACKCODE_BITBUCKET_TOKEN", token);
    // El mismo token sirve para todos tus proyectos de Bitbucket de este ordenador.
    for (const c of otherConfigs().filter((x) => x.file !== `.env.${projectId}` && valueIn(x.text, "BACKCODE_PULL_REQUEST") === "bitbucket" && valueIn(x.text, "BACKCODE_BITBUCKET_TOKEN") !== token)) {
      let text = c.text;
      for (const [k, v] of [["BACKCODE_BITBUCKET_EMAIL", email], ["BACKCODE_BITBUCKET_TOKEN", token]] as const) {
        text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
      }
      writeFileSync(join(KIT_DIR, c.file), text, { mode: 0o600 });
      console.log(`  · ${t("bb.copied", { file: c.file })}`);
    }
  } else {
    values.delete("BACKCODE_BITBUCKET_TOKEN");
    console.warn(`  · ${t("bb.without", { problem: problem ?? "" })}`);
  }
}
if (!existsSync(join(repoPath, ".git"))) {
  console.error(`\n✗ ${t("connect.notRepo", { path: repoPath })}`);
  process.exit(1);
}

const file = `.env.${projectId}`;
const path = join(KIT_DIR, file);
writeFileSync(path, [...values].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
chmodSync(path, 0o600); // por si ya existía con otros permisos
console.log(`\n${t("connect.saved", { file })}`);
console.log(`  ${t("connect.next", { file })}\n`);

const child = spawn(process.execPath, [join(KIT_DIR, "dist", "index.js"), "--env", file], { stdio: "inherit" });
// Ctrl+C ya le llega al runner (mismo grupo de procesos); aquí solo se espera a que termine limpio.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
