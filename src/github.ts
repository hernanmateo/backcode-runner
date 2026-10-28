import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { BIN_DIR } from "./paths.js";

// GitHub sin terminal: GitHub CLI (`gh`) se instala sin Homebrew ni administrador si hace falta (el binario oficial de
// github.com/cli/cli, con su SHA-256) y la sesión se inicia desde el panel con el código de 8 caracteres en el navegador.
// git usa esa misma sesión para clonar y hacer push, solo dentro de los procesos del runner (variables GIT_CONFIG_*): no se
// toca tu ~/.gitconfig y Claude no lo hereda (su entorno es una lista cerrada).

const exec = promisify(execFile);
const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** El `gh` disponible: en el PATH (que ya incluye ~/.backcode/bin) o en las rutas de Homebrew. */
export function ghPath(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), BIN_DIR, "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs.filter(Boolean)) if (executable(join(dir, "gh"))) return join(dir, "gh");
  return null;
}

export const brewPath = () => BREW.find(executable) ?? null;

/**
 * Que git use la sesión de gh para github.com en este proceso y sus hijos. Se añade al final de los helpers que ya tengas
 * (llavero de macOS…): si alguno ya tiene credenciales, se usan esas.
 */
export function useGhForGit(): void {
  const gh = ghPath();
  if (!gh || process.env.BACKCODE_GIT_GH === gh) return;
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  process.env[`GIT_CONFIG_KEY_${n}`] = "credential.https://github.com.helper";
  process.env[`GIT_CONFIG_VALUE_${n}`] = `!'${gh.replace(/'/g, "'\\''")}' auth git-credential`;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
  process.env.BACKCODE_GIT_GH = gh;
}

/**
 * Instala GitHub CLI: con Homebrew si lo hay; si no, el binario oficial de la última versión en ~/.backcode/bin/gh,
 * comprobado contra su fichero de checksums.
 */
export async function installGh(opts: { brew?: boolean } = {}): Promise<{ ok: boolean; output: string }> {
  const brew = opts.brew === false ? null : brewPath();
  if (brew) {
    return exec(brew, ["install", "gh"], { env: { ...process.env, NONINTERACTIVE: "1", HOMEBREW_NO_AUTO_UPDATE: "1" }, timeout: 15 * 60_000 }).then(
      () => ({ ok: true, output: "brew install gh" }),
      (err: Error & { stderr?: string }) => ({ ok: false, output: (err.stderr || err.message).slice(-2000) }),
    );
  }
  const os = process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "linux" : null;
  if (!os) return { ok: false, output: `unsupported platform: ${process.platform}` };
  try {
    const release = (await (await fetch("https://api.github.com/repos/cli/cli/releases/latest", { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) })).json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
    const version = release.tag_name.replace(/^v/, "");
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const name = os === "macOS" ? `gh_${version}_macOS_${arch}.zip` : `gh_${version}_linux_${arch}.tar.gz`;
    const url = (n: string) => release.assets.find((a) => a.name === n)?.browser_download_url;
    const assetUrl = url(name);
    const sumsUrl = url(`gh_${version}_checksums.txt`);
    if (!assetUrl || !sumsUrl) return { ok: false, output: `GitHub CLI ${version}: ${name} not found` };
    const [data, sums] = await Promise.all([
      fetch(assetUrl, { signal: AbortSignal.timeout(10 * 60_000) }).then((r) => r.arrayBuffer()),
      fetch(sumsUrl, { signal: AbortSignal.timeout(30_000) }).then((r) => r.text()),
    ]);
    const buf = Buffer.from(data);
    const expected = sums.split("\n").find((l) => l.endsWith(` ${name}`))?.split(/\s+/)[0];
    if (!expected || createHash("sha256").update(buf).digest("hex") !== expected) return { ok: false, output: "checksum mismatch" };
    const tmp = mkdtempSync(join(tmpdir(), "backcode-gh-"));
    try {
      const archive = join(tmp, name);
      writeFileSync(archive, buf);
      if (name.endsWith(".zip")) await exec("unzip", ["-q", archive, "-d", tmp]);
      else await exec("tar", ["-xzf", archive, "-C", tmp]);
      mkdirSync(BIN_DIR, { recursive: true });
      const dest = join(BIN_DIR, "gh");
      copyFileSync(join(tmp, name.replace(/\.(zip|tar\.gz)$/, ""), "bin", "gh"), dest);
      chmodSync(dest, 0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    useGhForGit();
    return { ok: true, output: `GitHub CLI ${version} → ${join(BIN_DIR, "gh")}` };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

export async function ghLoggedIn(): Promise<boolean> {
  const gh = ghPath();
  return !!gh && (await exec(gh, ["auth", "status", "--hostname", "github.com"], { timeout: 15_000 }).then(() => true, () => false));
}

let login: { child: ChildProcess; code: string; url: string; startedAt: number } | null = null;

/**
 * Inicia sesión en GitHub desde el panel: `gh auth login --web` en segundo plano. Devuelve el código de un solo uso y la
 * página donde pegarlo; gh espera a que lo autorices y guarda la sesión (en el llavero, como si lo hicieras tú).
 */
export async function startGhLogin(): Promise<{ code: string; url: string } | { error: string }> {
  const gh = ghPath();
  if (!gh) return { error: "gh not installed" };
  // Un intento a medias de hace menos de 10 minutos (el código vale ese tiempo): se reutiliza.
  if (login && login.child.exitCode === null && Date.now() - login.startedAt < 9 * 60_000) return { code: login.code, url: login.url };
  login?.child.kill();
  const child = spawn(gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  return new Promise((resolve) => {
    let out = "";
    const timer = setTimeout(() => resolve({ error: out.trim() || "timeout" }), 20_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(out)?.[1];
      if (code) {
        clearTimeout(timer);
        const url = /(https:\/\/github\.com\/login\/device)/.exec(out)?.[1] ?? "https://github.com/login/device";
        login = { child, code, url, startedAt: Date.now() };
        // Con terminal, gh espera un Enter para abrir el navegador; sin ella, no: lo abre el panel.
        child.stdin?.end("\n");
        resolve({ code, url });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => {
      clearTimeout(timer);
      if (!login || login.child !== child) resolve({ error: out.trim() || "gh exited" });
      else useGhForGit();
    });
  });
}
