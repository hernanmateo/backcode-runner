import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { t, type Key } from "./i18n.js";

// Rutas (relativas al worktree, separador /) que Claude nunca puede modificar.
// Cubren CI/CD, configuración de agentes, hooks de git y secretos.
const DEFAULT_PROTECTED = [
  /^\.backcode-attachments(\/|$)/, // adjuntos de la tarea: se leen, no se modifican ni se suben
  /^\.git(\/|$)/,
  /^\.github\/(workflows|actions)\//,
  /^\.claude(\/|$)/,
  /^\.mcp\.json$/,
  /(^|\/)CLAUDE(\.local)?\.md$/,
  /^\.husky\//,
  /^\.gitmodules$/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.npmrc$/,
  /\.(pem|key|p12|pfx|keystore)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
];

export function protectedMatcher(extra: string[]): (rel: string) => boolean {
  const patterns = [...DEFAULT_PROTECTED, ...extra.map((p) => new RegExp(p))];
  return (rel) => patterns.some((re) => re.test(rel));
}

// Denylist de comandos. Es una capa de comodidad (mensajes claros para Claude):
// la barrera real es el sandbox del SO, el entorno sin secretos y que el push lo haga el runner.
const BLOCKED_COMMANDS: Array<[RegExp, Key]> = [
  [/\bgit\s+(push|remote|config|commit|checkout|switch|branch|rebase|reset|merge|worktree|tag|stash|filter-branch|update-ref|gc)\b/, "guard.git"],
  [/(^|[\s;&|(])gh\s/, "guard.gh"],
  [/(^|[\s;&|(])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)\b/, "guard.net"],
  [/(^|[\s;&|(])(sudo|su|doas|chmod\s+[0-7]*s|launchctl|crontab|osascript|security)\b/, "guard.system"],
  [/(^|[\s;&|(])(printenv|env)(\s|$)|\$\{?[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)/, "guard.env"],
  [/~\/\.|\$HOME\/\.|\/Users\/[^/\s]+\/\./, "guard.home"],
];

/** Resuelve la ruta real (siguiendo symlinks) aunque el fichero aún no exista. */
function realpathLoose(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

const PATH_FIELDS: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Glob: "path",
  Grep: "path",
};
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function createGuardHook(worktree: string, isProtected: (rel: string) => boolean): HookCallback {
  const root = realpathSync(worktree);

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const tool = input.tool_name;

    const field = PATH_FIELDS[tool];
    if (field) {
      const raw = toolInput[field];
      if (raw === undefined && (tool === "Glob" || tool === "Grep")) return {}; // por defecto: cwd
      if (typeof raw !== "string") return deny(t("guard.badPath"));
      const abs = realpathLoose(isAbsolute(raw) ? raw : resolve(root, raw));
      if (abs !== root && !abs.startsWith(root + sep)) {
        return deny(t("guard.outside", { root }));
      }
      const rel = relative(root, abs).split(sep).join("/");
      if (WRITE_TOOLS.has(tool) && isProtected(rel)) {
        return deny(t("guard.protected", { path: rel }));
      }
      return {};
    }

    if (tool === "Bash") {
      const command = String(toolInput.command ?? "");
      for (const [re, reason] of BLOCKED_COMMANDS) {
        if (re.test(command)) return deny(t(reason));
      }
      return {};
    }

    // Tools propios del runner y de planificación: permitidos. Cualquier otro lo filtra permissionMode.
    return {};
  };
}
