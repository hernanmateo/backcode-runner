import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Sin hooks de git en ningún comando que lance el runner: un hook escrito por el agente
// se ejecutaría fuera del sandbox y con tus credenciales.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...NO_HOOKS, ...args], { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout.trim();
}

export async function createWorktree(opts: {
  repoPath: string;
  worktreesDir: string;
  remote: string;
  baseBranch: string;
  featureId: string;
  branch: string;
  /** Continuar una conversación: reutiliza el worktree (o la rama publicada) en vez de empezar de la base. */
  resume?: boolean;
}): Promise<{ path: string; branch: string; resumed: boolean }> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(opts.featureId)) throw new Error(`featureId no válido: ${opts.featureId}`);
  const branch = opts.branch;
  const path = join(opts.worktreesDir, opts.featureId);
  mkdirSync(opts.worktreesDir, { recursive: true });

  if (opts.resume) {
    // Mismo directorio que la sesión original: Claude Code guarda las sesiones por carpeta.
    const current = existsSync(path) ? await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "") : "";
    if (current === branch) return { path, branch, resumed: true };
    await git(opts.repoPath, ["fetch", opts.remote, opts.baseBranch]);
    const published = await git(opts.repoPath, ["ls-remote", "--heads", opts.remote, branch]).catch(() => "");
    if (published) {
      await git(opts.repoPath, ["fetch", opts.remote, `${branch}:refs/remotes/${opts.remote}/${branch}`]);
      if (existsSync(path)) await removeWorktree(opts.repoPath, path);
      await git(opts.repoPath, ["worktree", "prune"]);
      await git(opts.repoPath, ["worktree", "add", "-B", branch, path, `${opts.remote}/${branch}`]);
      return { path, branch, resumed: true };
    }
  }

  await git(opts.repoPath, ["fetch", opts.remote, opts.baseBranch]);
  if (existsSync(path)) await removeWorktree(opts.repoPath, path);
  await git(opts.repoPath, ["worktree", "prune"]);
  // -B reinicia la rama si existía de un intento anterior.
  await git(opts.repoPath, ["worktree", "add", "-B", branch, path, `${opts.remote}/${opts.baseBranch}`]);
  return { path, branch, resumed: false };
}

/**
 * Busca el icono del proyecto en el repo, leyendo de git en el commit dado (sin worktree ni ejecutar nada):
 * primero el `expo.icon` de cualquier app.json; si no, apple-touch-icon, icon, logo o favicon en PNG/JPG.
 */
