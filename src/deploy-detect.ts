// Despliegues que el runner reconoce solo, sin que el repo declare un script `backcode:deploy:<nombre>`:
// - Cloudflare Workers: un wrangler.jsonc / wrangler.json / wrangler.toml → «<carpeta>» (`wrangler deploy`) y, si tiene
//   una base de datos D1 con migraciones, «<carpeta>-db» (`wrangler d1 migrations apply <db> --remote`), que va antes.
// - Supabase: supabase/config.toml → «supabase-db» (`supabase db push`, las migraciones) si hay supabase/migrations/*.sql,
//   y «supabase-functions» (`supabase functions deploy`) si hay supabase/functions/.
// - Firebase: firebase.json → «firebase-rules» (reglas e índices de Firestore y Storage) y «firebase-functions».
// Solo se mira lo versionado en git (no se ejecuta nada al detectar), y una plataforma no se detecta si el repo ya
// declara algún `backcode:deploy:*` que la use (así no salen dos botones para lo mismo).
// Si el package.json de esa carpeta ya tiene un script que hace ese despliegue (p. ej. "deploy": "npm run build &&
// wrangler deploy"), se ejecuta ese script y no el comando a secas: suele preparar algo antes (PokéScan genera su catálogo).

export type DeployProvider = "wrangler" | "supabase" | "firebase";

