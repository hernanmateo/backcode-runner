import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { materializeAttachments, type LocalAttachment } from "./attachments.js";
import type { RunnerConfig } from "./config.js";
import { hasMarkers } from "./conflicts.js";
import { createDetachedWorktree, git, mergeBaseIntoBranch, removeWorktree, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook } from "./guard.js";
import { LANGUAGE_NAME, lang, t } from "./i18n.js";
import { chatAppliesTo, checkPermissionRequest, loadPermissionContext, NONE, REQUEST_PERMISSION_INPUT, sessionPermissions, type PermissionContext } from "./permissions.js";
import { claudeExecutable } from "./preflight.js";
import { buildChatPrompt, buildChatSystemAppend, type ChatVideo, type PromptImage, type PromptMessage } from "./prompt.js";
import type { Attachment, ChatUserMessage, RunnerChat, Store, ThreadMessage } from "./store.js";

// Conversación libre con mi runner (botón junto a «Proponer una idea»): projects/{pid}/chats/{id}. No hay tarea: la
// persona pregunta o pide arreglos pequeños (p. ej. resolver un conflicto en la rama de un PR). Claude trabaja con los
// mismos límites que una tarea (guard, sandbox, entorno sin secretos, dontAsk) y el git que cambia algo solo lo hace el
// runner con dos herramientas: checkout_branch (a una rama existente del remoto, nunca la base) y commit_and_push (sin
// forzar, sin ficheros protegidos ni secretos). La copia de trabajo es siempre la misma por conversación (_chat-<id>), así
// la sesión de Claude se puede retomar; se borra al acabar cada vuelta si no quedan cambios sin subir.
// Para trabajo completo («haz X»), create_task crea una tarea normal del tablero a su nombre (callable createChatTask, que
// la acepta como acceptFeature) y la ejecuta este runner por su cola de siempre (rama propia, PR en borrador, mismos
// límites que cualquier tarea); task_status dice cómo van. El chat no espera a que acaben: puede lanzar varias.
// message_task corrige una de esas tareas (callable messageChatTask): en cola cambia el encargo; si no, el texto va a su
// hilo como un mensaje de la persona (marcado «desde el chat») y el runner se lo pasa a su sesión o la retoma.
// Permisos personales (permissions.ts), con la misma lógica que en las tareas: si quien escribe es quien tiene el runner
// (chatAppliesTo), se aplican los suyos más lo concedido en esta conversación, y Claude puede pedir más con
// request_permission (la app muestra la misma tarjeta que en el hilo de una tarea). En la de un compañero que usa mi
// runner compartido, ninguno y sin request_permission.

/** Vueltas seguidas como mucho por cada recogida (mensajes que llegan mientras responde). */
const MAX_ROUNDS = 10;

// Vídeos (sesiones de revisión): el servidor los analiza como en el chat del proyecto (processRunnerChatVideo:
// transcripción con tiempos y fotogramas, guardados en el mensaje). La vuelta espera a que esté (o falle) y Claude recibe
// la transcripción en el prompt y los fotogramas como imágenes en la copia de trabajo.
/** Cuánto se espera como mucho al análisis (la Function tiene 9 minutos). */
export const VIDEO_WAIT_MS = 10 * 60_000;
const VIDEO_POLL_MS = 3_000;

/** Algún mensaje trae un vídeo que el servidor aún no ha terminado de analizar. */
export function videosPending(messages: Pick<ChatUserMessage, "video" | "videoDone">[]): boolean {
  return messages.some((m) => !!m.video && m.videoDone !== true);
}

/** Nombre de un fotograma con su minuto (como en el refinado de «Nueva idea»): fotograma-1m05s.jpg. */
export function frameName(at: number): string {
  const s = Math.max(0, Math.floor(at));
  return `fotograma-${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s.jpg`;
}

