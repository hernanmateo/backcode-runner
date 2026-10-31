import type { RunnerConfig } from "./config.js";
import { lastCliPublish } from "./ota-watch.js";
import { type DeployTarget, type ExpoApp, git, remoteHead, isAncestor } from "./git.js";
import { includedTasks } from "./deploy-tasks.js";
import { BUILD_PLATFORMS, type BuildPlatform, nativeDependencyChanges, nativeFilesByPlatform } from "./native-changes.js";
import type { Store } from "./store.js";

// «Pendiente de desplegar»: qué hay en la rama base que aún no ha salido por cada vía (reglas, functions, web… y la OTA),
// en el orden en que hay que desplegarlo (primero lo que la app nueva necesita en el servidor: reglas, luego functions,
// luego el resto y la OTA al final). Cada paso se compara con el commit de su último despliegue hecho desde Backcode.

export interface PlanStep {
  /** `deploy:<carpeta>#<nombre>` o `ota:<canal>`: lo que se pide al desplegar. */
  id: string;
  kind: "deploy" | "ota";
  name: string;
  /** Qué cubre (para la app): reglas, functions, la app… */
  covers: string;
  /** pending: hay cambios desde el último; upToDate: nada nuevo; unknown: nunca se desplegó desde Backcode. */
  status: "pending" | "upToDate" | "unknown";
  /** Commit del último despliegue de este paso. */
  lastSha?: string;
  /** Ficheros cambiados desde entonces que le afectan. */
  changes?: number;
  /** Tareas mergeadas que traen esos cambios. */
  features?: { id: string; title: string }[];
}

export interface DeployPlan {
  base: string;
  steps: PlanStep[];
  /** La OTA trae cambios que parecen nativos (config de Expo, dependencias, ios/android…): quizá haga falta una build. */
  nativeHint?: boolean;
  /**
   * Builds que faltan: plataformas con cambios nativos en la rama base desde el commit de su última build hecha desde
   * Backcode (una OTA no los lleva). Sin build registrada de una plataforma no se sabe y no sale.
   */
  builds?: BuildStep[];
  /** Builds para testers (app de Expo con perfil production): por plataforma, tareas mergeadas desde su última build. */
  buildTasks?: PlanBuild[];
}

export interface BuildStep {
  platform: BuildPlatform;
  /** Commit de la última build de esa plataforma. */
  lastSha: string;
  /** Ficheros nativos cambiados desde entonces (y los primeros, para enseñarlos). */
  changes: number;
  files: string[];
  features?: { id: string; title: string }[];
}

/** Tareas pendientes de build de una plataforma. */
export interface PlanBuild {
  platform: "ios" | "android";
  /** Commit de la última build hecha bien de esa plataforma; sin él, nunca se hizo desde Backcode y no se sabe qué falta. */
  lastSha?: string;
  /** Cuántas tareas faltan (features va recortada a MAX_PLAN_BUILD_TASKS). */
  count?: number;
  features?: { id: string; title: string }[];
}

/** Como mucho estas tareas por plataforma en el plan (el documento del runner no debe crecer sin límite). */
export const MAX_PLAN_BUILD_TASKS = 30;

/** Tareas mergeadas que van en `base` y no en la última build de cada plataforma (las mismas que entrarían en la siguiente). */
export async function pendingBuilds(
  merged: { id: string; title: string; sha: string }[],
  base: string,
  last: Map<string, string>,
  isAncestor: (ancestor: string, commit: string) => Promise<boolean>,
): Promise<PlanBuild[]> {
  const out: PlanBuild[] = [];
  for (const platform of ["ios", "android"] as const) {
    const lastSha = last.get(`build:${platform}`);
    if (!lastSha) {
      out.push({ platform });
      continue;
    }
    const features = await includedTasks(merged, base, lastSha, isAncestor);
    out.push({ platform, lastSha, count: features.length, features: features.slice(0, MAX_PLAN_BUILD_TASKS) });
  }
  return out;
}

interface Scope {
  covers: string;
  rank: number;
  match: (file: string) => boolean;
}