export async function findRepoIcon(repoPath: string, commit: string): Promise<{ data: Buffer; contentType: string } | null> {
  const listing = await git(repoPath, ["ls-tree", "-r", "-l", commit]);
  const files = listing
    .split("\n")
    .map((line) => /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ size: Number(m[1]), path: m[2] }))
    .filter((f) => !/(^|\/)(node_modules|dist|build|\.git|Pods)\//.test(f.path));
  const show = async (path: string) => (await run("git", [...NO_HOOKS, "show", `${commit}:${path}`], { cwd: repoPath, encoding: "buffer", maxBuffer: 5 * 1024 * 1024 })).stdout as Buffer;
  const ok = (f?: { size: number; path: string }) => !!f && f.size > 512 && f.size < 2 * 1024 * 1024 && /\.(png|jpe?g)$/i.test(f.path);

  const candidates: { size: number; path: string }[] = [];
  for (const appJson of files.filter((f) => /(^|\/)app\.json$/.test(f.path))) {
    try {
      const icon = JSON.parse((await show(appJson.path)).toString("utf8"))?.expo?.icon;
      if (typeof icon !== "string") continue;
      const dir = appJson.path.includes("/") ? appJson.path.slice(0, appJson.path.lastIndexOf("/") + 1) : "";
      const target = files.find((f) => f.path === (dir + icon.replace(/^\.\//, "")));
      if (ok(target)) candidates.push(target!);
    } catch {
      // app.json no válido: se ignora
    }
  }
  if (!candidates.length) {
    const rank = (p: string) => ["apple-touch-icon", "app-icon", "icon", "logo", "favicon"].findIndex((n) => new RegExp(`(^|/)${n}[^/]*$`, "i").test(p));
    candidates.push(...files.filter((f) => ok(f) && rank(f.path) >= 0).sort((a, b) => rank(a.path) - rank(b.path) || b.size - a.size));
  }
  const best = candidates[0];
  if (!best) return null;
  return { data: await show(best.path), contentType: /\.png$/i.test(best.path) ? "image/png" : "image/jpeg" };
}

/** Excluye una ruta de git en el repo (info/exclude, compartido por los worktrees) sin tocar su .gitignore. */
export async function excludeFromGit(worktree: string, pattern: string): Promise<void> {
  const common = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const file = join(common, "info", "exclude");
  mkdirSync(join(common, "info"), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!current.split("\n").includes(pattern)) appendFileSync(file, `${current.endsWith("\n") || !current ? "" : "\n"}${pattern}\n`);
}

/** Los worktrees se conservan para poder continuar la conversación; se borran tras `days` sin uso. */
export async function pruneOldWorktrees(repoPath: string, worktreesDir: string, days: number): Promise<void> {
  if (!existsSync(worktreesDir)) return;
  const limit = Date.now() - days * 86_400_000;
  for (const name of readdirSync(worktreesDir)) {
    const path = join(worktreesDir, name);
    if (statSync(path).mtimeMs < limit) await removeWorktree(repoPath, path);
  }
  await git(repoPath, ["worktree", "prune"]).catch(() => undefined);
}

/** Último commit de la rama base en el remoto (hace fetch antes). */
export async function remoteHead(repoPath: string, remote: string, baseBranch: string): Promise<string> {
  await git(repoPath, ["fetch", remote, baseBranch]);
  return git(repoPath, ["rev-parse", `${remote}/${baseBranch}`]);
}

/** Worktree de solo lectura (sin rama) en un commit concreto. Solo contiene ficheros versionados. */
export async function createDetachedWorktree(repoPath: string, worktreesDir: string, name: string, commit: string): Promise<string> {
  const path = join(worktreesDir, name);
  mkdirSync(worktreesDir, { recursive: true });
  if (existsSync(path)) await removeWorktree(repoPath, path);
  await git(repoPath, ["worktree", "prune"]);
  await git(repoPath, ["worktree", "add", "--detach", path, commit]);
  return path;
}

export async function removeWorktree(repoPath: string, path: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", path]).catch(() => undefined);
}

export async function stageAll(worktree: string): Promise<string[]> {
  await git(worktree, ["add", "-A"]);
  const out = await git(worktree, ["diff", "--cached", "--name-only", "-z"]);
  return out.split("\0").filter(Boolean);
}

export async function commitsAhead(worktree: string, remote: string, baseBranch: string): Promise<number> {
  return Number(await git(worktree, ["rev-list", "--count", `${remote}/${baseBranch}..HEAD`]));
}

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "clave privada"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "token de GitHub"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "API key de Anthropic"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "token de Slack"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "API key"],
  [/"private_key"\s*:\s*"-----BEGIN/, "service account de Google"],
];

/** Busca secretos en las líneas añadidas del diff staged. */
export async function scanStagedForSecrets(worktree: string): Promise<string[]> {
  const diff = await git(worktree, ["diff", "--cached", "-U0", "--no-color"]);
  const findings: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+")) {
      for (const [re, label] of SECRET_PATTERNS) {
        if (re.test(line)) findings.push(`${label} en ${file}`);
      }
    }
  }
  return [...new Set(findings)];
}

export async function commitPushAndOpenPr(opts: {
  worktree: string;
  remote: string;
  baseBranch: string;
  branch: string;
  title: string;
  body: string;
  featureId: string;
  pushOnly: boolean;
}): Promise<string> {
  // Un reintento tras fallar el push o gh puede no tener nada nuevo que commitear.
  const staged = await git(opts.worktree, ["diff", "--cached", "--name-only"]);
  if (staged) await git(opts.worktree, [
    "commit", "--no-verify",
    "-m", opts.title,
    "-m", `Backcode-Feature: ${opts.featureId}`,
  ]);
  await git(opts.worktree, ["push", "--no-verify", "--force-with-lease", opts.remote, `${opts.branch}:${opts.branch}`]);
  if (opts.pushOnly) return `${opts.remote}/${opts.branch}`;
  // En una conversación el PR ya existe: el push de arriba lo actualiza.
  const existing = await run("gh", ["pr", "view", opts.branch, "--json", "url,state", "-q", "select(.state == \"OPEN\") | .url"], { cwd: opts.worktree })
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  if (/^https:\/\//.test(existing)) return existing;
  const { stdout } = await run(
    "gh",
    ["pr", "create", "--draft", "--base", opts.baseBranch, "--head", opts.branch, "--title", opts.title, "--body", opts.body],
    { cwd: opts.worktree },
  );
  const url = stdout.trim().split("\n").pop() ?? "";
  if (!/^https:\/\//.test(url)) throw new Error(`gh no devolvió la URL del PR: ${stdout}`);
  return url;
}