/** Los fotogramas del análisis como adjuntos (imágenes) para descargarlos en la copia de trabajo. */
export function frameAttachments(frames: ChatUserMessage["frames"]): Attachment[] {
  return (Array.isArray(frames) ? frames : [])
    .filter((f) => typeof f?.path === "string" && typeof f.at === "number")
    .map((f) => ({ path: f.path, name: frameName(f.at), contentType: "image/jpeg", size: 0 }));
}

/**
 * Lo que Claude recibe del vídeo de un mensaje: la transcripción y los fotogramas descargados (subcarpeta
 * <mensaje>-video de .backcode-attachments) o, si el análisis falló o no llegó a tiempo, el motivo.
 */
async function chatVideo(store: Store, projectId: string, worktree: string, m: ThreadMessage): Promise<ChatVideo> {
  const durationMs = typeof m.video?.durationMs === "number" ? m.video.durationMs : undefined;
  if (m.videoDone !== true) return { durationMs, frames: [], error: "the analysis did not finish in time" };
  if (m.videoError) return { durationMs, frames: [], error: String(m.videoError).slice(0, 300) };
  let frames: LocalAttachment[] = [];
  try {
    frames = await materializeAttachments(store, projectId, worktree, frameAttachments(m.frames), `${m.id ?? "msg"}-video`, 16);
  } catch (err) {
    console.warn(`[chat] ${(err as Error).message}`);
  }
  return { durationMs, transcript: typeof m.transcript === "string" ? m.transcript : "", frames };
}

/**
 * Un mensaje de la persona listo para el prompt (conversación con el runner o hilo de una tarea): sus adjuntos descargados
 * en su subcarpeta de .backcode-attachments (excluida de git y protegida) y, si trae vídeo, su análisis.
 */
export async function promptMessage(store: Store, projectId: string, worktree: string, m: ThreadMessage): Promise<PromptMessage> {
  let files: LocalAttachment[] = [];
  let attachmentError: string | undefined;
  if (m.attachments?.length) {
    try {
      files = await materializeAttachments(store, projectId, worktree, m.attachments, m.id);
    } catch (err) {
      // No se pierde en silencio: el texto llega y Claude sabe que había adjuntos que no ha podido ver.
      attachmentError = String((err as Error).message ?? err);
      console.warn(`[messages] ${attachmentError}`);
    }
  }
  const images = imageBlocks(worktree, files);
  return {
    text: m.text,
    files,
    ...(images.length ? { images } : {}),
    ...(attachmentError ? { attachmentError } : {}),
    ...(m.video ? { video: await chatVideo(store, projectId, worktree, m) } : {}),
  };
}

const IMAGE_TYPES: Record<string, PromptImage["mediaType"]> = { "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/png": "image/png", "image/gif": "image/gif", "image/webp": "image/webp" };
const MAX_INLINE_IMAGES = 5;
const MAX_INLINE_IMAGE_BYTES = 3_500_000;

/** Las imágenes descargadas como bloques base64 para el modelo (las demasiado grandes siguen disponibles por su ruta). */
export function imageBlocks(worktree: string, files: LocalAttachment[]): PromptImage[] {
  const out: PromptImage[] = [];
  for (const f of files) {
    const mediaType = IMAGE_TYPES[f.contentType.toLowerCase()];
    if (!mediaType || out.length >= MAX_INLINE_IMAGES) continue;
    try {
      const abs = join(worktree, f.file);
      if (statSync(abs).size > MAX_INLINE_IMAGE_BYTES) continue;
      out.push({ mediaType, data: readFileSync(abs).toString("base64") });
    } catch {
      // Sigue disponible por su ruta.
    }
  }
  return out;
}

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

/** Herramientas de la conversación: las de siempre más las del runner (MCP). Ni herramientas ni dominios de más. */
export const CHAT_ALLOWED_TOOLS = [
  "Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "TodoWrite",
  "mcp__backcode__checkout_branch", "mcp__backcode__commit_and_push", "mcp__backcode__create_task", "mcp__backcode__task_status",
  "mcp__backcode__message_task", "mcp__backcode__set_conversation_title",
];

