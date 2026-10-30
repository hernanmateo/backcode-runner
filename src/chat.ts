import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { materializeAttachments } from "./attachments.js";
import type { RunnerConfig } from "./config.js";
import { hasMarkers } from "./conflicts.js";
import { createDetachedWorktree, git, mergeBaseIntoBranch, removeWorktree, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook } from "./guard.js";
import { LANGUAGE_NAME, lang, t } from "./i18n.js";
import { claudeExecutable } from "./preflight.js";
import { buildChatPrompt, buildChatSystemAppend } from "./prompt.js";
import type { RunnerChat, Store } from "./store.js";

// Conversación libre con mi runner (botón junto a «Proponer una idea»): projects/{pid}/chats/{id}. No hay tarea: la
// persona pregunta o pide arreglos pequeños (p. ej. resolver un conflicto en la rama de un PR). Claude trabaja con los
// mismos límites que una tarea (guard, sandbox, entorno sin secretos, dontAsk) y el git que cambia algo solo lo hace el
// runner con dos herramientas: checkout_branch (a una rama existente del remoto, nunca la base) y commit_and_push (sin
// forzar, sin ficheros protegidos ni secretos). La copia de trabajo es siempre la misma por conversación (_chat-<id>), así
// la sesión de Claude se puede retomar; se borra al acabar cada vuelta si no quedan cambios sin subir.

/** Vueltas seguidas como mucho por cada recogida (mensajes que llegan mientras responde). */
const MAX_ROUNDS = 10;

/** Una rama a la que la conversación puede cambiar: existente en el remoto (se comprueba al hacer fetch) y no la base. */
export function chatBranchOk(branch: string, baseBranch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock") &&
    branch !== baseBranch &&
    branch !== "HEAD"
  );
}

export interface ChatDeps {
  env: Record<string, string>;
  isProtected: (rel: string) => boolean;
  denyRead: string[];
  describeTool: (name: string, input: Record<string, unknown>, root: string) => string;
  project: { name: string; context: string };
}

