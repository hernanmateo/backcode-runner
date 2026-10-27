import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, findRepoIcon, remoteHead, removeWorktree, SECRET_PATTERNS } from "./git.js";
import { createGuardHook } from "./guard.js";
import type { Store } from "./store.js";

// Mapa del repositorio: Claude (modelo barato, solo lectura) resume el proyecto y se guarda en
// projects/{pid}/knowledge/repo. La IA que prepara los encargos lo usa para conocer el código.

const MIN_AGE_MS = 24 * 60 * 60_000; // no regenerar más de una vez al día aunque cambie la rama base
const MAX_CHARS = 12_000;

const PROMPT = `Analyze this repository (read-only) and write a concise project map in Spanish, in Markdown, for another AI that turns feature ideas into implementation tasks for this codebase.

Sections (skip any that don't apply):
## Qué es — one or two sentences about the product.
## Stack — languages, frameworks, main libraries, database/services.
## Estructura — the important directories and what lives in each (paths).
## Módulos clave — main features/domains and the files that implement them.
## Cómo se trabaja — commands to install, run, test, lint and type-check (from package.json, Makefile, etc.).
## Convenciones — code style, patterns, testing approach, naming.
## Zonas sensibles — auth, payments, migrations, infra or anything risky to touch.

Rules: be factual and only describe what you find in the files; prefer exact paths and commands; max ~1500 words. Never include secrets, credentials, tokens, keys, connection strings or personal data, even if you see them. Explore with Glob/Grep/Read efficiently (manifests, README, CLAUDE.md, top-level dirs, a few representative files). Your final message must be only the Markdown map, followed by ONE last line with the repository-relative path of the image (PNG or JPG) that is the product's icon or logo — for a mobile app, its app icon — written exactly as \`ICON: path/to/icon.png\`, or \`ICON: none\` if there isn't a clear one.`;

export async function refreshKnowledge(cfg: RunnerConfig, store: Store, env: Record<string, string>, signal: AbortSignal): Promise<void> {
  await refreshMap(cfg, store, env, signal);
  await refreshIcon(cfg, store).catch((err) => console.warn(`[icon] ${(err as Error).message}`));
}

/** Icono del repo para la app (una vez; luego solo si no se encontró antes y cambia la rama base). */
async function refreshIcon(cfg: RunnerConfig, store: Store): Promise<void> {
  const saved = await store.knowledgeState();
  if (!saved.exists || saved.iconPath || !saved.commit) return;
  const icon = await findRepoIcon(cfg.repoPath, saved.commit, saved.iconHint);
  if (!icon) return;
  await store.saveRepoIcon(icon.data, icon.contentType);
  console.log("[icon] icono del proyecto subido desde el repo");
}

async function refreshMap(cfg: RunnerConfig, store: Store, env: Record<string, string>, signal: AbortSignal): Promise<void> {
  if (cfg.knowledge === "off") return;
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const saved = await store.knowledgeState();
  if (saved.commit === commit) return;
  if (saved.updatedAt && Date.now() - saved.updatedAt < MIN_AGE_MS) return;

  console.log(`[knowledge] analizando ${cfg.remote}/${cfg.baseBranch} (${commit.slice(0, 7)}) para que la IA conozca el proyecto…`);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_knowledge", commit);
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  try {
    let summary = "";
    let costUsd = 0;
    for await (const msg of query({
      prompt: PROMPT,
      options: {
        cwd: path,
        model: cfg.knowledgeModel,
        abortController: abort,
        // Solo lectura: sin Bash, sin escritura y sin red. El worktree solo tiene ficheros versionados (no .env locales).
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
        hooks: { PreToolUse: [{ hooks: [createGuardHook(path, () => true)] }] },
        settingSources: [],
        maxTurns: 40,
        maxBudgetUsd: 0.5,
        env,
      },
    })) {
      if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        if (msg.subtype === "success") summary = msg.result.trim();
      }
    }
    // Última línea "ICON: …": pista del icono para cuando las reglas fijas no lo encuentran (se valida antes de usarla).
    const iconLine = /\n?ICON:\s*`?([^`\n]*?)`?\s*$/.exec(summary);
    const iconHint = iconLine && /^[\w./ @+-]{1,300}\.(png|jpe?g)$/i.test(iconLine[1]) && !iconLine[1].includes("..") && !iconLine[1].startsWith("/") ? iconLine[1] : undefined;
    if (iconLine) summary = summary.slice(0, iconLine.index).trim();
    if (summary.length < 200) throw new Error("el análisis no devolvió un mapa útil");
    const leaked = SECRET_PATTERNS.filter(([re]) => re.test(summary)).map(([, label]) => label);
    if (leaked.length) throw new Error(`descartado: parece contener ${leaked.join(", ")}`);
    await store.saveKnowledge(summary.slice(0, MAX_CHARS), commit, costUsd, iconHint);
    console.log(`[knowledge] mapa del proyecto actualizado ($${costUsd.toFixed(3)})`);
  } finally {
    await removeWorktree(cfg.repoPath, path);
  }
}
