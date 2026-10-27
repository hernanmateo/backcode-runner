import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunnerConfig } from "./config.js";
import { createDetachedWorktree, findExpoApp, isAncestor, remoteHead, removeWorktree } from "./git.js";
import type { Checks, PrHost } from "./hosts.js";
import type { Store } from "./store.js";

// Acciones que pide un admin desde la app y ejecuta su runner con sus credenciales (gh / Bitbucket / EAS):
// mergear el PR de una tarea o publicar un OTA de Expo (EAS Update o el script `ota:publish` del repo, p. ej. xprem). Los comandos son fijos: nunca los decide Claude.

export interface Action {
  type: "merge" | "ota" | "openPr";
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
  if (action.type === "openPr") return openPr(cfg, store, host, action.featureId ?? "");
  return publishOta(cfg, store, host, action.channel ?? "preview", action.message ?? "Backcode");
}

/** Abre el PR de una tarea cuya rama ya está subida (p. ej. hecha en modo "solo rama"), sin ejecutar a Claude. */
async function openPr(cfg: RunnerConfig, store: Store, host: PrHost | undefined, featureId: string) {
  if (!host) return { ok: false, result: { error: "Tu runner no tiene PRs configurados (GitHub o Bitbucket con token): configúralo en Conectar" } };
  const f = await store.featureInfo(featureId);
  if (f.prUrl?.startsWith("https://")) return { ok: true, result: { url: f.prUrl } };
  if (!f.branch) return { ok: false, result: { error: "La tarea no tiene rama" } };
  const body = `${f.summary || f.refinedPrompt}\n\n---\nBackcode feature \`${featureId}\` · rama \`${f.branch}\`\n\n🤖 Generado por Backcode runner con [Claude Code](https://claude.com/claude-code)`;
  const url = await host.openOrUpdatePr({ cwd: cfg.repoPath, branch: f.branch, base: cfg.baseBranch, title: f.title, body });
  await store.setPrUrl(featureId, url);
  return { ok: true, result: { url } };
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

/** En xprem la rama de producción es `prod` (el canal `production` del binario apunta a ella). */
const SCRIPT_BRANCH: Record<string, string> = { production: "prod", preview: "preview" };

async function publishOta(cfg: RunnerConfig, store: Store, host: PrHost | undefined, channel: "preview" | "production", message: string) {
  const commit = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const app = await findExpoApp(cfg.repoPath, commit);
  if (!app) return { ok: false, result: { error: "El repositorio no es una app Expo con eas.json" } };
  if (!app.ota) return { ok: false, result: { error: OTA_MISSING } };
  if (!app.channels.includes(channel)) return { ok: false, result: { error: `El canal ${channel} no está en eas.json` } };
  if (host) {
    const blocked = requireGreen(await host.commitChecks(commit), `${cfg.baseBranch} (${commit.slice(0, 7)})`);
    if (blocked) return { ok: false, result: blocked };
  }

  const wt = await createDetachedWorktree(cfg.repoPath, cfg.worktreesDir, "_ota", commit);
  const dir = join(wt, app.appDir);
  const repoAppDir = join(cfg.repoPath, app.appDir);
  try {
    // Dependencias con el gestor del repo (lockfile en la app o en la raíz del monorepo).
    const has = (f: string) => existsSync(join(dir, f)) || existsSync(join(wt, f));
    const frozen = { pnpm: ["pnpm", "install", "--frozen-lockfile"], yarn: ["yarn", "install", "--frozen-lockfile"], bun: ["bun", "install", "--frozen-lockfile"], npm: ["npm", "ci"] }[app.pm];
    const installDir = existsSync(join(dir, "package.json")) && !has("pnpm-workspace.yaml") ? dir : wt;
    await exec(frozen, installDir);

    let out: string;
    if (app.ota === "script") {
      // El script del repo (p. ej. xprem) lee sus secretos de los .env locales (ignorados por git) y recuerda la
      // última publicación en .expo/ para su guarda de cambios nativos: se copian a la copia limpia y se devuelven.
      await copyLocalFiles(cfg.repoPath, wt, [".env", ".env.local", join(app.appDir, ".env"), join(app.appDir, ".env.local")]);
      copyLastPublish(repoAppDir, dir);
      const branch = SCRIPT_BRANCH[channel] ?? channel;
      // --yes: la confirmación ya se hizo en la app. Nunca --allow-native ni porcentajes: si el script se niega, se
      // muestra su motivo.
      const args = ["run", "ota:publish", ...(app.pm === "npm" ? ["--"] : []), branch, "--yes", "-m", message.slice(0, 200)];
      out = await exec([app.pm, ...args], dir);
      copyLastPublish(dir, repoAppDir);
    } else {
      // Siempre al 100 % y para todas las plataformas (sin despliegue gradual).
      out = await exec(["npx", "--yes", "eas-cli@latest", "update", "--channel", channel, "--environment", channel, "--message", message.slice(0, 200), "--platform", "all", "--non-interactive"], dir);
    }
    const url = out.match(/https:\/\/expo\.dev\/accounts\/\S+/g)?.pop();
    // Las tareas cuyo merge va en este commit quedan "desplegadas" en el canal.
    for (const f of await store.mergedNotDeployed(channel).catch(() => [])) {
      if (await isAncestor(cfg.repoPath, f.sha, commit)) await store.markDeployed(f.id, channel, commit).catch(() => undefined);
    }
    return { ok: true, result: { url, sha: commit, log: out.slice(-1500) } };
  } catch (err) {
    return { ok: false, result: { error: String((err as Error).message).slice(-3000), sha: commit } };
  } finally {
    await removeWorktree(cfg.repoPath, wt);
    // Por si git no pudo quitarla: la copia lleva los .env copiados.
    rmSync(wt, { recursive: true, force: true });
  }
}

export const OTA_MISSING =
  "La app no tiene OTA configurado: ni EAS Update (updates.url en u.expo.dev; se activa con `npx eas-cli update:configure`) ni un script `ota:publish` propio en su package.json.";

/** Copia ficheros locales ignorados por git (p. ej. .env con el token del servidor de OTA) a la copia limpia. */
async function copyLocalFiles(repo: string, wt: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const from = join(repo, p);
    if (!existsSync(from) || existsSync(join(wt, p))) continue;
    const ignored = await new Promise<boolean>((resolve) => spawn("git", ["check-ignore", "-q", p], { cwd: repo }).on("close", (code) => resolve(code === 0)));
    if (!ignored) continue;
    copyFileSync(from, join(wt, p));
    chmodSync(join(wt, p), 0o600);
  }
}

function copyLastPublish(fromAppDir: string, toAppDir: string): void {
  const from = join(fromAppDir, ".expo");
  if (!existsSync(from)) return;
  for (const f of readdirSync(from).filter((n) => n.startsWith("eoas-last-publish-"))) {
    mkdirSync(join(toAppDir, ".expo"), { recursive: true });
    copyFileSync(join(from, f), join(toAppDir, ".expo", f));
  }
}

/** Ejecuta un comando y devuelve su salida; falla con las últimas líneas si el código no es 0. */
function exec([cmd, ...args]: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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
      else reject(new Error(`${cmd} ${args.slice(0, 2).join(" ")} terminó con código ${code}:\n${out.slice(-2800)}`));
    });
  });
}
