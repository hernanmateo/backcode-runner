import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Valor de una variable en las otras configuraciones de este ordenador (otros proyectos ya conectados). */
function fromOtherProjects(key: string): string | undefined {
  for (const f of readdirSync(KIT_DIR).filter((n) => /^\.env(\.[A-Za-z0-9_-]+)?$/.test(n) && n !== ".env.example")) {
    const m = new RegExp(`^${key}=(.+)$`, "m").exec(readFileSync(join(KIT_DIR, f), "utf8"));
    if (m?.[1].trim()) return m[1].trim();
  }
  return undefined;
}

/** Pregunta en la terminal; con `secret` no se ve lo que se escribe. */
async function ask(question: string, secret = false): Promise<string> {
  const q = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) (q as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => void (s.startsWith(question) && process.stdout.write(question));
  const answer = await q.question(question);
  q.close();
  if (secret) process.stdout.write("\n");
  return answer.trim();
}

const projectId = values.get("BACKCODE_PROJECT_ID") ?? "";
const repoPath = (values.get("BACKCODE_REPO_PATH") ?? "").replace(/^~(?=\/)/, homedir());
if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
  console.error("\n✗ Falta el proyecto. Copia de nuevo la configuración desde la app.");
  process.exit(1);
}
// La llave es por usuario: si ya conectaste otro proyecto en este ordenador, se reutiliza (generar una
// nueva revocaría la de los demás runners).
if (!values.get("BACKCODE_RUNNER_KEY")) {
  const key = fromOtherProjects("BACKCODE_RUNNER_KEY");
  if (!key) {
    console.error("\n✗ No hay ninguna llave en este ordenador. Genérala en la app (Conectar → Genera tu llave personal) y vuelve a copiar la configuración.");
    process.exit(1);
  }
  values.set("BACKCODE_RUNNER_KEY", key);
  console.log("  · Se reutiliza tu llave de este ordenador.");
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
    token = await ask("API token (no se muestra): ", true);
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
