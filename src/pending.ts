import type { RunnerConfig } from "./config.js";
import { lastCliPublish } from "./ota-watch.js";
import { type DeployTarget, type ExpoApp, git, remoteHead, isAncestor } from "./git.js";
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
}

interface Scope {
  covers: string;
  rank: number;
  match: (file: string) => boolean;
}

/** Qué ficheros cubre un despliegue: por el `--only` de Firebase si lo lleva; si no, su carpeta. */
function scopeOf(target: DeployTarget): Scope {
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
    // Qué tareas lo traen: las mergeadas cuyo commit está entre el último despliegue y la base y toca estos ficheros.
    const commits = new Set((await git(cfg.repoPath, ["log", "--format=%H", `${lastSha}..${base}`]).catch(() => "")).split("\n").filter(Boolean));
    const features: { id: string; title: string }[] = [];
    for (const f of merged) {
      if (!commits.has(f.sha) || features.length >= 10) continue;
      const touched = (await git(cfg.repoPath, ["show", "--name-only", "--format=", f.sha]).catch(() => "")).split("\n").filter(Boolean);
      if (touched.some(c.scope.match)) features.push({ id: f.id, title: f.title.slice(0, 120) });
    }
    steps.push({ id: c.id, kind: c.kind, name: c.name, covers: c.scope.covers, status: "pending", lastSha, changes: files.length, features });
  }
  return { base, steps: steps.slice(0, 10), ...(nativeHint ? { nativeHint } : {}) };
}
