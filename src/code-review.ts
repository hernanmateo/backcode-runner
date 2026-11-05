import { query } from "@anthropic-ai/claude-agent-sdk";
import { createGuardHook } from "./guard.js";
import { CLAUDE_SETTINGS, claudeExecutable } from "./preflight.js";

// «Code review automático» (ajuste del proyecto codeReview: off | low | medium | high). Cuando una tarea termina y abre o
// actualiza su PR, el runner revisa el diff de la rama contra la base en una sesión de Claude Code NUEVA (sin el contexto
// de la tarea, para que no se autovalide) con /code-review al nivel elegido. Los fallos graves vuelven a la sesión de la
// tarea para que los arregle, el runner sube el arreglo y revisa una vez más. Ver index.ts › reviewAndFix.

export type ReviewLevel = "low" | "medium" | "high";
export const REVIEW_LEVELS: ReviewLevel[] = ["low", "medium", "high"];

export interface ReviewFinding {
  severity: "major" | "minor";
  file?: string;
  line?: number;
  summary: string;
}

export interface ReviewSpend {
  costUsd: number;
  turns: number;
  models: Record<string, { costUsd: number; tokens: number; input: number; output: number; cache: number }>;
}

/** Estado del review de una tarea (campo `review` de la tarea, lo escribe el runner que la ejecuta). */
export interface ReviewState {
  state: "reviewing" | "approved" | "findings" | "error";
  level: ReviewLevel;
  /** Pasadas hechas (1 = solo la primera; 2 = review, arreglo y reintento). */
  passes: number;
  findings: ReviewFinding[];
  costUsd: number;
  error?: string;
}

export const MAX_FINDINGS = 30;

/** El ajuste del proyecto, o null si está desactivado (o es un valor desconocido). */
export function reviewLevel(value: unknown): ReviewLevel | null {
  return REVIEW_LEVELS.includes(value as ReviewLevel) ? (value as ReviewLevel) : null;
}

export function reviewPrompt(level: ReviewLevel, branch: string, base: string): string {
  return `/code-review ${level} ${branch}

Review only what branch \`${branch}\` changes against \`${base}\` (\`git diff ${base}...HEAD\`; it is already checked out here). Don't edit any file: this is a read-only review.
When you are done, end your reply with exactly one fenced \`\`\`json block and nothing after it, with this shape:
{"findings":[{"severity":"major"|"minor","file":"path/relative/to/repo","line":123,"summary":"one sentence"}]}
- "major": bugs, security problems, data loss, broken builds or tests, or behaviour that contradicts the change's intent.
- "minor": everything else (style, naming, small cleanups, nice-to-haves).
- No findings: {"findings":[]}.`;
}

const clean = (s: unknown, n: number) => String(s ?? "").replaceAll(/\s+/g, " ").trim().slice(0, n);

function normalize(raw: unknown, fallbackSeverity?: (f: Record<string, unknown>) => "major" | "minor"): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => {
      const severity = f.severity === "major" || f.severity === "minor" ? f.severity : (fallbackSeverity?.(f) ?? "major");
      const line = Number(f.line);
      const file = clean(f.file, 300);
      return { severity, ...(file ? { file } : {}), ...(Number.isInteger(line) && line > 0 ? { line } : {}), summary: clean(f.summary ?? f.short_summary, 500) };
    })
    .filter((f) => f.summary)
    .slice(0, MAX_FINDINGS) as ReviewFinding[];
}

/**
 * Hallazgos de la respuesta del review: el bloque JSON del final; si no lo hay, lo que la skill informó con ReportFindings
 * (sin gravedad: lo de corrección o seguridad cuenta como grave). null si no hay forma de saberlo (el review no vale).
 */
export function parseFindings(text: string, reported?: unknown): ReviewFinding[] | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (const block of blocks.reverse()) {
    try {
      const data = JSON.parse(block[1]) as { findings?: unknown };
      if (Array.isArray(data.findings)) return normalize(data.findings);
    } catch {
      // siguiente bloque
    }
  }
  if (Array.isArray(reported)) return normalize(reported, (f) => (/correct|secur|bug/i.test(String(f.category ?? "correctness")) ? "major" : "minor"));
  return null;
}

export const majorOf = (findings: ReviewFinding[]) => findings.filter((f) => f.severity === "major");

