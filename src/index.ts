import { homedir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { onSnapshot } from "firebase/firestore";
import { z } from "zod";
import { KIT_DIR, loadConfig } from "./config.js";
import { commitPushAndOpenPr, commitsAhead, createWorktree, removeWorktree, scanStagedForSecrets, stageAll } from "./git.js";
import { createGuardHook, protectedMatcher } from "./guard.js";
import { refreshKnowledge } from "./knowledge.js";
import { buildSystemAppend, buildUserPrompt } from "./prompt.js";
import { connect, FEATURE_LEASE_MS, Store, type Feature, type FeatureResult } from "./store.js";

const cfg = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[backcode] ${(err as Error).message}`);
    process.exit(1);
  }
})();
let store: Store;
const isProtected = protectedMatcher(cfg.protectedPaths);

// Entorno mínimo para Claude y sus comandos: sin credenciales de Firebase, GitHub ni cloud.
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
function agentEnv(): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: "backcode-runner" };
  for (const key of ENV_ALLOWLIST) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

// Directorios sensibles que los comandos sandboxeados no pueden leer.
const home = homedir();
const DENY_READ = [
  KIT_DIR, // contiene el .env con tu runner key
  ...[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".config/gh", ".config/gcloud", ".claude.json", "Library/Keychains"].map((p) => join(home, p)),
];

let current: { id: string; abort: AbortController } | null = null;
let pending: string[] = [];
let busy = false;
let stopping = false;

async function runFeature(id: string, feature: Feature): Promise<{ status: "done" | "failed"; result: FeatureResult }> {
  const acceptanceError = await store.verifyAcceptance(id, feature);
  if (acceptanceError) return { status: "failed", result: { error: acceptanceError } };

  const project = await store.projectInfo();
  const wt = await createWorktree({ repoPath: cfg.repoPath, worktreesDir: cfg.worktreesDir, remote: cfg.remote, baseBranch: cfg.baseBranch, featureId: id, branch: feature.branch! });
  await store.event(id, "start", `Worktree ${wt.branch} creado desde ${cfg.remote}/${cfg.baseBranch}`);

  let prUrl: string | undefined;
  const prServer = createSdkMcpServer({
    name: "backcode",
    version: "1.0.0",
    tools: [
      tool(
        "open_pull_request",
        "Commit all changes in the worktree to the feature branch, push it and open a draft pull request. Call exactly once when the work is complete.",
        { title: z.string().min(5).max(120), body: z.string().min(20).max(20_000) },
        async ({ title, body }) => {
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
          if (prUrl) return fail(`Ya existe un PR para esta funcionalidad: ${prUrl}`);

          const files = await stageAll(wt.path);
          if (files.length === 0 && (await commitsAhead(wt.path, cfg.remote, cfg.baseBranch)) === 0) {
            return fail("No hay cambios en el worktree; no se puede abrir un PR vacío.");
          }
          const blocked = files.filter(isProtected);
          if (blocked.length) return fail(`Cambios en rutas protegidas, revértelos antes de abrir el PR: ${blocked.join(", ")}`);
          const secrets = await scanStagedForSecrets(wt.path);
          if (secrets.length) return fail(`Posibles secretos en el diff, elimínalos: ${secrets.join("; ")}`);

          const footer = `\n\n---\nBackcode feature \`${id}\` · ${files.length} fichero(s) · rama \`${wt.branch}\`\n\n🤖 Generado por Backcode runner con [Claude Code](https://claude.com/claude-code)`;
          try {
            prUrl = await commitPushAndOpenPr({ worktree: wt.path, remote: cfg.remote, baseBranch: cfg.baseBranch, branch: wt.branch, title, body: body + footer, featureId: id, pushOnly: cfg.pullRequest === "push-only" });
          } catch (err) {
            await store.event(id, "error", `open_pull_request: ${String(err)}`);
            return fail(`No se pudo publicar la rama o abrir el PR: ${String(err).slice(0, 500)}`);
          }
          await store.event(id, "pr", prUrl);
          const what = cfg.pullRequest === "push-only" ? "Rama publicada" : "PR en borrador abierto";
          return { content: [{ type: "text" as const, text: `${what}: ${prUrl}` }] };
        },
      ),
    ],
  });

  const abort = new AbortController();
  current = { id, abort };
  const timeout = setTimeout(() => abort.abort(), cfg.timeoutMinutes * 60_000);
  const lease = setInterval(() => store.extendLease(id).catch(() => undefined), FEATURE_LEASE_MS / 3);

  let result: FeatureResult = { branch: wt.branch };
  try {
    const messages = query({
      prompt: buildUserPrompt(id, feature),
      options: {
        cwd: wt.path,
        model: cfg.model,
        abortController: abort,
        env: agentEnv(),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildSystemAppend({ projectName: project.name, projectContext: project.context, worktree: wt.path, branch: wt.branch, baseBranch: cfg.baseBranch, remote: cfg.remote }),
        },
        // No cargamos settings de usuario ni del repo: permisos y hooks los define solo este runner.
        settingSources: [],
        // dontAsk: todo lo que no esté en allowedTools se deniega sin preguntar.
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "TodoWrite", "mcp__backcode__open_pull_request"],
        disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task"],
        hooks: { PreToolUse: [{ hooks: [createGuardHook(wt.path, isProtected)] }] },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: cfg.allowedDomains, strictAllowlist: true },
          filesystem: { denyRead: DENY_READ, allowWrite: [wt.path] },
        },
        mcpServers: { backcode: prServer },
        maxTurns: cfg.maxTurns,
        maxBudgetUsd: cfg.maxBudgetUsd,
      },
    });

    for await (const msg of messages) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            const detail = String(input.description ?? input.file_path ?? input.pattern ?? input.title ?? "");
            await store.event(id, "tool", `${block.name}${detail ? `: ${detail}` : ""}`);
          }
        }
      } else if (msg.type === "result") {
        result = {
          ...result,
          costUsd: msg.total_cost_usd,
          turns: msg.num_turns,
          summary: msg.subtype === "success" ? msg.result.slice(0, 4000) : undefined,
          error: msg.subtype === "success" ? undefined : `${msg.subtype}: ${msg.errors.join("; ").slice(0, 2000)}`,
        };
      }
    }
  } catch (err) {
    result.error = abort.signal.aborted ? (stopping ? "runner detenido" : `Timeout de ${cfg.timeoutMinutes} min`) : String(err);
  } finally {
    clearTimeout(timeout);
    clearInterval(lease);
    current = null;
    await removeWorktree(cfg.repoPath, wt.path);
  }

  if (prUrl) return { status: "done", result: { ...result, prUrl, error: undefined } };
  return { status: "failed", result: { ...result, error: result.error ?? "Claude terminó sin abrir un PR (ver summary)" } };
}

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (!stopping && pending.length > 0) {
      const id = pending.shift()!;
      const feature = await store.claim(id);
      if (!feature) continue;
      console.log(`[run] ${id} · ${feature.title}`);
      try {
        const { status, result } = await runFeature(id, feature);
        if (stopping && !result.prUrl) {
          await store.requeue(id);
        } else {
          await store.finish(id, status, result);
          await store.event(id, status, result.prUrl ?? result.error ?? "");
        }
        console.log(`[${status}] ${id} ${result.prUrl ?? result.error ?? ""}`);
      } catch (err) {
        console.error(`[error] ${id}`, err);
        await store.finish(id, "failed", { error: String(err).slice(0, 2000) });
      }
    }
  } finally {
    busy = false;
  }
}