export interface AutoDeploy {
  name: string;
  dir: string;
  provider: DeployProvider;
  /** Comando, sin shell (se ejecuta en la carpeta `dir` de una copia limpia de la rama principal). */
  cmd: string[];
  /** El script del package.json de esa carpeta que ya hace este despliegue: se ejecuta ese (`<pm> run <script>`). */
  script?: string;
  /** Orden en el plan: 0 bases de datos y reglas, 1 functions, 2 servidores/webs. */
  rank: number;
  /** Rutas (prefijos, relativas al repo) cuyos cambios lo dejan pendiente de desplegar. */
  paths: string[];
  /** Ficheros locales ignorados por git que necesita (p. ej. el enlace de Supabase), relativos a `dir`. */
  local?: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const join = (dir: string, p: string) => (dir ? `${dir}/${p}` : p).replace(/\/+/g, "/").replace(/\/$/, "");

/** El comando de un script declarado, ¿qué plataforma usa? (para no duplicarla y para la ayuda si falla). */
export function providerOfCommand(command: string): DeployProvider | null {
  if (/\bwrangler\b/.test(command)) return "wrangler";
  if (/\bsupabase\b/.test(command)) return "supabase";
  if (/\bfirebase(-tools)?\b/.test(command)) return "firebase";
  return null;
}

/** JSON con comentarios (wrangler.jsonc): quita // y /* *\/ fuera de cadenas y las comas finales. */
function parseJsonc(text: string): Record<string, unknown> | null {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** La primera base de datos D1 del config (nombre y carpeta de migraciones). */
function d1Of(config: string, file: string): { name: string; migrations: string } | null {
  if (file.endsWith(".toml")) {
    const block = /\[\[d1_databases\]\]([\s\S]*?)(?=\n\s*\[|$)/.exec(config)?.[1] ?? "";
    const name = /database_name\s*=\s*"([^"]+)"/.exec(block)?.[1];
    return name ? { name, migrations: /migrations_dir\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? "migrations" } : null;
  }
  const json = parseJsonc(config);
  const db = (Array.isArray(json?.d1_databases) ? json.d1_databases[0] : null) as { database_name?: unknown; migrations_dir?: unknown } | null;
  return typeof db?.database_name === "string" ? { name: db.database_name, migrations: typeof db.migrations_dir === "string" ? db.migrations_dir : "migrations" } : null;
}

/** Los scripts del package.json de una carpeta (si lo hay). */
async function scriptsIn(dir: string, files: string[], show: (path: string) => Promise<string>): Promise<Record<string, string>> {
  const pkg = join(dir, "package.json");
  if (!files.includes(pkg)) return {};
  try {
    const scripts = (JSON.parse(await show(pkg)) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return Object.fromEntries(Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** El script que ya hace ese despliegue: el que se llama como el preferido, o el primero cuyo comando encaja. */
function scriptFor(scripts: Record<string, string>, re: RegExp, preferred: string[]): string | undefined {
  const matches = Object.keys(scripts).filter((k) => !k.startsWith("backcode:") && re.test(scripts[k]));
  return preferred.find((p) => matches.includes(p)) ?? matches[0];
}

export async function detectDeploys(files: string[], show: (path: string) => Promise<string>, declared: Set<DeployProvider>): Promise<AutoDeploy[]> {
  const out: AutoDeploy[] = [];
  const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
  const hasUnder = (prefix: string, re: RegExp) => files.some((f) => f.startsWith(`${prefix}/`) && re.test(f));

  if (!declared.has("wrangler")) {
    const configs = files.filter((f) => /(^|\/)wrangler\.(jsonc|json|toml)$/.test(f));
    for (const file of configs.slice(0, 5)) {
      const dir = dirOf(file);
      const base = slug(dir.split("/").pop() || "worker") || "worker";
      const config = await show(file).catch(() => "");
      const scripts = await scriptsIn(dir, files, show);
      const d1 = d1Of(config, file);
      if (d1 && /^[\w.-]{1,100}$/.test(d1.name) && hasUnder(join(dir, d1.migrations), /\.sql$/)) {
        const script = scriptFor(scripts, /\bwrangler\s+d1\s+migrations\s+apply\b[^&|;]*--remote\b/, ["db:migrate", "migrate"]);
        out.push({ name: `${base}-db`, dir, provider: "wrangler", cmd: ["npx", "--yes", "wrangler", "d1", "migrations", "apply", d1.name, "--remote"], ...(script ? { script } : {}), rank: 0, paths: [join(dir, d1.migrations)] });
      }
      const script = scriptFor(scripts, /\bwrangler\s+deploy\b/, ["deploy"]);
      out.push({ name: base, dir, provider: "wrangler", cmd: ["npx", "--yes", "wrangler", "deploy"], ...(script ? { script } : {}), rank: 2, paths: [dir] });
    }
  }

  if (!declared.has("supabase")) {
    const config = files.find((f) => /(^|\/)supabase\/config\.toml$/.test(f));
    if (config) {
      const dir = dirOf(dirOf(config));
      const sb = join(dir, "supabase");
      // El enlace al proyecto (`supabase link`) vive en supabase/.temp, ignorado por git: se copia de tu repo.
      const local = ["supabase/.temp/project-ref", "supabase/.temp/pooler-url", "supabase/.temp/postgres-version"];
      const scripts = await scriptsIn(dir, files, show);
      const dbScript = scriptFor(scripts, /\bsupabase\s+db\s+push\b/, ["db:push", "migrate"]);
      const fnScript = scriptFor(scripts, /\bsupabase\s+functions\s+deploy\b/, ["functions:deploy", "deploy:functions"]);
      if (hasUnder(`${sb}/migrations`, /\.sql$/)) out.push({ name: "supabase-db", dir, provider: "supabase", cmd: ["npx", "--yes", "supabase", "db", "push", "--linked", "--yes"], ...(dbScript ? { script: dbScript } : {}), rank: 0, paths: [`${sb}/migrations`], local });
      if (hasUnder(`${sb}/functions`, /\.(ts|js|tsx|mjs)$/)) out.push({ name: "supabase-functions", dir, provider: "supabase", cmd: ["npx", "--yes", "supabase", "functions", "deploy", "--yes"], ...(fnScript ? { script: fnScript } : {}), rank: 1, paths: [`${sb}/functions`], local });
    }
  }

  if (!declared.has("firebase")) {
    const config = files.find((f) => /(^|\/)firebase\.json$/.test(f) && !f.includes("node_modules/"));
    if (config) {
      const dir = dirOf(config);
      const json = parseJsonc(await show(config).catch(() => "")) ?? {};
      const scripts = await scriptsIn(dir, files, show);
      const rules = [json.firestore ? "firestore" : "", json.storage ? "storage" : ""].filter(Boolean);
      if (rules.length) {
        const paths = files.filter((f) => /(^|\/)(firestore\.rules|firestore\.indexes\.json|storage\.rules)$/.test(f) && f.startsWith(dir));
        const script = scriptFor(scripts, /\bfirebase(-tools)?\s+deploy\b[^&|;]*--only\s+[\w:,]*(firestore|storage)/, ["deploy:rules", "rules"]);
        out.push({ name: "firebase-rules", dir, provider: "firebase", cmd: ["npx", "--yes", "firebase-tools", "deploy", "--only", rules.join(","), "--non-interactive"], ...(script ? { script } : {}), rank: 0, paths: paths.length ? paths : [join(dir, "firestore.rules")] });
      }
      if (json.functions) {
        const fns = Array.isArray(json.functions) ? (json.functions[0] as { source?: unknown } | undefined) : (json.functions as { source?: unknown });
        const source = typeof fns?.source === "string" ? fns.source : "functions";
        const script = scriptFor(scripts, /\bfirebase(-tools)?\s+deploy\b[^&|;]*--only\s+[\w:,]*functions/, ["deploy:functions", "functions:deploy"]);
        out.push({ name: "firebase-functions", dir, provider: "firebase", cmd: ["npx", "--yes", "firebase-tools", "deploy", "--only", "functions", "--non-interactive"], ...(script ? { script } : {}), rank: 1, paths: [join(dir, source)] });
      }
    }
  }
  return out.filter((d) => NAME_RE.test(d.name));
}
