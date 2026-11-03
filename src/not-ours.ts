// Fallos que no son de Backcode (del plan de Claude Code, del presupuesto, del proyecto, del ordenador…): no se envían
// como diagnóstico y la app explica el motivo en la tarea.
// OJO: este fichero está copiado tal cual en functions/src/not-ours.ts (onDiagnostic descarta lo mismo para los
// runners antiguos). Si cambias uno, cambia el otro: test/diagnostics.test.ts comprueba que son iguales.

/**
 * Por qué un fallo no es de Backcode: el plan de Claude Code (límite de 5 h/semanal), el presupuesto de la tarea, la
 * sesión o los permisos de una herramienta, la red, una caída del servidor remoto, el estado del repo en
 * GitHub/Bitbucket, el ordenador (disco, herramientas sin instalar), el propio proyecto (tests, lockfiles) o un error que
 * Claude Code devolvió haciendo la tarea.
 */
export type NotOursCategory = "plan" | "budget" | "credentials" | "network" | "remote" | "repo" | "environment" | "project" | "claude";

/** En orden: el primero que encaja da la categoría (el plan antes que las credenciales, el repo antes que la red…). */
export const NOT_OURS_RULES: [NotOursCategory, RegExp][] = [
  ["plan", /hit your (5-hour |five[ -]hour |weekly |usage |session |opus |sonnet )?limit|limit · resets|claude ai usage limit|(5-hour|weekly) limit|rate.?limit|usage limit|quota|\b429\b|overloaded|\b529\b/i],
  ["budget", /max(imum)? budget|budget exceeded|max(imum)?[ _-]turns/i],
  [
    "repo",
    /validation failed|\bHTTP 422\b|a pull request already exists|no commits between|protected branch|branch is protected|\bGH006\b|repository (was |is )?archived|archived (repository|repo)|repo is archived|not accessible by integration|integration (does not|doesn't) have (access|permission)/i,
  ],
  [
    "credentials",
    /not logged in|log ?in (again|first)|re-?authenticat|unauthori[sz]ed|forbidden|permission denied|access denied|invalid_grant|credentials?|authenticat(e|ion) (failed|required|error)|\b40[13]\b|token (has )?expired|expired token|EACCES|EPERM/i,
  ],
  ["network", /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|getaddrinfo|network (error|is unreachable)|offline/i],
  // Caídas del servidor remoto (GitHub, la plataforma del despliegue): p. ej. `! [remote rejected] HEAD -> main (Internal Server Error)`.
  ["remote", /internal server error|bad gateway|service unavailable|gateway time-?out|\b50[234]\b|try again later/i],
  ["environment", /ENOSPC|no space left|command not found|not recognized as an internal|could not determine executable/i],
  [
    "project",
    /tests? (failed|failing)|\d+ failing|test suites?: \d+ failed|npm ci.*(lockfile|package-lock)|can only install with an existing package-lock|update your lock ?file|missing from lock ?file|are in sync|lockfile had changes, but lockfile is frozen|frozen[- ]lockfile|ERR_PNPM_OUTDATED_LOCKFILE|yarn\.lock.*needs to be updated|lockfile needs to be updated/i,
  ],
];

/** Errores que Claude Code devuelve como resultado (no excepciones nuestras): del plan, del presupuesto o de la tarea. */
const CLAUDE_RESULT = /Claude Code returned an error result/i;

/** Lo que sí delata un fallo nuestro aunque venga dentro del resultado de Claude Code. */
const INTERNAL_IN_RESULT = /\b(TypeError|ReferenceError|RangeError|SyntaxError|AssertionError)\b|Cannot read propert(y|ies) of (undefined|null)|is not a function|is not iterable|Maximum call stack|FirebaseError/;

/** ¿Por qué no es de Backcode? null si no encaja con nada conocido (puede que lo sea). */
export function notOurs(error: string | null | undefined): NotOursCategory | null {
  const text = String(error ?? "").trim();
  if (!text) return null;
  for (const [category, re] of NOT_OURS_RULES) if (re.test(text)) return category;
  if (CLAUDE_RESULT.test(text) && !INTERNAL_IN_RESULT.test(text)) return "claude";
  return null;
}
