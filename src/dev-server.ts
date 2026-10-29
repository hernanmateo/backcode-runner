import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyLocalFiles, installFrozen, profileEnv, type ActionResult } from "./actions.js";
import type { RunnerConfig } from "./config.js";
import { HOME_DIR } from "./paths.js";
import { adbPath, listDevices } from "./devices.js";
import { findExpoApp, git, remoteHead } from "./git.js";
import { t } from "./i18n.js";
import type { Store } from "./store.js";

// «Versión de desarrollo» en tu móvil: la build Debug que instala «Instalar en mi móvil» carga el JavaScript de un
// Metro en tu ordenador, y este módulo lo arranca con el código que elijas: la rama principal o una tarea (su copia de
// trabajo si está en este ordenador, para ver los cambios de Claude mientras trabaja; si no, su rama subida). Cambiar de
// código = reiniciar Metro y volver a abrir la app. Un Metro por proyecto, en un puerto propio (el de su build Debug).

const START_MS = 5 * 60_000;
/** Se apaga solo pasado este tiempo (un Metro olvidado no se queda escuchando en la red para siempre). */
const MAX_MS = 4 * 60 * 60_000;

/** Puerto de Metro del proyecto: fijo (la build Debug lo lleva dentro) y distinto para cada proyecto. */
export function devPort(projectId: string): number {
  return 8100 + (createHash("sha256").update(projectId).digest().readUInt16BE(0) % 800);
}

export interface DevState {
  state: "starting" | "running" | "stopped" | "error";
  source: "base" | "feature";
  featureId?: string;
  title?: string;
  sha?: string;
  port: number;
  error?: string;
}

let metro: ChildProcess | undefined;
let stopTimer: NodeJS.Timeout | undefined;

/**
 * En qué móviles está instalada la versión de desarrollo de cada proyecto (la instaló este runner; una normal encima la
 * quita). Para que la app no ofrezca «Probar en mi móvil» sin tenerla, y lo diga.
 */
const DEV_INSTALLS = join(HOME_DIR, "dev-installs.json");
export function devInstalls(): Record<string, Record<string, boolean>> {
  try {
    return JSON.parse(readFileSync(DEV_INSTALLS, "utf8")) as Record<string, Record<string, boolean>>;
  } catch {
    return {};
  }
}
export function recordDevInstall(projectId: string, deviceId: string, dev: boolean): void {
  const all = devInstalls();
  all[projectId] = { ...all[projectId], [deviceId]: dev };
  try {
    writeFileSync(DEV_INSTALLS, JSON.stringify(all, null, 2) + "\n");
  } catch {
    // sin permisos en ~/.backcode: no se recuerda
  }
}

/**
 * Qué servía Metro (por proyecto), para volver a arrancarlo si el runner se reinicia (p. ej. al actualizarse justo
 * después de instalar la versión de desarrollo, el móvil se quedaba con «Could not connect to development server»).
 */
const SERVING = join(HOME_DIR, "dev-serving.json");
type Serving = { featureId?: string; since: number };
function rememberServe(projectId: string, serving: Serving | null): void {
  let all: Record<string, Serving> = {};
  try {
    all = JSON.parse(readFileSync(SERVING, "utf8")) as Record<string, Serving>;
  } catch {
    // aún no hay nada
  }
  if (serving) all[projectId] = serving;
  else delete all[projectId];
  try {
    writeFileSync(SERVING, JSON.stringify(all, null, 2) + "\n");
  } catch {
    // sin permisos en ~/.backcode: no se recuerda
  }
}

/** Al arrancar el runner: si Metro estaba sirviendo algo (y no hace más de 4 h), se vuelve a arrancar igual. */
export async function resumeDevServer(cfg: RunnerConfig, store: Store): Promise<void> {
  let serving: Serving | undefined;
  try {
    serving = (JSON.parse(readFileSync(SERVING, "utf8")) as Record<string, Serving>)[cfg.projectId];
  } catch {
    return;
  }
  if (!serving) return;
  if (Date.now() - serving.since > MAX_MS) return rememberServe(cfg.projectId, null);
  const { ok, result } = await devServe(cfg, store, serving.featureId);
  if (!ok) console.warn(`[dev] ${result.error ?? ""}`);
}

export const devServerRunning = () => !!metro && metro.exitCode === null;

export function stopDevServer(): void {
  clearTimeout(stopTimer);
  if (metro?.pid) {
    try {
      process.kill(-metro.pid, "SIGTERM"); // todo el grupo (npx → node → expo)
    } catch {
      metro.kill("SIGTERM");
    }
  }
  metro = undefined;
}

/** Para Metro y lo apunta (para la app). */
export async function devStop(cfg: RunnerConfig, store: Store): Promise<{ ok: boolean; result: ActionResult }> {
  stopDevServer();
  rememberServe(cfg.projectId, null);
  await store.saveDevState({ state: "stopped", source: "base", port: devPort(cfg.projectId) }).catch(() => undefined);
  return { ok: true, result: { log: t("dev.stopped") } };
}

