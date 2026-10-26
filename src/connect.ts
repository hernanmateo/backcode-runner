import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ENV_KEYS, KIT_DIR } from "./config.js";

// `npm run connect`: pega la configuración que genera la app (Proyecto → Conectar mi Claude Code),
// se guarda como .env.<proyecto> con permisos 600 y arranca el runner. Leerla desde un prompt (y no
// como argumento o heredoc) evita que la runner key acabe en el historial de la terminal.

const END_MARK = "# fin";
const allowed = new Set(ENV_KEYS);

console.log("\nBackcode · conectar este ordenador\n");
console.log("1. En la app: Proyecto → Conectar mi Claude Code → Copiar configuración");
console.log("2. Pega aquí (⌘V) y pulsa Enter:\n");

const rl = createInterface({ input: process.stdin, terminal: false });
const values = new Map<string, string>();
for await (const raw of rl) {
  const line = raw.trim();
  if (line.startsWith(END_MARK) || (line === "" && values.size > 0)) break;
  if (line === "" || line.startsWith("#")) continue;
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m || !m[1].startsWith("BACKCODE_")) {
    // Solo variables de Backcode: nada de NODE_OPTIONS, PATH… que cambiarían cómo se ejecuta el runner.
    console.error(`\n✗ Línea no reconocida: "${line.slice(0, 60)}". Copia de nuevo la configuración desde la app.`);
    process.exit(1);
  }
  if (!allowed.has(m[1])) {
    // La app puede ser más nueva que este runner: se ignora y se sugiere actualizar.
    console.warn(`  · ${m[1]} no la conoce esta versión del runner: se ignora (actualiza con git pull).`);
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

const projectId = values.get("BACKCODE_PROJECT_ID") ?? "";
const repoPath = (values.get("BACKCODE_REPO_PATH") ?? "").replace(/^~(?=\/)/, homedir());
if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
  console.error("\n✗ Falta el proyecto. Copia de nuevo la configuración desde la app.");
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
    console.error(
      pasted
        ? "\n✗ La llave que has pegado no es válida o ya se revocó (generar otra invalida la anterior). Genera una en la app (Conectar → Genera tu llave personal) y vuelve a copiar la configuración."
        : "\n✗ No hay ninguna llave válida en este ordenador. Genera una en la app (Conectar → Genera tu llave personal) y vuelve a copiar la configuración.",
    );
    process.exit(1);
  }
  if (valid !== pasted) console.log("  · Se reutiliza tu llave de este ordenador.");
  values.set("BACKCODE_RUNNER_KEY", valid);
  for (const c of otherConfigs().filter((x) => sameBackend(x.text) && x.file !== `.env.${projectId}` && valueIn(x.text, "BACKCODE_RUNNER_KEY") !== valid)) {
    writeFileSync(join(KIT_DIR, c.file), c.text.replace(/^BACKCODE_RUNNER_KEY=.*$/m, `BACKCODE_RUNNER_KEY=${valid}`), { mode: 0o600 });
    console.log(`  · Llave actualizada también en ${c.file} (reinicia ese runner para usarla).`);
  }
}

// Bitbucket: el API token no pasa por la app; se reutiliza o se pide aquí y se queda en este .env.
if (values.get("BACKCODE_PULL_REQUEST") === "bitbucket" && !values.get("BACKCODE_BITBUCKET_TOKEN")) {
  let email = fromOtherProjects("BACKCODE_BITBUCKET_EMAIL");
  let token = fromOtherProjects("BACKCODE_BITBUCKET_TOKEN");
  if (email && token) console.log("  · Se reutiliza tu API token de Bitbucket de este ordenador.");
  else if (process.stdin.isTTY) {
    console.log("\nBitbucket necesita un API token (se guarda solo en este ordenador):");
    console.log("  1. https://id.atlassian.com/manage-profile/security/api-tokens → «Create API token with scopes»");
    console.log("  2. App: Bitbucket. Permisos: read:user:bitbucket, read:repository:bitbucket, write:repository:bitbucket,");
    console.log("     read:pullrequest:bitbucket, write:pullrequest:bitbucket");
    console.log("  3. Usa el email de esa cuenta de Atlassian (no tu usuario de Bitbucket).\n");
    email = await ask("Email de tu cuenta Atlassian: ");
    token = await askHidden("API token (no se muestra al escribirlo ni al pegarlo): ");
  }
  if (email && token) {
    values.set("BACKCODE_BITBUCKET_EMAIL", email);
    values.set("BACKCODE_BITBUCKET_TOKEN", token);
  } else console.warn("  · Sin API token de Bitbucket: se subirá la rama sin abrir PR.");
}
if (!existsSync(join(repoPath, ".git"))) {
  console.error(`\n✗ ${repoPath} no es un repositorio git. Corrige la ruta en la app (paso "Tu repositorio") y vuelve a copiar.`);
  process.exit(1);
}

const file = `.env.${projectId}`;
const path = join(KIT_DIR, file);
writeFileSync(path, [...values].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
chmodSync(path, 0o600); // por si ya existía con otros permisos
console.log(`\n✓ Guardado en ${file} (solo legible por ti)`);
console.log(`  Las próximas veces basta con: npm start -- --env ${file}\n`);

const child = spawn(process.execPath, [join(KIT_DIR, "dist", "index.js"), "--env", file], { stdio: "inherit" });
// Ctrl+C ya le llega al runner (mismo grupo de procesos); aquí solo se espera a que termine limpio.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
