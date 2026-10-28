import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { materializeAttachments } from "./attachments.js";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, remoteHead, removeWorktree, SECRET_PATTERNS } from "./git.js";
import { createGuardHook } from "./guard.js";
import { t } from "./i18n.js";
import type { RefineJob, Store } from "./store.js";
import { claudeExecutable } from "./preflight.js";

// Refinado de ideas con el Claude Code de quien lo pide (opción del perfil en la app). refineFeature (servidor) prepara
// el encargo con las mismas instrucciones y el mismo contexto que usa con OpenAI; aquí Claude además puede leer el código
// real, en solo lectura, antes de escribir el encargo. El servidor vuelve a validar el resultado.

/** Debe coincidir con RefinedFeature en functions/src/index.ts. */
const Refined = z.object({
  title: z.string(),
  prompt: z.string(),
  acceptanceCriteria: z.array(z.string()),
  openQuestions: z.array(z.string()),
  securityFlags: z.array(z.string()),
  suggestedModel: z.enum(["haiku", "sonnet", "opus", "fable"]),
  modelReason: z.string(),
});

// Claude Code no acepta el $schema 2020-12 que pone Zod por defecto: draft-7 y sin $schema.
const { $schema: _, ...SCHEMA } = z.toJSONSchema(Refined, { target: "draft-7" }) as Record<string, unknown>;

const TIMEOUT_MS = 150_000; // el servidor espera 3 min antes de pasar a OpenAI

const RUNNER_NOTES = `You are running inside a read-only checkout of the project's repository (current directory). Before writing, use Glob, Grep and Read to check the files, modules, patterns and test commands that matter for this request, so the prompt points to real paths. Always write repository-relative paths (e.g. src/app.ts), never absolute ones: the coding agent will work in a different checkout. Be quick: read only what you need (a handful of files), then answer. The repository map in the request is a summary; trust the files over it. Never copy secrets, credentials or keys you might see into any field. Your final answer is the structured output only.`;

export async function refineIdea(cfg: RunnerConfig, store: Store, env: Record<string, string>, id: string, job: RefineJob, signal: AbortSignal): Promise<void> {
  console.log(`[refine] ${t("rf.start", { model: cfg.refineModel })}`);
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_refine", commit);
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let lastActivity = 0;
  const activity = (text: string) => {
    if (Date.now() - lastActivity < 800) return;
    lastActivity = Date.now();
    void store.refineActivity(id, text);
  };
  try {
    activity(t("rf.exploring"));
    // Los adjuntos (capturas, PDFs…) se descargan dentro de la copia para que Claude los vea con Read.
    const files = await materializeAttachments(store, cfg.projectId, path, job.attachments ?? []);
    const attached = files.length ? `\n\nAttachments (read them with Read): ${files.map((f) => `${f.file} (${f.name})`).join(", ")}` : "";
    let structured: unknown;
    let failure = "";
    let costUsd = 0;
    let model = cfg.refineModel;
    for await (const msg of query({
      prompt: `${job.input}${attached}`,
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
        cwd: path,
        model: cfg.refineModel,
        abortController: abort,
        systemPrompt: `${job.instructions}\n\n${RUNNER_NOTES}`,
        outputFormat: { type: "json_schema", schema: SCHEMA },
        // Solo lectura: sin Bash, sin escritura y sin red. La copia solo tiene ficheros versionados (no .env locales).
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
        hooks: { PreToolUse: [{ hooks: [createGuardHook(path, () => true)] }] },
        settingSources: [],
        maxTurns: 30,
        maxBudgetUsd: 1,
        env,
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type !== "tool_use") continue;
          const input = block.input as { file_path?: string; pattern?: string };
          const rel = (p?: string) => (p ?? "").replace(`${path}/`, "").slice(0, 200);
          if (block.name === "Read") activity(t("rf.reading", { path: rel(input.file_path) }));
          else if (block.name === "Grep") activity(t("rf.searching", { pattern: String(input.pattern ?? "").slice(0, 80) }));
          else if (block.name === "Glob") activity(t("rf.listing", { pattern: String(input.pattern ?? "").slice(0, 80) }));
          else activity(t("rf.writing"));
        }
      } else if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        // El modelo que más ha trabajado (el SDK puede usar otro para tareas internas).
        const used = Object.entries(msg.modelUsage ?? {}).sort((a, b) => b[1].costUSD - a[1].costUSD)[0];
        if (used) model = used[0];
        if (msg.subtype === "success") structured = msg.structured_output;
        else failure = msg.subtype;
      }
    }
    if (abort.signal.aborted && !structured) throw new Error(t("rf.timeout"));
    // Por si acaso se le escapa alguna ruta absoluta de esta copia temporal: se deja relativa al repo.
    const parsed = Refined.safeParse(JSON.parse(JSON.stringify(structured ?? null).replaceAll(`${path}/`, "")));
    if (!parsed.success) throw new Error(failure ? `${t("rf.noResult")} (${failure})` : t("rf.noResult"));
    // Igual que el mapa del repo: si el encargo parece llevar un secreto que Claude vio en el código, se descarta.
    const leaked = SECRET_PATTERNS.filter(([re]) => re.test(JSON.stringify(parsed.data))).map(([, label]) => t(label));
    if (leaked.length) throw new Error(t("kn.leaked", { list: leaked.join(", ") }));
    await store.finishRefine(id, { result: parsed.data, model, costUsd });
    console.log(`[refine] ${t("rf.done", { cost: costUsd.toFixed(3) })}`);
  } catch (err) {
    const error = String((err as Error).message ?? err);
    console.warn(`[refine] ${t("rf.failed", { error })}`);
    await store.finishRefine(id, { error }).catch(() => undefined);
  } finally {
    clearTimeout(timer);
    await removeWorktree(cfg.repoPath, path);
  }
}