/** Arranca (o cambia) Metro con la rama principal o con una tarea. */
export async function devServe(cfg: RunnerConfig, store: Store, featureId?: string): Promise<{ ok: boolean; result: ActionResult }> {
  const port = devPort(cfg.projectId);
  stopDevServer();
  let state: DevState = { state: "starting", source: featureId ? "feature" : "base", port, ...(featureId ? { featureId } : {}) };
  const save = (patch: Partial<DevState>) => {
    state = { ...state, ...patch };
    return store.saveDevState(state).catch(() => undefined);
  };
  try {
    const head = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
    const app = await findExpoApp(cfg.repoPath, head);
    if (!app) throw new Error(t("build.notExpo"));

    // Qué código: la copia de trabajo de la tarea en este ordenador (en vivo) o una copia propia (_dev) en el commit pedido.
    let root: string;
    let sha: string;
    if (featureId) {
      if (!/^[A-Za-z0-9]{1,64}$/.test(featureId)) throw new Error(t("git.badFeatureId", { id: featureId }));
      const f = await store.featureInfo(featureId);
      await save({ title: f.title.slice(0, 120) });
      const local = join(cfg.worktreesDir, featureId);
      if (existsSync(join(local, ".git"))) {
        root = local;
        sha = await git(local, ["rev-parse", "HEAD"]);
      } else {
        if (!f.branch) throw new Error(t("dev.noBranch"));
        await git(cfg.repoPath, ["fetch", "--quiet", cfg.remote, f.branch]);
        sha = await git(cfg.repoPath, ["rev-parse", "FETCH_HEAD"]);
        root = await devWorktree(cfg, sha);
      }
    } else {
      await git(cfg.repoPath, ["fetch", "--quiet", cfg.remote, cfg.baseBranch]);
      sha = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
      root = await devWorktree(cfg, sha);
    }
    await save({ sha });
    const dir = join(root, app.appDir);
    // Dependencias: solo si faltan o cambió el lockfile (cambiar de rama en _dev suele no tocarlas).
    const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map((f) => [join(dir, f), join(root, f)]).flat().find((f) => existsSync(f));
    const lockHash = lock ? createHash("sha256").update(readFileSync(lock)).digest("hex") : "";
    const stamp = join(root, "node_modules", ".backcode-lock");
    if (!existsSync(join(root, "node_modules")) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== lockHash) {
      await installFrozen(app, root, dir);
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(stamp, lockHash);
    }
    await copyLocalFiles(cfg.repoPath, root, [".env", ".env.local", join(app.appDir, ".env"), join(app.appDir, ".env.local")]);

    // Sin CI=1: con él Metro no vigila los ficheros y los cambios no llegarían al móvil. EXPO_NO_TYPESCRIPT_SETUP: sin
    // él, Expo reescribe el tsconfig.json al arrancar, y en la copia de trabajo de una tarea ensuciaría los cambios de Claude.
    const env = { ...process.env, ...profileEnv(dir, "development"), CI: "", EXPO_NO_TELEMETRY: "1", EXPO_NO_TYPESCRIPT_SETUP: "1" };
    delete (env as Record<string, string | undefined>).CI;
    const child = spawn("npx", ["expo", "start", "--port", String(port), "--host", "lan"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    metro = child;
    let out = "";
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-20_000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("exit", (code) => {
      if (metro !== child) return;
      metro = undefined;
      void save({ state: code === 0 || code === null ? "stopped" : "error", ...(code ? { error: out.replace(/\x1b\[[0-9;]*m/g, "").slice(-1500) } : {}) });
    });

    const ready = await waitForMetro(port, child, START_MS);
    if (!ready) {
      stopDevServer();
      throw new Error(t("dev.notStarted", { log: out.replace(/\x1b\[[0-9;]*m/g, "").slice(-1500) }));
    }
    // Android: túnel de adb al puerto de Metro en los móviles conectados (se pierde al reconectarlos).
    const adb = adbPath();
    if (adb) for (const d of (await listDevices().catch(() => [])).filter((x) => x.platform === "android" && x.state === "ready")) await adbReverse(adb, d.id, port);
    stopTimer = setTimeout(() => void devStop(cfg, store), MAX_MS);
    stopTimer.unref();
    await save({ state: "running", error: undefined });
    rememberServe(cfg.projectId, { featureId, since: Date.now() });
    console.log(`[dev] ${t("dev.running", { port, what: featureId ? (state.title ?? featureId) : cfg.baseBranch })}`);
    return { ok: true, result: { sha, log: t("dev.running", { port, what: featureId ? (state.title ?? featureId) : cfg.baseBranch }) } };
  } catch (err) {
    const error = String((err as Error).message).slice(-3000);
    await save({ state: "error", error: error.slice(-1500) });
    return { ok: false, result: { error } };
  }
}

/** Copia propia para Metro (_dev): se reutiliza (con su node_modules) y solo se mueve al commit pedido. */
async function devWorktree(cfg: RunnerConfig, sha: string): Promise<string> {
  const path = join(cfg.worktreesDir, "_dev");
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(cfg.worktreesDir, { recursive: true });
    await git(cfg.repoPath, ["worktree", "prune"]);
    await git(cfg.repoPath, ["worktree", "add", "--detach", path, sha]);
  } else {
    await git(path, ["reset", "--hard", "--quiet"]);
    await git(path, ["checkout", "--detach", "--quiet", sha]);
  }
  return path;
}

async function waitForMetro(port: number, child: ChildProcess, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    const ok = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(3_000) })
      .then((r) => r.text())
      .then((text) => text.includes("packager-status:running"), () => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/** Android: el móvil llega a Metro por el túnel de adb (también por wifi); la build Debug lo busca en su puerto. */
export async function adbReverse(adb: string, serial: string, port: number): Promise<void> {
  await new Promise<void>((resolve) => spawn(adb, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], { stdio: "ignore" }).on("close", () => resolve()));
}
