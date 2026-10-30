import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { VERSION } from "./assets.js";
import { SECRET_PATTERNS } from "./git.js";

// Diagnósticos de Backcode: cuando algo falla por Backcode (no por el proyecto) y quien usa el runner activó «Enviar
// diagnósticos a Backcode» en su perfil, se manda un informe limpio a diagnostics/{id} (firestore.rules). La Function
// onDiagnostic los agrupa por huella y convierte cada fallo distinto en una tarea del proyecto Backcode.
// Nada sale sin pasar por sanitize(): sin rutas personales, sin el nombre del repo ni su remoto, sin correos, y si queda
// algo que parezca un secreto el informe se descarta entero (mejor no enviar que enviar un token).

export type DiagnosticKind = "backcode" | "unsure";
export type DeploySource = "detected" | "config" | "script";

export interface DiagnosticContext {
  /** El error vino de una excepción (no de un resultado `{ ok: false }` que el propio runner preparó). */
  thrown: boolean;
  /** Despliegue: de dónde salió el comando (deploy-detect.ts, backcode.toml o un script del proyecto). */
  source?: DeploySource;
}

export interface DiagnosticPayload {
  runnerVersion: string;
  platform: string;
  action: string;
  kind: DiagnosticKind;
  source?: DeploySource;
  provider?: string;
  message: string;
  log?: string;
  fingerprint: string;
}

/** Lo que tiene que saber sanitize() de este ordenador para quitarlo. */
export interface SanitizeContext {
  repoPath?: string;
  worktreesDir?: string;
  remoteUrl?: string;
  home?: string;
}

const MESSAGE_MAX = 500;
const LOG_MAX = 3000;

/** Cabecera de `act.execFailed` (el comando del proyecto terminó con error) en es/en/ca. */
const EXEC_FAILED = /^.+ (terminó con código|exited with code|ha acabat amb el codi) -?\d+:/m;

/** Fallos de nuestro código: excepciones de JavaScript y de Node que no vienen de la salida de un comando. */
const INTERNAL = /\b(TypeError|ReferenceError|RangeError|SyntaxError|AssertionError)\b|Cannot read propert(y|ies) of (undefined|null)|is not a function|is not iterable|Maximum call stack|FirebaseError|ERR_[A-Z_]{4,}/;

/**
 * Fallos del proyecto o del ordenador, no de Backcode: sesión y permisos de una herramienta, red, cuota, disco, tests que
 * fallan, dependencias sin lockfile, herramientas sin instalar. Esos no se envían nunca.
 */
const NOT_OURS = new RegExp(
  [
    "not logged in|log ?in (again|first)|re-?authenticat|unauthori[sz]ed|forbidden|permission denied|access denied|invalid_grant|credentials?|authenticat(e|ion) (failed|required|error)|\\b40[13]\\b|token (has )?expired|expired token|EACCES|EPERM",
    "ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|getaddrinfo|network (error|is unreachable)|offline",
    // Caídas del servidor remoto (GitHub, la plataforma del despliegue): p. ej. `! [remote rejected] HEAD -> main (Internal Server Error)`.
    "internal server error|bad gateway|service unavailable|gateway time-?out|\\b50[234]\\b|try again later",
    "rate.?limit|usage limit|quota|\\b429\\b|overloaded|\\b529\\b",
    "ENOSPC|no space left",
    "tests? (failed|failing)|\\d+ failing|test suites?: \\d+ failed|npm ci.*(lockfile|package-lock)|can only install with an existing package-lock|update your lock ?file|missing from lock ?file|are in sync",
    "command not found|not recognized as an internal|could not determine executable",
  ].join("|"),
  "i",
);

/**
 * ¿Es de Backcode? `backcode`: una excepción del runner (no la salida de un comando del proyecto) o un error interno de
 * JavaScript; `unsure`: un despliegue cuyo comando eligió Backcode (detectado o de backcode.toml) y que falló al
 * ejecutarse; null: del proyecto o del ordenador, no se envía. Ante la duda entre del proyecto y nuestro, null.
 */
export function classify(error: string, ctx: DiagnosticContext): DiagnosticKind | null {
  const text = error.trim();
  if (!text || NOT_OURS.test(text)) return null;
  const exec = EXEC_FAILED.test(text);
  if (!exec && INTERNAL.test(text)) return "backcode";
  if (!exec && ctx.thrown) return "backcode";
  if (exec && (ctx.source === "detected" || ctx.source === "config")) return "unsure";
  return null;
}

