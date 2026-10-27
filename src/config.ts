import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { setLangOverride, t } from "./i18n.js";

/** Carpeta del kit (donde están .env e instructions/). Claude nunca puede leerla. */
export const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const num = z.coerce.number().positive();

// Todo sale del .env local. Firestore nunca decide rutas, remotos, dominios ni límites.
const Env = z.object({
  BACKCODE_FIREBASE_API_KEY: z.string().min(1),
  BACKCODE_FIREBASE_AUTH_DOMAIN: z.string().optional(),
  BACKCODE_FIREBASE_PROJECT_ID: z.string().min(1),
  // Bucket de Storage (adjuntos de las tareas). Proyectos nuevos: <id>.firebasestorage.app.
  BACKCODE_FIREBASE_STORAGE_BUCKET: z.string().optional(),
  BACKCODE_FUNCTIONS_REGION: z.string().default("us-central1"),
  BACKCODE_USE_EMULATORS: z.enum(["0", "1"]).default("0"),
  BACKCODE_RUNNER_KEY: z.string().regex(/^[A-Za-z0-9]{1,128}\.[A-Za-z0-9_-]{43}$/, t("cfg.badKey")),
  BACKCODE_PROJECT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, t("cfg.badProject")),
  BACKCODE_REPO_PATH: z.string().min(1),
  BACKCODE_BASE_BRANCH: z.string().regex(/^[A-Za-z0-9._\/-]+$/).default("main"),
  /** Solo para `npm run connect`: de dónde clonar el repo si aún no está en BACKCODE_REPO_PATH. */
  BACKCODE_REPO_URL: z.string().optional(),
  BACKCODE_REMOTE: z.string().regex(/^[A-Za-z0-9._-]+$/).default("origin"),
  // "github": push + PR en borrador con gh. "push-only": solo push de la rama (repos sin GitHub o pruebas).
  BACKCODE_PULL_REQUEST: z.enum(["github", "bitbucket", "push-only"]).default("github"),
  // Bitbucket Cloud: email de la cuenta Atlassian + API token con permisos de repositorio y pull requests.
  // Se quedan en este ordenador: los usa el runner (nunca Claude) para abrir y mergear PRs.
  BACKCODE_BITBUCKET_EMAIL: z.string().optional(),
  BACKCODE_BITBUCKET_TOKEN: z.string().optional(),
  BACKCODE_MODEL: z.string().optional(),
  BACKCODE_MAX_TURNS: num.default(80),
  BACKCODE_MAX_BUDGET_USD: num.default(5),
  BACKCODE_TIMEOUT_MINUTES: num.default(45),
  BACKCODE_MAX_ATTEMPTS: num.default(2),
  // Mapa del repositorio para que la IA que prepara los encargos conozca el proyecto.
  BACKCODE_KNOWLEDGE: z.enum(["auto", "off"]).default("auto"),
  BACKCODE_KNOWLEDGE_MODEL: z.string().default("haiku"),
  BACKCODE_ALLOWED_DOMAINS: z.string().default("registry.npmjs.org"),
  BACKCODE_PROTECTED_PATHS: z.string().default(""),
  // Idioma del runner (por defecto, el de tu perfil en la app).
  BACKCODE_LANG: z.enum(["es", "en", "ca"]).optional(),
});

/** Variables que admite el .env (las únicas que acepta `npm run connect`). */
export const ENV_KEYS = Object.keys(Env.shape);

/** baseBranch y pullRequest se ajustan al arrancar según el repo real (checkRepo). */
export interface RunnerConfig {
  firebase: { apiKey: string; authDomain?: string; projectId: string; storageBucket: string };
  functionsRegion: string;
  emulators: boolean;
  runnerKey: string;
  projectId: string;
  repoPath: string;
  baseBranch: string;
  remote: string;
  pullRequest: "github" | "bitbucket" | "push-only";
  bitbucket?: { email: string; token: string };
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMinutes: number;
  maxAttempts: number;
  knowledge: "auto" | "off";
  knowledgeModel: string;
  allowedDomains: string[];
  protectedPaths: string[];
  worktreesDir: string;
  runnerId: string;
  envFile: string;
}

/** Carga el .env del kit (o el indicado en BACKCODE_ENV_FILE / --env <fichero>). */
export function loadConfig(): RunnerConfig {
  const argIdx = process.argv.indexOf("--env");
  const envFile = resolve(KIT_DIR, argIdx > 0 ? process.argv[argIdx + 1] : process.env.BACKCODE_ENV_FILE ?? ".env");
  if (!existsSync(envFile)) {
    throw new Error(t("cfg.noEnv", { file: envFile }));
  }
  // El .env contiene tu runner key: no debe ser legible por otros usuarios del sistema.
  if ((statSync(envFile).mode & 0o077) !== 0) {
    throw new Error(t("cfg.perms", { file: envFile }));
  }
  process.loadEnvFile(envFile);
  // Variables vacías en el .env = usar el valor por defecto.
  setLangOverride(process.env.BACKCODE_LANG);
  const parsed = Env.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  · ${i.path.join(".")}: ${i.message === "Invalid input: expected string, received undefined" ? t("cfg.missing") : i.message}`);
    throw new Error(`${t("cfg.review", { file: envFile })}\n${problems.join("\n")}`);
  }
  const env = parsed.data;

  // Los secretos se retiran del entorno del proceso: así nunca llegan a Claude ni a sus comandos.
  for (const key of Object.keys(process.env)) if (key.startsWith("BACKCODE_")) delete process.env[key];

  return {
    firebase: { apiKey: env.BACKCODE_FIREBASE_API_KEY, authDomain: env.BACKCODE_FIREBASE_AUTH_DOMAIN, projectId: env.BACKCODE_FIREBASE_PROJECT_ID, storageBucket: env.BACKCODE_FIREBASE_STORAGE_BUCKET || `${env.BACKCODE_FIREBASE_PROJECT_ID}.appspot.com` },
    functionsRegion: env.BACKCODE_FUNCTIONS_REGION,
    emulators: env.BACKCODE_USE_EMULATORS === "1",
    runnerKey: env.BACKCODE_RUNNER_KEY,
    projectId: env.BACKCODE_PROJECT_ID,
    repoPath: realpathSync(env.BACKCODE_REPO_PATH.replace(/^~(?=\/)/, homedir())),
    baseBranch: env.BACKCODE_BASE_BRANCH,
    remote: env.BACKCODE_REMOTE,
    pullRequest: env.BACKCODE_PULL_REQUEST,
    bitbucket: env.BACKCODE_BITBUCKET_EMAIL && env.BACKCODE_BITBUCKET_TOKEN ? { email: env.BACKCODE_BITBUCKET_EMAIL, token: env.BACKCODE_BITBUCKET_TOKEN } : undefined,
    model: env.BACKCODE_MODEL || undefined,
    maxTurns: env.BACKCODE_MAX_TURNS,
    maxBudgetUsd: env.BACKCODE_MAX_BUDGET_USD,
    timeoutMinutes: env.BACKCODE_TIMEOUT_MINUTES,
    maxAttempts: env.BACKCODE_MAX_ATTEMPTS,
    knowledge: env.BACKCODE_KNOWLEDGE,
    knowledgeModel: env.BACKCODE_KNOWLEDGE_MODEL,
    allowedDomains: list(env.BACKCODE_ALLOWED_DOMAINS),
    protectedPaths: list(env.BACKCODE_PROTECTED_PATHS),
    worktreesDir: join(homedir(), ".backcode", "worktrees", env.BACKCODE_PROJECT_ID),
    runnerId: `${hostname()}:${process.pid}`,
    envFile,
  };
}