async function main(): Promise<void> {
  const { db, uid } = await connect(cfg);
  store = new Store(db, cfg, uid);
  console.log(`[backcode] usuario ${uid} · proyecto ${cfg.projectId} · repo ${cfg.repoPath} · base ${cfg.remote}/${cfg.baseBranch} · runner ${cfg.runnerId}`);
  const releaseLock = await store.acquireLock();
  await store.recoverOrphans();

  // Mapa del repo para la IA que prepara los encargos: al arrancar y cada 6 h, sin bloquear la cola.
  const knowledgeAbort = new AbortController();
  const learn = () =>
    refreshKnowledge(cfg, store, agentEnv(), knowledgeAbort.signal).catch((err) => console.warn(`[knowledge] ${(err as Error).message}`));
  void learn();
  const knowledgeTimer = setInterval(learn, 6 * 60 * 60_000);

  // Solo las tareas que este usuario aceptó en este proyecto, por prioridad y orden de aceptación.
  const unsubscribe = onSnapshot(
    store.myQueue(),
    (snap) => {
      pending = snap.docs
        .map((d) => ({ id: d.id, priority: (d.get("priority") as number) ?? 0, at: d.get("acceptedAt")?.toMillis?.() ?? 0 }))
        .sort((a, b) => a.priority - b.priority || a.at - b.at)
        .map((d) => d.id);
      if (pending.length) console.log(`[queue] ${pending.length} pendiente(s)`);
      void drain();
    },
    (err) => {
      console.error("[snapshot] error:", err.message);
      process.exit(1);
    },
  );

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[backcode] parando…");
    unsubscribe();
    clearInterval(knowledgeTimer);
    knowledgeAbort.abort();
    current?.abort.abort();
    while (busy) await new Promise((r) => setTimeout(r, 200));
    await releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[backcode] error fatal:", err.message ?? err);
  process.exit(1);
});