/** Más amplio que SECRET_PATTERNS (lo que se revisa antes de subir código): aquí cualquier sospecha descarta el informe. */
const DIAG_SECRETS: RegExp[] = [
  ...SECRET_PATTERNS.map(([re]) => re),
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /\bnpm_[A-Za-z0-9]{30,}/, // npm
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /\bATBB[A-Za-z0-9_-]{16,}|\bATATT[A-Za-z0-9_-]{16,}/, // Bitbucket / Atlassian
  /\bya29\.[A-Za-z0-9_-]{10,}/, // Google OAuth
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // URL con usuario y contraseña
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
  // clave=valor con nombre de secreto (los marcadores que pone sanitize, como <email>, no cuentan)
  /\b[A-Za-z0-9_]*(api[_-]?key|secret|token|passw(or)?d|pwd|private[_-]?key|access[_-]?key|auth(?!ors?\b))[A-Za-z0-9_]*\s*[:=]\s*["']?(?!<)[^\s"']{6,}/i,
  /\b[0-9a-f]{41,}\b/i, // tokens hexadecimales largos (los sha de git, de 40, se quitan antes como <hash>)
];

/** ¿Hay algo que parezca un secreto? */
export function looksSecret(text: string): boolean {
  return DIAG_SECRETS.some((re) => re.test(text));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Limpia un texto antes de que salga del ordenador: worktrees → `<worktree>/…`, el repo → `<repo>/…`, rutas personales
 * → `~/…`, el remoto y el nombre del repo → `<remote>` / `<repo>`, correos → `<email>`, sha de git → `<hash>`. Devuelve
 * null si después de limpiar queda algo que parezca un secreto: entonces no se envía nada.
 */
export function sanitize(text: string, ctx: SanitizeContext = {}): string | null {
  let s = text.replace(ANSI, "").replace(/\r/g, "");
  // Antes y después de limpiar: un reemplazo (p. ej. el de correos en «usuario:clave@host») podría tapar un secreto.
  if (looksSecret(s)) return null;
  const home = ctx.home ?? homedir();
  if (ctx.worktreesDir) s = s.replace(new RegExp(`${escape(ctx.worktreesDir)}/[^/\\s]+`, "g"), "<worktree>");
  s = s.replace(/(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.backcode\/worktrees\/[^/\s]+\/[^/\s]+/g, "<worktree>");
  if (ctx.repoPath) s = s.replaceAll(ctx.repoPath, "<repo>");
  if (home && home.length > 1) s = s.replaceAll(home, "~");
  s = s
    .replace(/\/(Users|home)\/[^/\s]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "~")
    .replace(/\/root\b/g, "~");
  if (ctx.remoteUrl) s = s.replaceAll(ctx.remoteUrl, "<remote>");
  // Cualquier remoto de git (github, bitbucket, gitlab): ni dueño ni repo.
  s = s.replace(/\b(git@|https?:\/\/)(www\.)?(github\.com|bitbucket\.org|gitlab\.com)[:/][^\s"')]+/gi, "<remote>");
  const repoName = ctx.repoPath ? basename(ctx.repoPath) : "";
  if (repoName.length >= 3) s = s.replace(new RegExp(`\\b${escape(repoName)}\\b`, "gi"), "<repo>");
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  // sha de git (completos): no dicen nada fuera de este repo.
  s = s.replace(/\b[0-9a-f]{40}\b/g, "<hash>");
  return looksSecret(s) ? null : s;
}

/** Normaliza para la huella: sin rutas, números de línea, hashes, ids ni comillas que cambian de una vez a otra. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/<(worktree|repo|remote|email|hash)>[^\s]*/g, "<$1>")
    .replace(/(~|\.{0,2})?\/[^\s:'"`)]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+/g, "n")
    .replace(/["'`«»“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Huella de un fallo (32 hex): igual para el mismo fallo en otro ordenador, otra carpeta u otra línea. */
export function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.map(normalize).join("|")).digest("hex").slice(0, 32);
}

/** Lo que identifica el fallo: la cabecera del comando que falló (si la hay) y la línea con la causa. */
export function summarize(error: string): string {
  const lines = error.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  const header = EXEC_FAILED.test(lines[0]) ? lines[0] : "";
  const rest = header ? lines.slice(1) : lines;
  const cause = [...rest].reverse().find((l) => /^(✘|✗|✖|×|error\b|fatal:)|\b(error|failed|exception|does not exist|not found|cannot|can't)\b/i.test(l)) ?? (header ? rest.at(-1) : rest[0]) ?? "";
  return [header, cause].filter(Boolean).join("\n").slice(0, MESSAGE_MAX);
}

/**
 * Prepara el informe (o null si no es de Backcode o no se puede limpiar). `error` y `log` son los del resultado de la
 * acción (o de la tarea); `provider`, la plataforma del despliegue (wrangler…).
 */
export function buildReport(input: { action: string; error: string; log?: string; provider?: string } & DiagnosticContext, ctx: SanitizeContext): DiagnosticPayload | null {
  const kind = classify(input.error, input);
  if (!kind) return null;
  const message = sanitize(summarize(input.error), ctx);
  const full = sanitize([input.error, input.log].filter(Boolean).join("\n").trim(), ctx);
  if (!message || full === null) return null;
  const log = full.length > LOG_MAX ? full.slice(-LOG_MAX) : full;
  const provider = input.provider && /^[a-z0-9-]{1,32}$/.test(input.provider) ? input.provider : undefined;
  return {
    runnerVersion: VERSION.slice(0, 32),
    platform: `${process.platform}-${process.arch}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32),
    action: /^[A-Za-z]{1,32}$/.test(input.action) ? input.action : "other",
    kind,
    ...(input.source ? { source: input.source } : {}),
    ...(provider ? { provider } : {}),
    message: message.slice(0, MESSAGE_MAX),
    ...(log && log !== message ? { log } : {}),
    fingerprint: fingerprint([input.action, input.source ?? "", provider ?? "", message]),
  };
}

const HOUR = 60 * 60_000;
const sent = new Map<string, number>();

/**
 * Envía el informe si quien usa el runner lo permite (`shareDiagnostics` del perfil, que sigue Store.watchLang) y si no
 * se envió ya ese mismo fallo en la última hora desde este proceso. Nunca lanza: un fallo al enviar no es noticia.
 */
export async function report(store: { shareDiagnostics: boolean; sendDiagnostic(data: DiagnosticPayload): Promise<void> }, payload: DiagnosticPayload | null): Promise<boolean> {
  if (!payload || !store.shareDiagnostics) return false;
  const now = Date.now();
  if (now - (sent.get(payload.fingerprint) ?? 0) < HOUR) return false;
  sent.set(payload.fingerprint, now);
  try {
    await store.sendDiagnostic(payload);
    return true;
  } catch {
    return false;
  }
}