export async function runChat(cfg: RunnerConfig, store: Store, id: string, chat: RunnerChat, deps: ChatDeps, signal: AbortSignal): Promise<void> {
  console.log(`[chat] ${t("ch.start")}`);
  const { remote, baseBranch } = cfg;
  let branch = chat.branch && chatBranchOk(chat.branch, baseBranch) ? chat.branch : undefined;
  let sessionId = chat.sessionId;
  let costUsd = chat.costUsd ?? 0;
  let mergeFiles: string[] = [];
  const name = `_chat-${id}`;
  const path = join(cfg.worktreesDir, name);
  // Si quedó la copia de una vuelta anterior (con cambios sin subir), se sigue en ella; si no, se crea en su rama.
  if (!existsSync(path)) {
    if (branch) await git(cfg.repoPath, ["fetch", "--quiet", remote, `+${branch}:refs/remotes/${remote}/${branch}`]).catch(() => (branch = undefined));
    else await git(cfg.repoPath, ["fetch", "--quiet", remote, baseBranch]).catch(() => undefined);
    await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, name, `${remote}/${branch ?? baseBranch}`);
  }

  const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  const server = createSdkMcpServer({
    name: "backcode",
    version: "1.0.0",
    tools: [
      tool(
        "checkout_branch",
        `Switch this checkout to an existing branch of ${remote} (for example a pull request branch), discarding nothing: it fails if there are uncommitted changes. With mergeBase=true it then merges the latest ${remote}/${baseBranch} into it and lists the conflicting files (resolve them, then call commit_and_push).`,
        { branch: z.string().min(1).max(200), mergeBase: z.boolean().optional() },
        async ({ branch: next, mergeBase }) => {
          if (!chatBranchOk(next, baseBranch)) return fail(t("ch.badBranch", { branch: next, remote, base: baseBranch }));
          try {
            await git(path, ["fetch", "--quiet", remote, `+${next}:refs/remotes/${remote}/${next}`]);
            await git(path, ["checkout", "--quiet", "--detach", `refs/remotes/${remote}/${next}`]);
          } catch (err) {
            return fail(`${t("ch.badBranch", { branch: next, remote, base: baseBranch })}\n${String(err).slice(0, 500)}`);
          }
          branch = next;
          mergeFiles = [];
          await store.updateChat(id, { branch }).catch(() => undefined);
          await store.postChatMessage(id, "tool", t("ch.checkedOut", { branch }));
          if (!mergeBase) return reply(t("ch.checkedOut", { branch }));
          const sync = await mergeBaseIntoBranch(path, remote, baseBranch);
          if (sync.status === "conflicts") {
            mergeFiles = sync.files;
            return reply(t("ch.conflicts", { base: `${remote}/${baseBranch}`, branch, files: sync.files.join(", ") }));
          }
          return reply(sync.status === "merged" ? t("ch.merged", { base: `${remote}/${baseBranch}`, branch }) : t("ch.checkedOut", { branch }));
        },
      ),
      tool(
        "commit_and_push",
        `Commit everything in this checkout (including a merge in progress) with the given message and push it to the branch you switched to with checkout_branch. Never pushes to ${baseBranch} and never forces: if someone pushed to the branch meanwhile, it fails.`,
        { message: z.string().min(5).max(500) },
        async ({ message }) => {
          if (!branch) return fail(t("ch.noBranch"));
          const left = mergeFiles.filter((f) => existsSync(join(path, f)) && hasMarkers(readFileSync(join(path, f), "utf8")));
          if (left.length) return fail(t("ch.markers", { files: left.join(", ") }));
          const files = await stageAll(path);
          const blocked = files.filter(deps.isProtected);
          if (blocked.length) return fail(t("ch.protected", { files: blocked.join(", ") }));
          const secrets = await scanStagedForSecrets(path);
          if (secrets.length) return fail(t("ch.secrets", { list: secrets.join("; ") }));
          try {
            if (files.length || mergeFiles.length) await git(path, ["commit", "--quiet", "--no-verify", "-m", message]);
            const ahead = Number(await git(path, ["rev-list", "--count", `refs/remotes/${remote}/${branch}..HEAD`]));
            if (!ahead) return fail(t("ch.nothing"));
            // Sin forzar: si la rama avanzó en el remoto, el push falla y no se pisa nada.
            await git(path, ["push", "--quiet", "--no-verify", remote, `HEAD:refs/heads/${branch}`]);
            await git(path, ["fetch", "--quiet", remote, `+${branch}:refs/remotes/${remote}/${branch}`]).catch(() => undefined);
          } catch (err) {
            return fail(String(err).slice(0, 1000));
          }
          mergeFiles = [];
          const sha = (await git(path, ["rev-parse", "--short", "HEAD"]).catch(() => "")) || "HEAD";
          const text = t("ch.pushed", { branch, sha });
          await store.postChatMessage(id, "tool", text);
          return reply(text);
        },
      ),
    ],
  });

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), cfg.timeoutMinutes * 60_000);
  let lastActivity = 0;
  const activity = (text: string) => {
    if (Date.now() - lastActivity < 800) return;
    lastActivity = Date.now();
    void store.updateChat(id, { activity: text }).catch(() => undefined);
  };
  let error = "";
  try {
    for (let round = 0; round < MAX_ROUNDS && !abort.signal.aborted; round++) {
      const unread = await store.unreadChatMessages(id);
      if (!unread.length) break;
      await store.markChatRead(id, unread.map((m) => m.id!));
      activity(t("ch.thinking"));
      // Las imágenes de cada mensaje se descargan en su subcarpeta de .backcode-attachments (excluida de git y protegida).
      const prompt = buildChatPrompt(
        await Promise.all(
          unread.map(async (m) => ({
            text: m.text,
            files: m.attachments?.length ? await materializeAttachments(store, cfg.projectId, path, m.attachments, m.id) : [],
            ...(typeof m.video?.durationMs === "number" ? { videoMs: m.video.durationMs } : {}),
          })),
        ),
      );
      for await (const msg of query({
        prompt,
        options: {
          pathToClaudeCodeExecutable: claudeExecutable(),
          resume: sessionId,
          cwd: path,
          model: cfg.model,
          abortController: abort,
          env: deps.env,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildChatSystemAppend({ projectName: deps.project.name, projectContext: deps.project.context, worktree: path, baseBranch, remote, language: LANGUAGE_NAME[lang()] }),
          },
          // Los mismos límites que una tarea: sin settings del usuario ni del repo, dontAsk, guard y sandbox.
          settingSources: [],
          permissionMode: "dontAsk",
          allowedTools: ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "TodoWrite", "mcp__backcode__checkout_branch", "mcp__backcode__commit_and_push"],
          disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task"],
          hooks: { PreToolUse: [{ hooks: [createGuardHook(path, deps.isProtected)] }] },
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: cfg.allowedDomains, strictAllowlist: true },
            filesystem: { denyRead: deps.denyRead, allowWrite: [path] },
          },
          mcpServers: { backcode: server },
          maxTurns: cfg.maxTurns,
          maxBudgetUsd: cfg.maxBudgetUsd,
        },
      })) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              await store.postChatMessage(id, "say", block.text.trim().replace(/\n{3,}/g, "\n\n"));
            } else if (block.type === "tool_use" && !block.name.startsWith("mcp__backcode__")) {
              const line = deps.describeTool(block.name, block.input as Record<string, unknown>, path);
              activity(line);
              await store.postChatMessage(id, "tool", line);
            }
          }
        } else if (msg.type === "system" && msg.subtype === "init") {
          if (msg.session_id && msg.session_id !== sessionId) await store.updateChat(id, { sessionId: msg.session_id }).catch(() => undefined);
          sessionId = msg.session_id;
        } else if (msg.type === "result") {
          sessionId = msg.session_id;
          costUsd += msg.total_cost_usd;
          if (msg.subtype !== "success") await store.postChatMessage(id, "error", `${msg.subtype}: ${msg.errors.join("; ")}`.slice(0, 1000));
        }
      }
      if (abort.signal.aborted) {
        error = t("ch.timeout");
        await store.postChatMessage(id, "error", error);
      }
    }
  } catch (err) {
    error = String((err as Error).message ?? err);
    console.warn(`[chat] ${t("ch.failed", { error })}`);
    await store.postChatMessage(id, "error", error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // Sin cambios sin subir, la copia sobra (se rehace en la misma ruta y rama la próxima vez).
    if (!(await git(path, ["status", "--porcelain"]).catch(() => ""))) await removeWorktree(cfg.repoPath, path);
  }
  await store.updateChat(id, { status: error ? "failed" : "idle", activity: "", ...(sessionId ? { sessionId } : {}), ...(branch ? { branch } : {}), costUsd, ...(error ? { error } : {}) }).catch((err: Error) => console.warn(`[chat] ${err.message}`));
  // Lo que escribió mientras terminaba: se vuelve a encolar.
  if (!signal.aborted && (await store.unreadChatMessages(id).catch(() => [])).length) await store.updateChat(id, { status: "pending" }).catch(() => undefined);
  console.log(`[chat] ${error ? t("ch.failed", { error }) : t("ch.done", { cost: costUsd.toFixed(3) })}`);
}
