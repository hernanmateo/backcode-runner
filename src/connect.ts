import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { t } from "./i18n.js";
import { panelCall } from "./panel-client.js";
import { migrateLegacyConfigs, selfCommand } from "./paths.js";
import { checkMachine } from "./preflight.js";
import { connectProject, parseConfig, type Answers } from "./setup.js";
import { useGhForGit } from "./github.js";
import { loadSavedApiKey } from "./anthropic.js";

// Con `npm start` / `npm run connect` (sin pasar por cli.ts): git con la sesión de GitHub CLI.
useGhForGit();
loadSavedApiKey();

// `backcode connect` (o `npm run connect`): pega la configuración que genera la app (Proyecto → Conectar mi Claude Code),
// se guarda en ~/.backcode/config/<proyecto>.env con permisos 600 y arranca el runner. Leerla desde un prompt (y no
// como argumento o heredoc) evita que la runner key acabe en el historial de la terminal.

migrateLegacyConfigs();
console.log(`\n${t("connect.title")}\n`);
// Antes de pedir nada: Node y Claude Code (sin el binario del SDK no hay nada que hacer; la sesión solo se avisa).
if (!(await checkMachine({ verbose: true }))) process.exit(1);
console.log(`\n${t("connect.step1")}`);
console.log(`${t("connect.step2")}\n`);

const lines: string[] = [];
const rl = createInterface({ input: process.stdin, terminal: false });
for await (const raw of rl) {
  const line = raw.trim();
  if (line.startsWith("# fin") || (line === "" && lines.some((l) => /^[A-Z]/.test(l)))) break;
  lines.push(line);
}
rl.close();

const pasted = parseConfig(lines.join("\n"));
if ("error" in pasted) {
  console.error(`\n✗ ${pasted.error}`);
  process.exit(1);
}
for (const key of pasted.ignored) console.warn(`  · ${t("connect.unknownKey", { key })}`);

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

// Se repite hasta que está guardada: cada vuelta contesta lo que pidió la anterior (clonar, token de Bitbucket).
// Sin interacción (p. ej. `pbpaste | backcode connect --clone --no-start`, lo que usa el plugin de Claude Code):
//   --clone          si el repo no está en este ordenador, clonarlo sin preguntar (en ~/Backcode/<proyecto>)
//   --repo <ruta>    el repo está en esa carpeta
//   --no-start       guardar y no arrancar el runner en esta terminal (si hay panel o servicio, lo arrancan ellos)
const flag = (name: string) => process.argv.includes(name);
const flagValue = (name: string) => (process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const answers: Answers = { ...(flag("--clone") ? { clone: true } : {}), ...(flagValue("--repo") ? { repoPath: flagValue("--repo") } : {}) };
const tty = !!process.stdin.isTTY;
let bbAttempts = 0;
let shown = 0;
for (;;) {
  const r = await connectProject(pasted.values, answers, { interactive: true });
  for (const note of r.notes.slice(shown)) console.log(`  · ${note}`);
  shown = r.notes.length;
  if ("ok" in r) {
    console.log(`\n${t("connect.saved", { file: r.file })}`);
    await start(r.projectId, r.restart);
    break;
  }
  if ("error" in r) {
    console.error(`\n✗ ${r.error}`);
    process.exit(1);
  }
  if (r.need === "clone") {
    const answer = tty ? (await ask(`\n${t("connect.askClone", { path: r.path, url: r.url })} `)).toLowerCase() : "n";
    answers.clone = ["", "s", "si", "sí", "y", "yes"].includes(answer);
    // Ya lo tienes en otra carpeta: su ruta (hasta que sea un repo; vacío, salir sin guardar).
    while (!answers.clone && tty) {
      const path = (await ask(t("connect.askRepoPath"))).replace(/^~(?=\/|$)/, homedir());
      if (!path) process.exit(1);
      if (existsSync(join(path, ".git"))) {
        answers.repoPath = path;
        break;
      }
      console.error(`  ✗ ${t("connect.notGitRepo", { path })}`);
    }
    continue;
  }
  if (r.need === "repo") {
    // Solo lo pide el panel; en la terminal, la ruta de la configuración tiene que ser el repo.
    console.error(`\n✗ ${t("connect.notRepo", { path: r.clonePath })}`);
    process.exit(1);
  }
  // Bitbucket: hasta 3 intentos en la terminal; sin terminal o tras 3 fallos, se sigue sin abrir PR.
  if (!tty || bbAttempts >= 3) {
    console.warn(`  · ${t("bb.without", { problem: r.problem })}`);
    answers.bitbucket = "skip";
    continue;
  }
  if (bbAttempts === 0) {
    if (r.email && r.problem !== t("bb.noToken")) console.warn(`\n⚠ ${t("bb.savedBad", { problem: r.problem })}`);
    console.log(`\n${t("bb.intro")}`);
    console.log(`  ${t("bb.step1")}`);
    console.log(`  ${t("bb.step2")}`);
    console.log("     read:pullrequest:bitbucket, write:pullrequest:bitbucket");
    console.log(`     ${t("ui.bbCreateScope")}`);
    console.log(`  ${t("bb.step3")}`);
    console.log(`  ${t("bb.step4")}\n`);
  } else console.warn(`\n✗ ${t("bb.retry", { problem: r.problem })}\n`);
  bbAttempts++;
  const email = (await ask(t("bb.askEmail", { current: r.email ? ` [${r.email}]` : "" }))) || r.email || "";
  answers.bitbucket = { email, token: await askHidden(t("bb.askToken")) };
}

/** Si el panel o el servicio ya están en marcha, lo arrancan ellos; si no, se arranca aquí, en esta terminal. */
async function start(projectId: string, others: string[]): Promise<void> {
  if (await panelCall("POST", `/api/projects/${projectId}/restart`).then((r) => r.ok, () => false)) {
    // Llave nueva: los otros proyectos que la han recibido se reinician con ella.
    for (const id of others) await panelCall("POST", `/api/projects/${id}/restart`).catch(() => undefined);
    console.log(`  ${t("connect.startedByPanel")}\n`);
    process.exit(0);
  }
  if (flag("--no-start")) {
    console.log(`  ${t("connect.notStarted")}\n`);
    process.exit(0);
  }
  console.log(`  ${t("connect.next", { project: projectId })}\n`);
  const [cmd, args] = selfCommand(["run", "--project", projectId]);
  const child = spawn(cmd, args, { stdio: "inherit" });
  // Ctrl+C ya le llega al runner (mismo grupo de procesos); aquí solo se espera a que termine limpio.
  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}