/**
 * Herramientas de una vuelta de la conversación: las de siempre, request_permission solo si se aplican los permisos
 * personales (quien escribe es quien tiene el runner) y WebFetch solo hacia los dominios concedidos.
 */
export function chatAllowedTools(ctx: Pick<PermissionContext, "applies" | "perms" | "roots">): string[] {
  return [...CHAT_ALLOWED_TOOLS, ...(ctx.applies ? ["mcp__backcode__request_permission"] : []), ...sessionPermissions(ctx, []).allowedTools];
}

/** Largo máximo del título de una conversación (el que pone Claude con set_conversation_title o la persona al renombrarla). */
export const CHAT_TITLE_MAX = 60;

/**
 * Limpia el título que propone Claude para la conversación (tipo épica: 2–5 palabras): un solo renglón, sin comillas ni
 * punto final alrededor y hasta CHAT_TITLE_MAX caracteres. null si queda vacío.
 */
export function conversationTitle(raw: string): string | null {
  const title = raw
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/^["'«“\s]+/, "")
    .replace(/["'»”.。…\s]+$/, "")
    .slice(0, CHAT_TITLE_MAX)
    .trim();
  return title || null;
}

/** Si el runner puede cambiar el título: no cuando la persona la renombró a mano (titleManual). */
export function canRetitle(chat: { titleManual?: boolean }): boolean {
  return chat.titleManual !== true;
}

/** Lo que pide Claude con create_task, ya limpio (los límites los vuelve a comprobar createChatTask). */
export interface ChatTaskInput {
  title: string;
  prompt: string;
  acceptanceCriteria: string[];
  planFirst?: boolean;
}

/** Una tarea lanzada desde la conversación, para task_status. */
export interface ChatTask {
  id: string;
  title: string;
  status: string;
  branch?: string;
  prUrl?: string;
  error?: string;
}

/** Recorta y valida la entrada de create_task: null si falta título o encargo. */
export function chatTaskInput(raw: { title: string; prompt: string; acceptanceCriteria?: string[]; planFirst?: boolean }): ChatTaskInput | null {
  const title = raw.title.replaceAll(/\s+/g, " ").trim().slice(0, 200);
  const prompt = raw.prompt.trim().slice(0, 8000);
  if (!title || !prompt) return null;
  const acceptanceCriteria = (raw.acceptanceCriteria ?? []).map((c) => c.trim().slice(0, 500)).filter(Boolean).slice(0, 20);
  return { title, prompt, acceptanceCriteria, ...(raw.planFirst ? { planFirst: true } : {}) };
}

/** Lo que pide Claude con message_task, ya limpio (quién, estado y límites los decide messageChatTask). */
export interface ChatTaskMessage {
  taskId: string;
  text: string;
  title?: string;
  acceptanceCriteria?: string[];
}

/** Recorta y valida la entrada de message_task: null si el id no es válido o no hay texto. */
export function chatTaskMessageInput(raw: { taskId: string; text: string; title?: string; acceptanceCriteria?: string[] }): ChatTaskMessage | null {
  const taskId = raw.taskId.trim();
  const text = raw.text.trim().slice(0, 8000);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId) || !text) return null;
  const title = raw.title?.replaceAll(/\s+/g, " ").trim().slice(0, 200);
  const acceptanceCriteria = raw.acceptanceCriteria?.map((c) => c.trim().slice(0, 500)).filter(Boolean).slice(0, 20);
  return { taskId, text, ...(title ? { title } : {}), ...(acceptanceCriteria ? { acceptanceCriteria } : {}) };
}

/** Las tareas de la conversación, una por línea (para Claude). */
export function describeChatTasks(tasks: ChatTask[]): string {
  if (!tasks.length) return t("ch.noTasks");
  const line = (s: string) => s.replaceAll(/[\r\n]+/g, " ");
  return tasks
    .map((f) => `- ${f.id} · ${line(f.title)} · ${f.status}${f.branch ? ` · ${f.branch}` : ""}${f.prUrl ? ` · ${f.prUrl}` : ""}${f.error ? ` · ${line(f.error).slice(0, 200)}` : ""}`)
    .join("\n");
}

export interface ChatDeps {
  env: Record<string, string>;
  /** Crea la tarea (createChatTask) y la deja en la cola de este runner. */
  createTask: (input: ChatTaskInput) => Promise<{ featureId: string; branch: string }>;
  /** Corrige o amplía una tarea de esta conversación (messageChatTask): qué hizo el servidor según su estado. */
  messageTask: (input: ChatTaskMessage) => Promise<{ mode: "update" | "message" | "resume" }>;
  /** Tareas lanzadas desde esta conversación. */
  listTasks: () => Promise<ChatTask[]>;
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

  // Permisos: se recalculan en cada vuelta (lo concedido en la tarjeta entra en la siguiente).
  const applies = chatAppliesTo(chat, store.uid);
  const loadPerms = async () =>
    loadPermissionContext({ applies, store, grants: applies ? await store.chatGrants(id).catch(() => NONE) : NONE, projectId: cfg.projectId, scope: "chat" });
  let permCtx = await loadPerms();
  let permissionAsked = false; // Claude pidió permiso en esta vuelta: se espera a la decisión

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
      tool(
        "create_task",
        `Create a real Backcode task for this member and queue it on this runner: it appears on the project board assigned to them and runs like any other task, in its own branch backcode/<handle>/<id> from ${remote}/${baseBranch}, ending with a draft pull request. Use it when they ask you to build or change something (not for questions). It returns at once and the task runs in the background, so you can create several. The prompt must be self-contained: the task does not see this conversation.`,
        {
          title: z.string().min(1).max(200),
          prompt: z.string().min(1).max(8000),
          acceptanceCriteria: z.array(z.string().max(500)).max(20).optional(),
          planFirst: z.boolean().optional(),
        },
        async (raw) => {
          const input = chatTaskInput(raw);
          if (!input) return fail(t("ch.taskFailed", { error: "title/prompt" }));
          try {
            const { featureId, branch: taskBranch } = await deps.createTask(input);
            const text = t("ch.taskCreated", { title: input.title, branch: taskBranch });
            await store.postChatMessage(id, "tool", text);
            return reply(`${text} (id ${featureId})`);
          } catch (err) {
            return fail(t("ch.taskFailed", { error: String((err as Error).message ?? err).slice(0, 500) }));
          }
        },
      ),
      tool(
        "message_task",
        "Correct or extend a task created from this conversation (use the id from create_task or task_status) instead of creating another one. What happens depends on its status: queued and not started yet (execute) = the text REPLACES its prompt (so send the complete, self-contained updated prompt; title and acceptanceCriteria are replaced only if given); running = the text reaches its Claude Code session as a message from the member (at its next step or when the current turn ends, before the pull request is opened or updated); waiting or done = it goes to the task thread and the runner resumes the session to update the branch and pull request; failed = error, create another task. Messages are limited to 4000 characters.",
        {
          taskId: z.string().min(1).max(64),
          text: z.string().min(1).max(8000),
          title: z.string().min(1).max(200).optional(),
          acceptanceCriteria: z.array(z.string().max(500)).max(20).optional(),
        },
        async (raw) => {
          const input = chatTaskMessageInput(raw);
          if (!input) return fail(t("ch.messageFailed", { error: "taskId/text" }));
          try {
            const { mode } = await deps.messageTask(input);
            const text = t(mode === "update" ? "ch.taskUpdated" : mode === "resume" ? "ch.taskResumed" : "ch.taskMessaged", { id: input.taskId });
            await store.postChatMessage(id, "tool", text);
            return reply(text);
          } catch (err) {
            return fail(t("ch.messageFailed", { error: String((err as Error).message ?? err).slice(0, 500) }));
          }
        },
      ),
      tool(
        "set_conversation_title",
        `Set the title of this conversation as shown in the member's history: a very short, descriptive summary of its overall topic, like an epic (2-5 words, at most ~40 characters, in their language, no final period). Hard limit ${CHAT_TITLE_MAX} characters. It fails if the member renamed the conversation by hand.`,
        { title: z.string().min(1).max(200) },
        async (raw) => {
          const title = conversationTitle(raw.title);
          if (!title) return fail(t("ch.titleFailed", { error: "title" }));
          try {
            const result = await store.setChatTitle(id, title);
            if (result === "manual") return fail(t("ch.titleManual"));
            return reply(t("ch.titleSet", { title }));
          } catch (err) {
            return fail(t("ch.titleFailed", { error: String((err as Error).message ?? err).slice(0, 500) }));
          }
        },
      ),
      tool(
        "request_permission",
        "Ask the member (who owns this runner) for an extra permission you truly need and don't have yet: read-only network access to specific domains (hostnames), the curl/wget commands, or reading another of their Backcode projects for examples of their own code (only the ids listed as available in your instructions). Give a short, concrete reason. They decide in this same conversation in the app (only this conversation, add it to their personal permissions, or deny) and you continue with their decision. Don't try a blocked action first. After calling it, end your turn without further changes.",
        REQUEST_PERMISSION_INPUT,
        async ({ reason, ...input }) => {
          if (!permCtx.applies) return fail(t("ch.permNotOwner"));
          if (permissionAsked) return fail(t("perm.pending"));
          const checked = checkPermissionRequest(input, permCtx);
          if ("error" in checked) return fail(checked.error);
          permissionAsked = true;
          await store.postChatPermissionRequest(id, reason, checked.need);
          return reply(t("perm.sent"));
        },
      ),
      tool(
        "task_status",
        "List the tasks created from this conversation with their status (execute = queued, running, waiting = Claude asked something or proposed a plan, done = draft pull request ready, failed), branch and pull request link.",
        {},
        async () => {
          try {
            return reply(describeChatTasks(await deps.listTasks()));
          } catch (err) {
            return fail(String((err as Error).message ?? err).slice(0, 500));
          }
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
      let unread = await store.unreadChatMessages(id);
      if (!unread.length) break;
      // Vídeos: se espera al análisis del servidor (o a que lo marque como fallido); si no llega, va sin él.
      const waitStart = Date.now();
      while (videosPending(unread) && Date.now() - waitStart < VIDEO_WAIT_MS && !abort.signal.aborted) {
        activity(t("ch.analyzingVideo"));
        await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_MS));
        unread = await store.unreadChatMessages(id);
      }
      await store.markChatRead(id, unread.map((m) => m.id!));
      activity(t("ch.thinking"));
      if (round > 0) permCtx = await loadPerms();
      permissionAsked = false;
      const session = sessionPermissions(permCtx, cfg.allowedDomains);
      // Las imágenes de cada mensaje se descargan en su subcarpeta de .backcode-attachments (excluida de git y protegida).
      const prompt = buildChatPrompt(
        await Promise.all(
          unread.map(async (m) => ({ ...(await promptMessage(store, cfg.projectId, path, m)), ...(m.voice === true ? { voice: true } : {}) })),
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
            append: buildChatSystemAppend({ projectName: deps.project.name, projectContext: deps.project.context, worktree: path, baseBranch, remote, language: LANGUAGE_NAME[lang()], titleManual: !canRetitle(chat), permissions: permCtx.prompt }),
          },
          // Los mismos límites que una tarea: sin settings del usuario ni del repo, dontAsk, guard y sandbox.
          settingSources: [],
          permissionMode: "dontAsk",
          allowedTools: chatAllowedTools(permCtx),
          // Como en las tareas: WebFetch solo a los dominios concedidos; curl/wget y las carpetas de solo lectura, en el guard.
          disallowedTools: session.disallowedTools,
          hooks: { PreToolUse: [{ hooks: [createGuardHook(path, deps.isProtected, session.guard)] }] },
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: session.allowedDomains, strictAllowlist: true },
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
      // Pidió permiso: se espera a la decisión (al responder en la tarjeta, la conversación vuelve a la cola).
      if (permissionAsked) break;
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
