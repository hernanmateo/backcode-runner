import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, remoteHead, removeWorktree, SECRET_PATTERNS } from "./git.js";
import { createGuardHook } from "./guard.js";
import { lang, LANGUAGE_NAME, t } from "./i18n.js";
import { CLAUDE_SETTINGS, claudeExecutable } from "./preflight.js";
import type { Store } from "./store.js";

// «Reagrupar con Claude» los pasos externos (acción consolidateExternal, pantalla «Pasos externos» de la app): los pasos
// manuales de «Después de mergear» que le quedan a quien lo pide, juntados como lo haría una persona. No solo por comando
// idéntico (eso ya lo hace la app): el mismo trabajo pedido con comandos distintos, el orden correcto, qué mirar antes, cómo
// volver atrás y si hay que esperar a una tarea en marcha que ya lo cubre.
//
// La entrada la calcula la app (qué pasos son manuales depende de los despliegues, la OTA y la build de todos los runners
// del proyecto) y llega en la acción como JSON; aquí se valida y se vuelve a comprobar contra las tareas de Firestore.
// Claude trabaja en SOLO LECTURA (como refine.ts): lee los scripts del repo para entenderlos, sin Bash, sin escribir y sin
// red. Los comandos nunca se ejecutan: se guardan para que la persona los revise (la app enseña los originales debajo).

const TEXT = 2000;
const CMD = 1000;

/** Entrada de la acción (lib/external-plan.ts de la app, planInput): tareas con sus pasos pendientes y tareas en marcha. */
export const PlanInput = z.object({
  tasks: z
    .array(
      z.object({
        fid: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
        title: z.string().max(300),
        mergedAt: z.number().optional(),
        steps: z.array(z.object({ step: z.number().int().min(0).max(49), why: z.string().max(TEXT), command: z.string().max(CMD).optional() })).min(1).max(50),
      }),
    )
    .min(1)
    .max(60),
  running: z.array(z.object({ fid: z.string().regex(/^[A-Za-z0-9]{1,64}$/), title: z.string().max(300) })).max(30).default([]),
});
export type PlanInput = z.infer<typeof PlanInput>;

/** Lo que devuelve Claude (y, ya validado, lo que se guarda y enseña la app). */
const Group = z.object({
  title: z.string(),
  commands: z.array(z.string()),
  notes: z.string().optional(),
  rollback: z.string().optional(),
  covers: z.array(z.object({ fid: z.string(), step: z.number().int() })),
  waitFor: z.string().optional(),
});
const PlanOutput = z.object({ groups: z.array(Group) });
export type PlanGroup = z.infer<typeof Group>;

// Claude Code no acepta el $schema 2020-12 que pone Zod por defecto: draft-7 y sin $schema.
const { $schema: _, ...SCHEMA } = z.toJSONSchema(PlanOutput, { target: "draft-7" }) as Record<string, unknown>;

export const MAX_GROUPS = 40;
const cut = (s: string | undefined, max: number) => (s ?? "").trim().slice(0, max);

/**
 * Lo que se guarda: cada `covers` apunta a un paso pendiente de la entrada y cada paso pendiente queda cubierto una sola
 * vez (el primer grupo que lo nombra se lo queda; los que no nombra ninguno van al final como grupo propio, con su
 * comando original). `waitFor` solo a una tarea en marcha de la entrada. Textos recortados; grupos vacíos fuera.
 */
export function validatePlan(groups: PlanGroup[], input: PlanInput): PlanGroup[] {
  const pending = new Map<string, { fid: string; step: number; why: string; command?: string; title: string }>();
  for (const task of input.tasks) for (const s of task.steps) pending.set(`${task.fid}:${s.step}`, { fid: task.fid, step: s.step, why: s.why, command: s.command, title: task.title });
  const running = new Set(input.running.map((r) => r.fid));
  const taken = new Set<string>();
  const out: PlanGroup[] = [];
  for (const g of groups) {
    const covers = g.covers.filter((c) => {
      const k = `${c.fid}:${c.step}`;
      if (!pending.has(k) || taken.has(k)) return false;
      taken.add(k);
      return true;
    });
    if (!covers.length) continue;
    const commands = g.commands.map((c) => cut(c, CMD)).filter(Boolean).slice(0, 10);
    const notes = cut(g.notes, TEXT);
    const rollback = cut(g.rollback, TEXT);
    out.push({
      title: cut(g.title, 300) || cut(pending.get(`${covers[0].fid}:${covers[0].step}`)?.why, 300),
      commands,
      ...(notes ? { notes } : {}),
      ...(rollback ? { rollback } : {}),
      covers: covers.map((c) => ({ fid: c.fid, step: c.step })),
      ...(g.waitFor && running.has(g.waitFor) ? { waitFor: g.waitFor } : {}),
    });
  }
  for (const [k, p] of pending) {
    if (taken.has(k)) continue;
    out.push({ title: cut(p.why, 300) || cut(p.command, 300), commands: p.command?.trim() ? [cut(p.command, CMD)] : [], covers: [{ fid: p.fid, step: p.step }] });
  }
  return out.slice(0, MAX_GROUPS);
}

/** Igual que el mapa del repo: si algún texto parece llevar un secreto que Claude vio en el código, no se guarda. */
export function leakedSecrets(groups: PlanGroup[]): string[] {
  const text = JSON.stringify(groups);
  return SECRET_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => t(label));
}

