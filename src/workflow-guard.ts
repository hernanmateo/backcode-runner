import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./paths.js";

// Pautas de Backcode fuera de Backcode: el plugin de Claude Code (plugins/backcode/hooks) llama a `backcode hook <evento>`
// en las sesiones normales de Claude Code. Si el repo está conectado a un proyecto con las pautas activadas (ajuste
// `workflow` del proyecto, lo eligen los admins en la app), recuerda que cada funcionalidad o fix va en su worktree y su PR
// y, en modo «require», pide confirmar un commit o un push directo a la rama principal.
//
// Cada runner deja en ~/.backcode/guard/<proyecto>.json lo justo para decidirlo (nombre, ruta del repo, rama base, remoto y
// modo): nunca claves ni tokens, así el hook no tiene que leer la configuración.

export type Workflow = "off" | "warn" | "require";
export interface GuardInfo {
  projectId: string;
  projectName: string;
  repoPath: string;
  baseBranch: string;
  remote: string;
  workflow: Workflow;
}

const GUARD_DIR = join(HOME_DIR, "guard");

export const asWorkflow = (v: unknown): Workflow => (v === "warn" || v === "require" ? v : "off");

/** Lo escribe el runner del proyecto al arrancar y cuando cambia el ajuste en la app. */
export function writeGuard(info: GuardInfo): void {
  mkdirSync(GUARD_DIR, { recursive: true, mode: 0o700 });
  const file = join(GUARD_DIR, `${info.projectId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, file);
}

function readGuards(): GuardInfo[] {
  let files: string[];
  try {
    files = readdirSync(GUARD_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const g = JSON.parse(readFileSync(join(GUARD_DIR, f), "utf8")) as GuardInfo;
      return typeof g.repoPath === "string" && typeof g.baseBranch === "string" ? [{ ...g, workflow: asWorkflow(g.workflow) }] : [];
    } catch {
      return [];
    }
  });
}

/** El proyecto conectado con este id (para `backcode deploys --project <id>`). */
export function guardById(projectId: string): GuardInfo | null {
  return readGuards().find((g) => g.projectId === projectId) ?? null;
}

const gitIn = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** El proyecto conectado al que pertenece esta carpeta: el repo o cualquiera de sus worktrees (mismo .git común). */
export function guardFor(dir: string): (GuardInfo & { branch: string; inWorktree: boolean }) | null {
  let common: string;
  try {
    common = real(gitIn(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    return null;
  }
  const g = readGuards().find((x) => real(join(x.repoPath, ".git")) === common);
  if (!g) return null;
  let branch = "";
  let top = "";
  try {
    branch = gitIn(dir, ["branch", "--show-current"]);
    top = real(gitIn(dir, ["rev-parse", "--show-toplevel"]));
  } catch {
    // sin rama (HEAD suelto) o fuera del árbol de trabajo
  }
  return { ...g, branch, inWorktree: !!top && top !== real(g.repoPath) };
}

/** Las pautas, para el contexto de Claude al empezar la sesión. */
function guidelines(g: GuardInfo & { branch: string; inWorktree: boolean }): string {
  const lines = [
    `This repository is connected to Backcode (project "${g.projectName}"). The team works this way:`,
    `- Every feature or fix goes in its own git worktree and branch, created from an up-to-date \`${g.remote}/${g.baseBranch}\`, and reaches \`${g.baseBranch}\` only through a pull request. The team reviews, merges and deploys it from the Backcode app.`,
    `- Don't commit or push directly to \`${g.baseBranch}\`. One topic per branch and PR; don't mix unrelated changes.`,
    "- Before opening the PR, run the project's tests, linter and type checker and fix what the change broke. Never commit secrets or .env files.",
    "- PR body: Summary, Changes, How it was tested, Risks / follow-ups. If something must be done by hand after merging (deploy rules or functions, a migration…), list it with the exact command.",
    "- Start new work with the /backcode:feature skill: it creates the worktree and branch, and opens the PR at the end.",
  ];
  if (g.inWorktree && g.branch && g.branch !== g.baseBranch) lines.push(`You are already in a worktree on branch \`${g.branch}\`: keep this work here and open (or update) its PR when it's done.`);
  else if (g.branch === g.baseBranch) lines.push(`Right now the checkout is on \`${g.baseBranch}\`: before changing files for a new feature or fix, create its worktree with /backcode:feature.`);
  if (g.workflow === "require") lines.push(`The project requires this: a direct commit or push to \`${g.baseBranch}\` asks the user for confirmation first.`);
  return lines.join("\n");
}

/**
 * ¿Este comando de shell hace commit en la rama base o la sube? Mira cada trozo (&&, ;, ||, |, saltos de línea) con
 * `git [-C dir] [-c k=v…] commit|push`: un commit cuenta si la rama actual de esa carpeta es la base; un push, si sube la
 * rama actual siendo la base, nombra la base en el refspec (main, HEAD:main, :main) o usa --all/--mirror.
 */
export function touchesBase(command: string, cwd: string, base: string, branchOf: (dir: string) => string): string | null {
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const m = /(?:^|\s)git((?:\s+(?:-C\s+\S+|-c\s+\S+|--no-pager))*)\s+(commit|push)\b(.*)$/.exec(part.trim());
    if (!m) continue;
    const dirArg = /-C\s+(\S+)/.exec(m[1])?.[1]?.replace(/^["']|["']$/g, "");
    const dir = dirArg ? (dirArg.startsWith("/") ? dirArg : join(cwd, dirArg)) : cwd;
    const current = branchOf(dir);
    const rest = m[3].split(/\s+/).filter(Boolean);
    if (m[2] === "commit") {
      if (current === base) return "commit";
      continue;
    }
    if (rest.includes("--all") || rest.includes("--mirror")) return "push";
    const refs = rest.filter((a) => !a.startsWith("-")).slice(1); // el primero es el remoto
    if (refs.length === 0 ? current === base : refs.some((r) => r.replace(/^\+/, "").split(":").pop() === base || (r === "HEAD" && current === base))) return "push";
  }
  return null;
}

/** `backcode hook <evento>`: lee el JSON del hook en stdin y responde en stdout. Si algo falla, no dice nada (nunca bloquea). */
export async function hookMain(event: string): Promise<void> {
  const input = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 3000).unref();
  });
  let payload: { cwd?: string; tool_name?: string; tool_input?: { command?: string } } = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    return;
  }
  const cwd = payload.cwd && existsSync(payload.cwd) ? payload.cwd : process.cwd();
  const g = guardFor(cwd);
  if (!g || g.workflow === "off") return;
  if (event === "session-start") {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: guidelines(g) } }));
    return;
  }
  if (event === "pre-tool-use" && g.workflow === "require" && payload.tool_name === "Bash" && payload.tool_input?.command) {
    const branchOf = (dir: string) => {
      try {
        return gitIn(dir, ["branch", "--show-current"]);
      } catch {
        return "";
      }
    };
    const what = touchesBase(payload.tool_input.command, cwd, g.baseBranch, branchOf);
    if (!what) return;
    const { t } = await import("./i18n.js");
    const reason = t(what === "commit" ? "guard.askCommit" : "guard.askPush", { project: g.projectName, base: g.baseBranch });
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }));
  }
}