const where = (f: ReviewFinding) => (f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : "");

export function formatFindings(findings: ReviewFinding[]): string {
  return findings.map((f) => `- [${f.severity}] ${where(f)}${f.summary}`).join("\n");
}

/** Lo que recibe la sesión de la tarea para arreglar los fallos graves (y, si puede, los menores). */
export function reviewFixPrompt(findings: ReviewFinding[]): string {
  return `An automatic code review of this branch (run in a separate session, without your context) found these problems:
${formatFindings(findings)}

Fix every [major] finding; fix the [minor] ones too if it's quick and safe, otherwise leave them. If you're sure a finding is wrong, don't change the code for it and say why.
- Run the relevant tests, linter or type checker again before finishing.
- Don't call open_pull_request: the pull request already exists, and the runner commits and pushes your changes.
- When you are done, reply with two or three sentences on what you fixed.`;
}

/** Comentario del PR con el resultado del review (los hallazgos que quedan; los menores no bloquean). */
export function reviewComment(review: ReviewState, labels: { title: string; approved: string; blocking: string; minor: string }): string {
  const major = majorOf(review.findings);
  const minor = review.findings.filter((f) => f.severity === "minor");
  return [
    `### ${labels.title} (/code-review ${review.level})`,
    major.length ? labels.blocking : labels.approved,
    ...(major.length ? ["", formatFindings(major)] : []),
    ...(minor.length ? ["", labels.minor, "", formatFindings(minor)] : []),
  ].join("\n");
}

/**
 * Una pasada de review en una sesión nueva sobre el worktree de la tarea: solo lectura (sin Edit/Write y el sandbox sin
 * escritura), con /code-review al nivel pedido. Devuelve los hallazgos (o un error) y lo que ha costado.
 */
export async function runReview(o: {
  cwd: string;
  branch: string;
  base: string;
  level: ReviewLevel;
  model?: string;
  env: Record<string, string>;
  isProtected: (path: string) => boolean;
  denyRead: string[];
  allowedDomains: string[];
  maxTurns: number;
  maxBudgetUsd?: number;
  signal: AbortSignal;
}): Promise<{ findings: ReviewFinding[] | null; error?: string; spend: ReviewSpend }> {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  o.signal.addEventListener("abort", onAbort, { once: true });
  const spend: ReviewSpend = { costUsd: 0, turns: 0, models: {} };
  let text = "";
  let reported: unknown;
  let error: string | undefined;
  try {
    for await (const msg of query({
      prompt: reviewPrompt(o.level, o.branch, o.base),
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
        cwd: o.cwd,
        model: o.model,
        abortController: abort,
        env: o.env,
        settingSources: [], settings: CLAUDE_SETTINGS,
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep", "Bash", "TodoWrite", "Skill", "Agent", "Task", "ReportFindings"],
        disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
        hooks: { PreToolUse: [{ hooks: [createGuardHook(o.cwd, o.isProtected)] }] },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: o.allowedDomains, strictAllowlist: true },
          // Solo lectura: el review no toca el worktree de la tarea.
          filesystem: { denyRead: o.denyRead, allowWrite: [] },
        },
        maxTurns: o.maxTurns,
        maxBudgetUsd: o.maxBudgetUsd,
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) if (block.type === "tool_use" && block.name === "ReportFindings") reported = (block.input as { findings?: unknown }).findings;
      } else if (msg.type === "result") {
        spend.costUsd += msg.total_cost_usd;
        spend.turns += msg.num_turns;
        for (const [name, m] of Object.entries(msg.modelUsage ?? {})) {
          const cache = m.cacheReadInputTokens + m.cacheCreationInputTokens;
          spend.models[name] = { costUsd: m.costUSD, tokens: m.inputTokens + m.outputTokens + cache, input: m.inputTokens, output: m.outputTokens, cache };
        }
        if (msg.subtype === "success") text = msg.result;
        else error = `${msg.subtype}: ${msg.errors.join("; ").slice(0, 500)}`;
      }
    }
  } catch (err) {
    error = String(err).slice(0, 500);
  } finally {
    o.signal.removeEventListener("abort", onAbort);
  }
  const findings = error ? null : parseFindings(text, reported);
  return { findings, ...(error || findings ? { error } : { error: "no findings block" }), spend };
}