const INSTRUCTIONS = (language: string) => `You are helping a developer with the manual steps their merged pull requests left to do outside Backcode (the project's own deploys, OTA updates and native builds are already handled by Backcode and are NOT in this list). You get the pending steps (task, step index, why, command) and the tasks still in progress.

Group them the way a careful senior engineer would before running them, and answer with the structured output only:
- Merge steps that are the same work even if their commands differ (e.g. three tasks that each ask to regenerate and publish the same data): one group, the right command(s) once.
- Order the groups so that dependencies come first (data and migrations before the code that needs them, backend before the app, one-off external consoles last), and within a group the commands in the order they must run.
- notes: what to check before or while running it (log lines, warnings, a dry run), only if it really helps. rollback: how to undo it, only if you can tell from the repository. Keep both short.
- waitFor: the fid of a task in progress that already covers or changes this work, so the person waits for it before running the group. Only fids from the "in progress" list.
- covers: every pending step exactly once, as {fid, step}. Never invent steps.
- Use Read, Glob and Grep to check the scripts and package.json the commands refer to, so the commands are real. Be quick: read only what you need. You cannot run anything.
- Never copy secrets, credentials or keys into any field. Write titles, notes and rollback in ${language}; commands stay as shell commands.`;

/** El texto de la petición para Claude. */
export function planPrompt(input: PlanInput): string {
  const tasks = input.tasks
    .map((task) => `Task ${task.fid} «${task.title}»${task.mergedAt ? ` (merged ${new Date(task.mergedAt).toISOString().slice(0, 10)})` : ""}:\n${task.steps.map((s) => `  - step ${s.step}: ${s.why}${s.command ? `\n    command: ${s.command}` : " (no command)"}`).join("\n")}`)
    .join("\n\n");
  const running = input.running.length ? input.running.map((r) => `- ${r.fid} «${r.title}»`).join("\n") : "(none)";
  return `Pending manual steps:\n\n${tasks}\n\nTasks in progress:\n${running}`;
}

const TIMEOUT_MS = 180_000;

/** Atiende una acción consolidateExternal: Claude agrupa, el runner valida y guarda el plan de quien lo pidió. */
export async function consolidateExternal(cfg: RunnerConfig, store: Store, env: Record<string, string>, signal: AbortSignal, action: { input?: unknown; inputHash?: unknown }): Promise<{ ok: boolean; result: { error?: string; groups?: number } }> {
  let input: PlanInput;
  try {
    input = PlanInput.parse(JSON.parse(String(action.input ?? "")));
  } catch {
    return { ok: false, result: { error: t("xp.badInput") } };
  }
  const inputHash = String(action.inputHash ?? "");
  if (!/^[a-z0-9]{1,32}$/.test(inputHash)) return { ok: false, result: { error: t("xp.badInput") } };
  // Los pasos tienen que existir de verdad en las tareas del proyecto (la app los calculó, pero no se fía a ciegas).
  const real = await store.afterMergeSteps(input.tasks.map((x) => x.fid));
  input = { ...input, tasks: input.tasks.map((task) => ({ ...task, steps: task.steps.filter((s) => s.step < (real.get(task.fid) ?? 0)) })).filter((task) => task.steps.length) };
  if (!input.tasks.length) return { ok: false, result: { error: t("xp.badInput") } };

  console.log(`[external] ${t("xp.start", { n: input.tasks.reduce((n, x) => n + x.steps.length, 0) })}`);
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_external", commit);
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    let structured: unknown;
    let failure = "";
    let costUsd = 0;
    for await (const msg of query({
      prompt: planPrompt(input),
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
        cwd: path,
        model: cfg.refineModel,
        abortController: abort,
        systemPrompt: INSTRUCTIONS(LANGUAGE_NAME[lang()]),
        outputFormat: { type: "json_schema", schema: SCHEMA },
        // Solo lectura: sin Bash, sin escritura y sin red. La copia solo tiene ficheros versionados (no .env locales).
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
        hooks: { PreToolUse: [{ hooks: [createGuardHook(path, () => true)] }] },
        settingSources: [], settings: CLAUDE_SETTINGS,
        maxTurns: 30,
        maxBudgetUsd: 1,
        env,
      },
    })) {
      if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        if (msg.subtype === "success") structured = msg.structured_output;
        else failure = msg.subtype;
      }
    }
    if (abort.signal.aborted && !structured) throw new Error(t("rf.timeout"));
    const parsed = PlanOutput.safeParse(JSON.parse(JSON.stringify(structured ?? null).replaceAll(`${path}/`, "")));
    if (!parsed.success) throw new Error(failure ? `${t("xp.noResult")} (${failure})` : t("xp.noResult"));
    const groups = validatePlan(parsed.data.groups, input);
    const leaked = leakedSecrets(groups);
    if (leaked.length) throw new Error(t("kn.leaked", { list: leaked.join(", ") }));
    await store.saveExternalPlan({ groups, inputHash, costUsd });
    console.log(`[external] ${t("xp.done", { n: groups.length, cost: costUsd.toFixed(3) })}`);
    return { ok: true, result: { groups: groups.length } };
  } catch (err) {
    const error = String((err as Error).message ?? err).slice(0, 1500);
    console.warn(`[external] ${error}`);
    return { ok: false, result: { error } };
  } finally {
    clearTimeout(timer);
    await removeWorktree(cfg.repoPath, path);
  }
}