/** Qué ficheros cubre un despliegue: por el `--only` de Firebase si lo lleva; si no, su carpeta. */
export function scopeOf(target: DeployTarget): Scope {
  // Detectado sin script: su orden (bases de datos y reglas, functions, servidores) y sus carpetas.
  if (target.auto) {
    const paths = target.auto.paths;
    return { covers: paths.join(" + ") || target.dir || "repo", rank: target.auto.rank, match: (f) => paths.some((p) => !p || f === p || f.startsWith(`${p}/`)) };
  }
  const only = target.env?.only?.split(",").map((s) => s.trim().split(":")[0]) ?? [];
  if (only.length && only.every((o) => o === "firestore" || o === "storage")) {
    return { covers: only.join(" + "), rank: 0, match: (f) => (only.includes("firestore") && /(^|\/)firestore\.(rules|indexes\.json)$/.test(f)) || (only.includes("storage") && /(^|\/)storage\.rules$/.test(f)) };
  }
  if (only.length && only.every((o) => o === "functions")) return { covers: "functions", rank: 1, match: (f) => /(^|\/)functions\//.test(f) && !/\.test\.|__tests__/.test(f) };
  // Otro despliegue (web, api…): lo que haya en su carpeta (la del package.json con el script).
  const dir = target.dir ? `${target.dir}/` : "";
  return { covers: target.dir || "repo", rank: 2, match: (f) => !dir || f.startsWith(dir) };
}

const NATIVE = /(^|\/)(app\.json|app\.config\.[cm]?[jt]s|eas\.json|ios\/|android\/|plugins\/|modules\/)/;

export async function computePlan(cfg: RunnerConfig, store: Store, deploys: DeployTarget[], app: ExpoApp | null): Promise<DeployPlan> {
  await git(cfg.repoPath, ["fetch", "--quiet", cfg.remote, cfg.baseBranch]).catch(() => undefined);
  const base = await remoteHead(cfg.repoPath, cfg.remote, cfg.baseBranch);
  const [last, merged] = await Promise.all([store.lastDeploys(), store.mergedFeatures()]);
  // Un OTA publicado desde la terminal también cuenta (el script deja el commit en <app>/.expo): el más reciente gana.
  const cli = app ? lastCliPublish(cfg.repoPath, app.appDir, cfg.baseBranch).production : undefined;
  const fromApp = last.get("ota:production");
  if (cli && (!fromApp || (await isAncestor(cfg.repoPath, fromApp, cli)))) last.set("ota:production", cli);
  const candidates: { id: string; kind: "deploy" | "ota"; name: string; scope: Scope }[] = deploys.map((d) => ({ id: `deploy:${d.id}`, kind: "deploy", name: d.name, scope: scopeOf(d) }));
  if (app?.ota && app.channels.includes("production")) {
    const dir = app.appDir ? `${app.appDir}/` : "";
    candidates.push({ id: "ota:production", kind: "ota", name: "OTA production", scope: { covers: "app", rank: 3, match: (f) => !dir || f.startsWith(dir) } });
  }

  const steps: PlanStep[] = [];
  let nativeHint = false;
  for (const c of candidates.sort((a, b) => a.scope.rank - b.scope.rank || a.name.localeCompare(b.name))) {
    const lastSha = last.get(c.id);
    if (!lastSha) {
      steps.push({ id: c.id, kind: c.kind, name: c.name, covers: c.scope.covers, status: "unknown" });
      continue;
    }
    const files = (await git(cfg.repoPath, ["diff", "--name-only", lastSha, base]).catch(() => "")).split("\n").filter(Boolean).filter(c.scope.match);
    if (!files.length) {
      steps.push({ id: c.id, kind: c.kind, name: c.name, covers: c.scope.covers, status: "upToDate", lastSha });
      continue;
    }
    if (c.kind === "ota" && files.some((f) => NATIVE.test(f))) nativeHint = true;
    const features = await bringing(lastSha, c.scope.match);
    steps.push({ id: c.id, kind: c.kind, name: c.name, covers: c.scope.covers, status: "pending", lastSha, changes: files.length, features });
  }

  // Builds: cambios nativos de la app desde la última build de cada plataforma (las dos suelen compartir commit).
  const builds: BuildStep[] = [];
  for (const platform of app ? BUILD_PLATFORMS : []) {
    const lastSha = last.get(`build:${platform}`);
    if (!app || !lastSha || lastSha === base) continue;
    const changed = (await git(cfg.repoPath, ["diff", "--name-only", lastSha, base]).catch(() => "")).split("\n").filter(Boolean);
    const pkg = `${app.appDir ? `${app.appDir}/` : ""}package.json`;
    const show = (sha: string) => git(cfg.repoPath, ["show", `${sha}:${pkg}`]).catch(() => "");
    const pkgChanged = changed.includes(pkg) && nativeDependencyChanges(await show(lastSha), await show(base)).length > 0;
    const files = nativeFilesByPlatform(changed, app.appDir, pkgChanged)[platform];
    if (!files.length) continue;
    const native = new Set(files);
    builds.push({ platform, lastSha, changes: files.length, files: files.slice(0, 5), features: await bringing(lastSha, (f) => native.has(f)) });
  }
  // Tareas pendientes de build: las mergeadas desde la última build hecha bien de cada plataforma.
  const buildTasks = app?.buildProfiles.includes("production") ? await pendingBuilds(merged, base, last, (a, c) => isAncestor(cfg.repoPath, a, c)) : [];
  return { base, steps: steps.slice(0, 10), ...(nativeHint ? { nativeHint } : {}), ...(builds.length ? { builds } : {}), ...(buildTasks.length ? { buildTasks } : {}) };

  /** Qué tareas lo traen: las mergeadas cuyo commit está entre el último despliegue y la base y tocan esos ficheros. */
  async function bringing(lastSha: string, match: (file: string) => boolean): Promise<{ id: string; title: string }[]> {
    const commits = new Set((await git(cfg.repoPath, ["log", "--format=%H", `${lastSha}..${base}`]).catch(() => "")).split("\n").filter(Boolean));
    const features: { id: string; title: string }[] = [];
    for (const f of merged) {
      if (!commits.has(f.sha) || features.length >= 10) continue;
      const touched = (await git(cfg.repoPath, ["show", "--name-only", "--format=", f.sha]).catch(() => "")).split("\n").filter(Boolean);
      if (touched.some(match)) features.push({ id: f.id, title: f.title.slice(0, 120) });
    }
    return features;
  }
}
