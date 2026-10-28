// Entorno de Firebase al que apunta un destino de despliegue (`backcode:deploy:<nombre>`), deducido leyendo el script sin
// ejecutarlo: la app lo enseña antes de desplegar («Firebase Hosting · derbi-admin-staging · canal staging») para que quede
// claro a qué proyecto y canal va. Es una lectura estática y acotada: el comando del package.json, un `npm run <otro>` del
// mismo package.json y los scripts de shell del repo a los que llame (con sus argumentos). Si no se ve ningún `firebase`,
// no hay entorno y la app no enseña nada.

export interface FirebaseDeployEnv {
  provider: "firebase";
  /** ID del proyecto de Firebase (de `-P`/`--project`, resolviendo alias de .firebaserc, o el `default` de .firebaserc). */
  project?: string;
  /** Hosting: nombre del canal de preview (`hosting:channel:deploy <canal>`) o `live` (`firebase deploy` con hosting). */
  channel?: string;
  /** Valor de `--only` si no incluye hosting (functions, firestore:rules…). */
  only?: string;
}

export interface DeployEnvContext {
  /** Scripts del mismo package.json, para seguir `npm run <otro>`. */
  scripts: Record<string, string>;
  /** Alias de .firebaserc (`projects`) más cercano a la carpeta del destino; null si no hay. */
  firebaserc: Record<string, string> | null;
  /** Contenido de un fichero del repo (ruta relativa a la carpeta del destino) o null si no existe. */
  readFile: (path: string) => Promise<string | null>;
}

const MAX_DEPTH = 3;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Entorno de Firebase del comando de un destino, o null si no llama a `firebase`. */
export async function firebaseDeployEnv(command: string, ctx: DeployEnvContext): Promise<FirebaseDeployEnv | null> {
  const found = await collect(command, [], ctx, 0, new Set());
  if (!found.length) return null;
  // Si un script sirve para varias cosas (p. ej. canal con argumento y producción sin él), gana la forma que encaja con
  // los argumentos que se le pasan: con argumentos, el canal; sin ellos, el sitio principal.
  const withArgs = found.some((f) => f.fromArgs);
  const pick = found.find((f) => f.env.channel && f.env.channel !== "live" && withArgs) ?? found.find((f) => f.env.channel) ?? found[0];
  return pick.env;
}

interface Found {
  env: FirebaseDeployEnv;
  /** El canal/proyecto salió de un argumento posicional ($1…) del script. */
  fromArgs: boolean;
}

async function collect(command: string, args: string[], ctx: DeployEnvContext, depth: number, seen: Set<string>): Promise<Found[]> {
  if (depth > MAX_DEPTH) return [];
  const out: Found[] = [];
  let alias: string | undefined;
  for (const segment of splitSegments(command)) {
    const { words, usedArgs, unresolved } = substitute(tokenize(segment), args);
    if (!words.length) continue;
    const [head, ...rest] = words;
    // `npx firebase …` y `firebase …` son lo mismo para esto.
    const fb = head === "firebase" ? rest : head === "npx" && rest[0] === "firebase" ? rest.slice(1) : null;
    if (fb) {
      if (fb[0] === "use" && fb[1]) {
        alias = fb[1];
        continue;
      }
      if (unresolved) continue;
      const env = parseFirebase(fb, alias, ctx.firebaserc);
      if (env) out.push({ env, fromArgs: usedArgs });
      continue;
    }
    // `npm run <otro> [-- args]` del mismo package.json.
    if (RUNNERS.has(head) && rest[0] === "run" && rest[1] && ctx.scripts[rest[1]] && !seen.has(rest[1])) {
      const extra = rest.slice(2).filter((w) => w !== "--");
      out.push(...(await collect(ctx.scripts[rest[1]], extra, ctx, depth + 1, new Set([...seen, rest[1]]))));
      continue;
    }
    // Un script de shell del repo: `./scripts/deploy.sh staging`, `bash scripts/deploy.sh`, `sh …`.
    const file = head === "bash" || head === "sh" || head === "zsh" ? rest[0] : head;
    const fileArgs = head === "bash" || head === "sh" || head === "zsh" ? rest.slice(1) : rest;
    if (file && /^\.?\.?\/?[\w./-]+\.(sh|bash|zsh)$/.test(file)) {
      const body = await ctx.readFile(file.replace(/^\.\//, ""));
      if (body) out.push(...(await collect(body, fileArgs, ctx, depth + 1, seen)));
    }
  }
  return out;
}

/** Comando `firebase …` ya troceado: deploy (hosting o no) o hosting:channel:deploy. */
function parseFirebase(words: string[], alias: string | undefined, firebaserc: Record<string, string> | null): FirebaseDeployEnv | null {
  let project: string | undefined;
  let only: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-P" || w === "--project") project = words[++i];
    else if (w.startsWith("--project=")) project = w.slice("--project=".length);
    else if (w === "--only") only = words[++i];
    else if (w.startsWith("--only=")) only = w.slice("--only=".length);
    else if (w === "--expires" || w === "--token" || w === "--config" || w === "-c" || w === "--message" || w === "-m") i++;
    else if (!w.startsWith("-")) positional.push(w);
  }
  const resolved = resolveProject(project ?? alias, firebaserc);
  if (positional[0] === "hosting:channel:deploy" && positional[1]) return { provider: "firebase", project: resolved, channel: positional[1] };
  if (positional[0] !== "deploy") return null;
  const targets = (only ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const hosting = !targets.length || targets.some((s) => s === "hosting" || s.startsWith("hosting:"));
  return hosting ? { provider: "firebase", project: resolved, channel: "live" } : { provider: "firebase", project: resolved, only: targets.join(",") };
}

/** `-P staging` puede ser un alias de .firebaserc; sin `-P`, el `default` de .firebaserc. */
function resolveProject(name: string | undefined, firebaserc: Record<string, string> | null): string | undefined {
  if (name) return firebaserc?.[name] ?? name;
  return firebaserc?.default;
}

/** Trozos de un comando: separados por `&&`, `||`, `;` o saltos de línea (los comentarios de shell se ignoran). */
function splitSegments(command: string): string[] {
  return command
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .flatMap((l) => l.split(/\s*(?:&&|\|\||;)\s*/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Palabras de un comando respetando comillas (simple: sin escapes anidados). */
function tokenize(segment: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/** Sustituye `$1`, `${1}`, `$@`, `$*` por los argumentos; `usedArgs` si alguno entró, `unresolved` si falta alguno. */
function substitute(words: string[], args: string[]): { words: string[]; usedArgs: boolean; unresolved: boolean } {
  let usedArgs = false;
  let unresolved = false;
  const out: string[] = [];
  for (const w of words) {
    if (w === "$@" || w === "$*") {
      if (args.length) usedArgs = true;
      out.push(...args);
      continue;
    }
    const replaced = w.replace(/\$\{?([1-9])\}?/g, (_, n: string) => {
      const v = args[Number(n) - 1];
      if (v === undefined) unresolved = true;
      else usedArgs = true;
      return v ?? "";
    });
    out.push(replaced);
  }
  return { words: out.filter((w) => w !== ""), usedArgs, unresolved };
}
