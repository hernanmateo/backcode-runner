import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readCredentials } from "./credentials.js";
import { setLangOverride, t } from "./i18n.js";
import { HOME_DIR, migrateLegacyConfigs, projectFile, projectFiles, resolveEnvFile } from "./paths.js";

export { KIT_DIR } from "./paths.js";

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
  /** Nombre del proyecto en la app (solo para mostrarlo en el panel). */
  BACKCODE_PROJECT_NAME: z.string().optional(),
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
  // Refinado de ideas con tu Claude Code (si lo activas en la app): buena calidad a buen precio.
  BACKCODE_REFINE_MODEL: z.string().default("sonnet"),
  BACKCODE_ALLOWED_DOMAINS: z.string().default("registry.npmjs.org"),
  BACKCODE_PROTECTED_PATHS: z.string().default(""),
  // Que el ordenador no se duerma: off · working (solo con trabajo en marcha) · always (mientras el runner esté abierto).
  BACKCODE_KEEP_AWAKE: z.enum(["off", "working", "always"]).default("working"),
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
  refineModel: string;
  allowedDomains: string[];
  protectedPaths: string[];
  keepAwake: "off" | "working" | "always";
  worktreesDir: string;
  runnerId: string;
  envFile: string;
}

/**
 * Carga la configuración del proyecto: `--project <id>`, `--env <fichero>` (o BACKCODE_ENV_FILE) o, si en este ordenador
 * solo hay un proyecto conectado, la suya.
 */
export function loadConfig(): RunnerConfig {
  migrateLegacyConfigs();
  const arg = (flag: string) => (process.argv.indexOf(flag) > 0 ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
  const project = arg("--project");
  const envArg = arg("--env") ?? process.env.BACKCODE_ENV_FILE;
  const only = projectFiles();
  const envFile = project ? projectFile(project) : envArg ? resolveEnvFile(envArg) : only.length === 1 ? only[0].file : join(HOME_DIR, "config", ".env");
  if (!existsSync(envFile)) {
    throw new Error(t("cfg.noEnv", { file: envFile }));
  }
  // El .env contiene tu runner key: no debe ser legible por otros usuarios del sistema.
  if ((statSync(envFile).mode & 0o077) !== 0) {
    throw new Error(t("cfg.perms", { file: envFile }));
  }
  // Lector propio (process.loadEnvFile no existe en el ejecutable sin Node): KEY=valor, comentarios y comillas.
  for (const [key, value] of parseEnv(readFileSync(envFile, "utf8"))) if (process.env[key] === undefined) process.env[key] = value;
  // Bitbucket: si el proyecto no trae su token, el de tu cuenta en este ordenador (~/.backcode/config/credentials).
  const account = readCredentials().bitbucket;
  if (account && !process.env.BACKCODE_BITBUCKET_TOKEN) {
    process.env.BACKCODE_BITBUCKET_EMAIL = account.email;
    process.env.BACKCODE_BITBUCKET_TOKEN = account.token;
  }
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
    refineModel: env.BACKCODE_REFINE_MODEL,
    allowedDomains: list(env.BACKCODE_ALLOWED_DOMAINS),
    protectedPaths: list(env.BACKCODE_PROTECTED_PATHS),
    keepAwake: env.BACKCODE_KEEP_AWAKE,
    worktreesDir: join(homedir(), ".backcode", "worktrees", env.BACKCODE_PROJECT_ID),
    runnerId: `${hostname()}:${process.pid}`,
    envFile,
  };
}

/** Variables de un fichero .env: `KEY=valor`, líneas `#` ignoradas, comillas opcionales y `#` final en valores sin comillas. */
export function parseEnv(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"`])(.*)\1$/.exec(value);
    if (quoted) value = quoted[1] === '"' ? quoted[2].replace(/\\n/g, "\n") : quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    out.push([m[1], value]);
  }
  return out;
}
