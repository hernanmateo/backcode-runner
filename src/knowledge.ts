import { createHash } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, findRepoIcon, git, remoteHead, removeWorktree, SECRET_PATTERNS } from "./git.js";
import { createGuardHook } from "./guard.js";
import { t } from "./i18n.js";
import type { Store } from "./store.js";
import { claudeExecutable } from "./preflight.js";

// Mapa del repositorio: Claude (modelo barato, solo lectura) resume el proyecto y se guarda en
// projects/{pid}/knowledge/repo. La IA que prepara los encargos lo usa para conocer el código.

const MIN_AGE_MS = 24 * 60 * 60_000; // no regenerar más de una vez al día aunque cambie la rama base
const FORCE_MIN_AGE_MS = 10 * 60_000; // «Actualizar ahora» desde la app: como mucho uno cada 10 minutos
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

/** `force`: «Actualizar ahora» desde la app (como mucho uno cada 10 min), sin esperar a que cambie la rama ni a las 24 h. */
export async function refreshKnowledge(cfg: RunnerConfig, store: Store, env: Record<string, string>, signal: AbortSignal, opts: { force?: boolean } = {}): Promise<void> {
  await refreshMap(cfg, store, env, signal, opts);
  await refreshIcon(cfg, store).catch((err) => console.warn(`[icon] ${(err as Error).message}`));
}

/**
 * Icono del repo para la app: el de la rama base de ahora. Se vuelve a subir cuando cambia (antes solo se subía la
 * primera vez y un icono nuevo en el repo no llegaba nunca a la app). Se compara con el MD5 del que hay en Storage.
 */
async function refreshIcon(cfg: RunnerConfig, store: Store): Promise<void> {
  const saved = await store.knowledgeState();
  if (!saved.exists || !saved.commit) return;
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch).catch(() => saved.commit!);
  const icon = await findRepoIcon(cfg.repoPath, commit, saved.iconHint);
  if (!icon) return;
  if (saved.iconPath && (await store.repoIconMd5()) === createHash("md5").update(icon.data).digest("base64")) return;
  await store.saveRepoIcon(icon.data, icon.contentType);
  console.log(`[icon] ${t("kn.icon")}`);
}

/** Ficheros versionados en un commit: un mapa hecho con muy pocos es de un repo casi vacío. */
const fileCount = async (repoPath: string, commit: string) => (await git(repoPath, ["ls-tree", "-r", "--name-only", commit]).catch(() => "")).split("\n").filter(Boolean).length;
const POOR_REPO_FILES = 15;

/**
 * ¿Regenerar el mapa? «force» (Actualizar ahora): sí, salvo si se hizo hace menos de 10 min. Si no: solo si cambió la rama
 * principal y el mapa tiene más de 24 h; o, una sola vez por proyecto (earlyRefresh), antes de las 24 h si el mapa se hizo
 * con el repo casi vacío (menos de POOR_REPO_FILES ficheros) y ahora ya tiene código.
 */
export function mapDecision(o: {
  force: boolean;
  now: number;
  commit: string;
  saved: { commit?: string; updatedAt?: number; earlyRefresh?: boolean };
  files?: { saved: number; now: number };
}): "tooSoon" | "skip" | "refresh" | "early" {
  const age = o.saved.updatedAt === undefined ? Infinity : o.now - o.saved.updatedAt;
  if (o.force) return age < FORCE_MIN_AGE_MS ? "tooSoon" : "refresh";
  if (o.saved.commit === o.commit) return "skip";
  if (age >= MIN_AGE_MS) return "refresh";
  if (o.saved.earlyRefresh || !o.saved.commit || !o.files) return "skip";
  return o.files.saved < POOR_REPO_FILES && o.files.now >= POOR_REPO_FILES ? "early" : "skip";
}

async function refreshMap(cfg: RunnerConfig, store: Store, env: Record<string, string>, signal: AbortSignal, opts: { force?: boolean } = {}): Promise<void> {
  if (cfg.knowledge === "off" && !opts.force) return;
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const saved = await store.knowledgeState();
  const young = !!saved.updatedAt && Date.now() - saved.updatedAt < MIN_AGE_MS;
  // Solo se cuentan los ficheros si hace falta (mapa joven, de otro commit y sin la excepción gastada).
  const files = !opts.force && young && saved.commit && saved.commit !== commit && !saved.earlyRefresh ? { saved: await fileCount(cfg.repoPath, saved.commit), now: await fileCount(cfg.repoPath, commit) } : undefined;
  const decision = mapDecision({ force: !!opts.force, now: Date.now(), commit, saved, files });
  if (decision === "tooSoon") throw new Error(t("kn.tooSoon"));
  if (decision === "skip") return;
  const early = decision === "early";

  console.log(`[knowledge] ${t("kn.analyzing", { ref: `${cfg.remote}/${cfg.baseBranch}`, sha: commit.slice(0, 7) })}`);
  const path = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_knowledge", commit);
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  try {
    let summary = "";
    let costUsd = 0;
    for await (const msg of query({
      prompt: PROMPT,
      options: {
        pathToClaudeCodeExecutable: claudeExecutable(),
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
    if (summary.length < 200) throw new Error(t("kn.empty"));
    const leaked = SECRET_PATTERNS.filter(([re]) => re.test(summary)).map(([, label]) => t(label));
    if (leaked.length) throw new Error(t("kn.leaked", { list: leaked.join(", ") }));
    await store.saveKnowledge(summary.slice(0, MAX_CHARS), commit, costUsd, iconHint, early);
    console.log(`[knowledge] ${t("kn.updated", { cost: costUsd.toFixed(3) })}`);
  } finally {
    await removeWorktree(cfg.repoPath, path);
  }
}
