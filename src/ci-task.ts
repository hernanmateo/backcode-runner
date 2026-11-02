// Tarea de CI (feature.kind === "ci"): la excepción acotada a «las tareas no tocan la CI». La crea solo el servidor
// (createCiTask) desde «CI y checks» de la app. El runner no usa el texto de la tarea: el encargo es este prompt fijo.
// El alcance se aplica en el runner (guard.ts › ciScopeMatcher en el hook, en open_pull_request y en el review), sin
// Bash y sin leer ficheros de secretos; el PR nunca se mergea ni se despliega solo (runOne, auto-merge.ts, actions.ts).
import { ciScopeMatcher, isSecretFile } from "./guard.js";

export type CiHost = "github" | "bitbucket";

/** ¿Es una tarea de CI? */
export function isCiTask(feature: { kind?: string }): boolean {
  return feature.kind === "ci";
}

/** Fichero de CI que crea la tarea según el host. */
export function ciFileFor(host: CiHost): string {
  return host === "github" ? ".github/workflows/ci.yml" : "bitbucket-pipelines.yml";
}

/** Herramientas de una tarea de CI: sin Bash ni NotebookEdit (solo leer el repo y escribir el fichero de CI y docs). */
export const CI_TOOLS = ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "TodoWrite"];

/** Alcance de escritura y lectura de una tarea de CI. */
export function ciGuard(host: CiHost, base: (rel: string) => boolean) {
  return { isProtected: ciScopeMatcher(host, base), denyRead: isSecretFile };
}

/** Bloque extra del system prompt: la excepción a la regla de la CI, solo para esta tarea. */
export function ciSystemAppend(host: CiHost): string {
  const file = host === "github" ? "`.github/workflows/*.yml`" : "`bitbucket-pipelines.yml`";
  return `

## CI task exception (this task only)
This is a Backcode CI task. As a narrow exception to the CI/CD rule above, you may create or modify ONLY ${file} and, if useful, documentation (\`docs/**/*.md\` or a root \`*.md\`). Every other path is blocked by the runner, and so are Bash, reading .env files, credentials and keys. Never read, print or ask for secret values. Do not pass afterMerge to open_pull_request: this PR is never merged or deployed automatically; a person reviews it and merges it by hand.`;
}

/** Encargo fijo de la tarea de CI (no depende de lo que diga la tarea en Firestore). */
export function buildCiPrompt(host: CiHost): string {
  const file = ciFileFor(host);
  const hostRules =
    host === "github"
      ? `- Format: GitHub Actions. Create \`${file}\` that runs on \`pull_request\` and on \`push\` to the base branch. Use \`actions/checkout@v4\` and the official setup action for the stack (e.g. \`actions/setup-node@v4\` with the package manager cache).
- Secrets: reference them only by name as \`\${{ secrets.NAME }}\`. They are created in GitHub → Settings → Secrets and variables → Actions → New repository secret, or with \`gh secret set NAME\`.`
      : `- Format: Bitbucket Pipelines. Create \`${file}\` at the repo root with a \`pull-requests: '**'\` pipeline and one for the base branch, using a suitable \`image\` and \`caches\`.
- Secrets: reference them only as \`$NAME\`. They are created in Bitbucket → Repository settings → Repository variables, with "Secured" checked. Remind them that Pipelines must be enabled in Repository settings → Pipelines → Settings.`;
  return `Set up continuous integration (CI) for this repository. This is a fixed task from Backcode's "CI and checks" screen.

Steps:
1. Detect the package manager(s) from the lockfiles (package-lock.json → npm ci, pnpm-lock.yaml → pnpm install --frozen-lockfile, yarn.lock → yarn install --frozen-lockfile, bun.lockb/bun.lock → bun install --frozen-lockfile; or the equivalent for other stacks: Python, Go, Rust…), including sub-projects with their own manifest.
2. Read the real scripts (package.json "scripts" or the equivalent) and use ONLY those that exist among test, lint, typecheck/type-check/tsc and build. Never invent commands or add scripts. If a script needs a running service or a secret to work, leave it out and explain why in the PR.
3. Pick the runtime version from .nvmrc, .node-version, .tool-versions or "engines" when present; otherwise a current LTS.
4. Write the CI file following these rules:
${hostRules}
- Never read .env files or any secret value (the runner blocks it anyway), and never hardcode a credential.
5. Call open_pull_request once. The PR body must have the sections Summary, Changes, How it was tested, and Risks / follow-ups, plus:
   - "What the CI runs": each command and where it comes from (the script in which file).
   - "Secrets you need to create": for each secret the CI references, its name, what it is for, where to create it (${host === "github" ? "Settings → Secrets and variables → Actions" : "Repository settings → Repository variables, marked as Secured"}) and the command to create it yourself${host === "github" ? " (`gh secret set NAME`)" : ""}. Write "None" if there are none. Backcode never copies secret values.
   - A note that this PR is not merged or deployed automatically: review it and merge it by hand.
You can't run commands in this task, so you can't run the checks locally: they run on the PR itself. Write the PR in the language of the people running this task.`;
}
