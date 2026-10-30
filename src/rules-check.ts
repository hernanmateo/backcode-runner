import { execFile } from "node:child_process";
import { posix } from "node:path";
import { firebaseRulesParts } from "./deploy-log.js";
import { type DeployTarget, git } from "./git.js";

// Reglas de Firebase: comprobación real. Para un paso de reglas que no está al día, el runner pregunta a Firebase Rules
// qué reglas están publicadas (Firestore y Storage) y las compara con las del repo en la punta de la rama principal: si
// coinciden, el paso está al día aunque lo haya desplegado cualquiera desde donde sea.
// El token es el de `gcloud auth print-access-token` (si gcloud está instalado y con sesión): se usa solo en memoria y
// nunca se escribe. Sin gcloud no se comprueba nada (nunca se leen a mano los ficheros de credenciales de firebase-tools).
// Los índices de Firestore no se pueden comprobar así: si el paso los cubre, solo cuenta si no han cambiado desde el
// último despliegue apuntado.

const API = "https://firebaserules.googleapis.com/v1";

export function gcloudToken(): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("gcloud", ["auth", "print-access-token", "--quiet"], { timeout: 15_000 }, (err, out) => {
      const token = String(out ?? "").trim();
      resolve(!err && /^[\w.~+/=-]{20,4096}$/.test(token) ? token : null);
    }),
  );
}

interface FirebaseConfig {
  dir: string;
  firestoreRules?: string;
  firestoreIndexes?: string;
  storageRules?: string;
  project?: string;
}

/** El firebase.json más cercano a la carpeta del destino (ella o hacia arriba) y el proyecto por defecto de .firebaserc. */
async function firebaseConfig(repoPath: string, commit: string, from: string): Promise<FirebaseConfig | null> {
  const show = (p: string) => git(repoPath, ["show", `${commit}:${p}`]).catch(() => null);
  const parts = from ? from.split("/") : [];
  for (let i = parts.length; i >= 0; i--) {
    const dir = parts.slice(0, i).join("/");
    const text = await show(dir ? `${dir}/firebase.json` : "firebase.json");
    if (text === null) continue;
    let json: { firestore?: { rules?: unknown; indexes?: unknown }; storage?: unknown };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return null;
    }
    const storage = (Array.isArray(json.storage) ? (json.storage.length === 1 ? json.storage[0] : null) : json.storage) as { rules?: unknown } | null | undefined;
    const path = (v: unknown) => (typeof v === "string" ? posix.normalize(dir ? `${dir}/${v}` : v) : undefined);
    let project: string | undefined;
    try {
      project = (JSON.parse((await show(dir ? `${dir}/.firebaserc` : ".firebaserc")) ?? "{}") as { projects?: { default?: string } }).projects?.default;
    } catch {
      // sin .firebaserc legible
    }
    return { dir, firestoreRules: path(json.firestore?.rules), firestoreIndexes: path(json.firestore?.indexes), storageRules: path(storage?.rules), project };
  }
  return null;
}

/** GET a Firebase Rules. Con credenciales de usuario (gcloud) la API pide un proyecto de cuota: el propio proyecto. */
async function api(project: string, path: string, token: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${API}/${path}`, { headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** El contenido publicado del ruleset de una release (un solo fichero), o null si no se puede saber. */
async function publishedSource(project: string, release: string, token: string): Promise<string | null> {
  const r = await api(project, `projects/${project}/releases/${release}`, token);
  const ruleset = typeof r?.rulesetName === "string" && /^projects\/[a-z0-9-]+\/rulesets\/[\w-]+$/.test(r.rulesetName) ? r.rulesetName : null;
  if (!ruleset) return null;
  const files = ((await api(project, ruleset, token))?.source as { files?: { content?: unknown }[] } | undefined)?.files ?? [];
  return files.length === 1 && typeof files[0].content === "string" ? files[0].content : null;
}

/** La release de Storage del proyecto (`firebase.storage/<bucket>`), si solo hay una. */
async function storageRelease(project: string, token: string): Promise<string | null> {
  const list = ((await api(project, `projects/${project}/releases?pageSize=100`, token))?.releases ?? []) as { name?: unknown }[];
  const names = list.map((r) => String(r.name ?? "")).filter((n) => n.startsWith(`projects/${project}/releases/firebase.storage/`));
  return names.length === 1 ? names[0].slice(`projects/${project}/releases/`.length) : null;
}

const same = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();

/**
 * ¿Las reglas publicadas en Firebase son las del repo en `base`? true solo si todo lo que cubre el destino coincide;
 * null si no es un destino de reglas o no se puede comprobar (sin gcloud, sin acceso, índices que han cambiado…).
 */
export async function rulesPublished(opts: { repoPath: string; base: string; target: DeployTarget; lastSha?: string; token: () => Promise<string | null> }): Promise<boolean | null> {
  const parts = firebaseRulesParts(opts.target);
  if (!parts) return null;
  const cfg = await firebaseConfig(opts.repoPath, opts.base, opts.target.dir);
  const project = opts.target.env?.project ?? cfg?.project;
  if (!cfg || !project || !/^[a-z0-9-]{4,40}$/.test(project)) return null;
  const wants = (what: "firestore" | "storage", sub: "rules" | "indexes") => parts.some((p) => p === what || p === `${what}:${sub}`);
  if (wants("firestore", "indexes") && cfg.firestoreIndexes) {
    if (!opts.lastSha) return null;
    const changed = await git(opts.repoPath, ["diff", "--name-only", opts.lastSha, opts.base, "--", cfg.firestoreIndexes]).catch(() => null);
    if (changed !== "") return null;
  }
  const checks: { release: () => Promise<string | null>; file: string }[] = [];
  if (wants("firestore", "rules")) {
    if (!cfg.firestoreRules) return null;
    checks.push({ release: async () => "cloud.firestore", file: cfg.firestoreRules });
  }
  if (wants("storage", "rules")) {
    if (!cfg.storageRules) return null;
    checks.push({ release: () => storageRelease(project, token!), file: cfg.storageRules });
  }
  if (!checks.length) return null;
  const token = await opts.token();
  if (!token) return null;
  for (const c of checks) {
    const release = await c.release();
    const [published, local] = await Promise.all([release ? publishedSource(project, release, token) : null, git(opts.repoPath, ["show", `${opts.base}:${c.file}`]).catch(() => null)]);
    if (published === null || local === null) return null;
    if (!same(published, local)) return false;
  }
  return true;
}
