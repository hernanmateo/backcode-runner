import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { t } from "./i18n.js";

// Comprobaciones de este ordenador antes de conectar o arrancar: Node y Claude Code.
// El Agent SDK no usa el `claude` del PATH: trae su propio binario en un paquete opcional por plataforma
// (@anthropic-ai/claude-agent-sdk-<os>-<arch>). Lo imprescindible es ese binario y una sesión iniciada
// (la comparte con la Claude Code instalada: se inicia una vez ejecutando `claude`).

const exec = promisify(execFile);
/** stdout de un comando; nunca lanza (ni si spawn falla de forma síncrona, p. ej. ENOEXEC). */
async function run(bin: string, args: string[], timeout: number): Promise<string> {
  try {
    return (await exec(bin, args, { timeout })).stdout;
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "");
  }
}
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** null si la versión de Node vale; si no, el mensaje. */
export function nodeProblem(): string | null {
  return Number(process.versions.node.split(".")[0]) >= 22 ? null : t("pre.nodeOld", { version: process.version });
}

/** Paquetes candidatos del binario, con la misma lógica que el SDK. */
function sdkBinaryPackages(): string[] {
  const { platform, arch } = process;
  const base = "@anthropic-ai/claude-agent-sdk";
  const names = platform === "linux" ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${platform}-${arch}`];
  return names.map((n) => `${n}/claude${platform === "win32" ? ".exe" : ""}`);
}

/** Ruta del Claude Code que trae el SDK, o null si no se instaló (p. ej. npm install --omit=optional). */
export function bundledClaude(): string | null {
  const req = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  for (const p of sdkBinaryPackages()) {
    try {
      return req.resolve(p);
    } catch {
      // siguiente candidato
    }
  }
  return null;
}

/** Versión de un ejecutable de Claude Code (`claude -v`), o null si no está o no responde. */
export async function claudeVersion(bin: string): Promise<string | null> {
  return /\d+\.\d+\.\d+/.exec(await run(bin, ["-v"], 10_000))?.[0] ?? null;
}

/** ¿Hay sesión iniciada? null si no se puede saber (versión sin `auth status`, timeout…). */
export async function claudeLoggedIn(bin: string): Promise<boolean | null> {
  const out = await run(bin, ["auth", "status", "--json"], 15_000);
  try {
    const status = JSON.parse(out) as { loggedIn?: unknown };
    return typeof status.loggedIn === "boolean" ? status.loggedIn : null;
  } catch {
    return null;
  }
}

/**
 * Comprueba Node y Claude Code y lo cuenta en la terminal. Devuelve false si falta algo imprescindible (Node antiguo o el
 * binario del SDK); la sesión o la CLI que faltan solo se avisan (el runner arrancaría igual, pero las tareas fallarían).
 */
export async function checkMachine(opts: { verbose: boolean }): Promise<boolean> {
  const node = nodeProblem();
  if (node) {
    console.error(`\n✗ ${node}`);
    return false;
  }
  const bundled = bundledClaude();
  if (!bundled) {
    console.error(`\n✗ ${t("pre.sdkMissing", { pkg: sdkBinaryPackages()[0].replace(/\/claude(\.exe)?$/, "") })}`);
    return false;
  }
  if (opts.verbose) console.log(`✓ Node ${process.versions.node}`);
  const cli = await claudeVersion("claude");
  if (cli && opts.verbose) console.log(`✓ Claude Code ${cli}`);
  const loggedIn = await claudeLoggedIn(cli ? "claude" : bundled);
  if (loggedIn === false) console.warn(YELLOW(`⚠ ${cli ? t("pre.notLoggedIn") : t("pre.noCli")}`));
  else if (!cli && loggedIn === null) console.warn(YELLOW(`⚠ ${t("pre.noCli")}`));
  else if (!cli && opts.verbose) console.log(t("pre.bundledOk", { version: (await claudeVersion(bundled)) ?? "" }));
  return true;
}
