import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, findExpoApp, remoteHead, removeWorktree } from "./git.js";
import type { Checks, PrHost } from "./hosts.js";
import type { Store } from "./store.js";

// Acciones que pide un admin desde la app y ejecuta su runner con sus credenciales (gh / Bitbucket / EAS):
// mergear el PR de una tarea o publicar un OTA de Expo. Los comandos son fijos: nunca los decide Claude.

export interface Action {
  type: "merge" | "ota";
  featureId?: string;
  channel?: "preview" | "production";
  message?: string;
}
export interface ActionResult {
  url?: string;
  sha?: string;
  error?: string;
  /** Checks que no están en verde (si se rechaza por eso). */
  checks?: string[];
  log?: string;
}

const OTA_TIMEOUT_MS = 25 * 60_000;

/** Solo se continúa con todo en verde (o sin checks configurados). */
function requireGreen(checks: Checks, what: string): ActionResult | null {
  if (checks.state === "green" || checks.state === "none") return null;
  return { error: `${what}: los checks no están en verde (${checks.state === "pending" ? "en curso" : "fallan"})`, checks: checks.pending };
}

export async function runAction(cfg: RunnerConfig, store: Store, host: PrHost | undefined, action: Action): Promise<{ ok: boolean; result: ActionResult }> {
  if (action.type === "merge") return merge(cfg, store, host, action.featureId ?? "");
  return publishOta(cfg, host, action.channel ?? "preview", action.message ?? "Backcode");
}

async function merge(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string) {
  if (!host) return { ok: false, result: { error: "Este proyecto no tiene PRs (solo se sube la rama): mergea desde tu repositorio" } };
  const prUrl = await store.prUrlOf(featureId);
  if (!prUrl?.startsWith("https://")) return { ok: false, result: { error: "La tarea no tiene PR abierto" } };
  const blocked = requireGreen(await host.prChecks(prUrl), "PR");
  if (blocked) return { ok: false, result: blocked };
  const { sha } = await host.merge(prUrl);
  await store.markMerged(featureId, sha);
  // La rama ya no existe: la copia de trabajo de la tarea sobra.
  await removeWorktree(cfg.repoPath, join(cfg.worktreesDir, featureId)).catch(() => undefined);
  return { ok: true, result: { url: prUrl, sha } };
}

async function publishOta(cfg: RunnerConfig, host: PrHost | undefined, channel: "preview" | "production", message: string) {
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: "El repositorio no es una app Expo con eas.json" } };
  if (!app.channels.includes(channel)) return { ok: false, result: { error: `El canal ${channel} no está en eas.json` } };
  if (host) {
    const blocked = requireGreen(await host.commitChecks(commit), `${cfg.baseBranch} (${commit.slice(0, 7)})`);
    if (blocked) return { ok: false, result: blocked };
  }

  const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_ota", commit);
  try {
    const dir = join(wt, app.appDir);
    // Dependencias con el gestor del repo (lockfile en la app o en la raíz del monorepo).
    const has = (f: string) => existsSync(join(dir, f)) || existsSync(join(wt, f));
    const install = has("pnpm-lock.yaml") ? ["pnpm", "install", "--frozen-lockfile"] : has("yarn.lock") ? ["yarn", "install", "--frozen-lockfile"] : has("bun.lock") || has("bun.lockb") ? ["bun", "install", "--frozen-lockfile"] : ["npm", "ci"];
    const installDir = existsSync(join(dir, "package.json")) && !has("pnpm-workspace.yaml") ? dir : wt;
    await exec(install, installDir);
    // Siempre al 100 % y para todas las plataformas (sin despliegue gradual).
    const out = await exec(["npx", "--yes", "eas-cli@latest", "update", "--channel", channel, "--environment", channel, "--message", message.slice(0, 200), "--platform", "all", "--non-interactive"], dir);
    const url = out.match(/https:\/\/expo\.dev\/accounts\/\S+/g)?.pop();
    return { ok: true, result: { url, sha: commit, log: out.slice(-1500) } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(0, 1500), sha: commit } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
  }
}

/** Ejecuta un comando y devuelve su salida; falla con las últimas líneas si el código no es 0. */
function exec([cmd, ...args]: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: "1" } });
    let out = "";
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-200_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGTERM"), OTA_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.slice(0, 2).join(" ")} terminó con código ${code}:\n${out.slice(-1200)}`));
    });
  });
}
