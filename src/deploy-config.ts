// Despliegues declarados en backcode.toml (o backcode.json), sin rastro de JavaScript: para repos de Python, Go, C… que
// no tienen package.json. El runner ejecuta el comando tal cual en una copia limpia de la rama principal, sin `npm ci` ni
// `npm run`, así que no hace falta Node en ese ordenador. Puede haber uno en la raíz o en cualquier carpeta.
//
//   [deploy.api]
//   run = "make deploy"          # el comando (con sh -c) o una lista ["make", "deploy"] (sin shell)
//   dir = "server"               # opcional: carpeta, relativa al fichero; por defecto la del fichero
//   kind = "service"             # migration (va primero) · functions · service (por defecto, después)
//   paths = ["server/"]          # opcional: qué cambios lo dejan pendiente; por defecto, su carpeta
//
// Si un nombre también está en un package.json (backcode:deploy:<nombre>) en la misma carpeta, gana este fichero.

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS = { migration: 0, functions: 1, service: 2 } as const;

export interface ConfigDeploy {
  name: string;
  /** Carpeta donde se ejecuta, relativa al repo. */
  dir: string;
  cmd: string[];
  rank: number;
  paths: string[];
}

export interface ConfigResult {
  deploys: ConfigDeploy[];
  /** Problemas del fichero, con su línea: se avisan en el registro del runner en vez de ignorarlos en silencio. */
  errors: string[];
}

type Value = string | number | boolean | string[];

/** TOML justo para este fichero: tablas [a.b], claves = cadena, número, booleano o lista de cadenas, y comentarios. */
export function parseToml(text: string): { tables: Record<string, Record<string, Value>>; errors: string[] } {
  const tables: Record<string, Record<string, Value>> = {};
  const errors: string[] = [];
  let current: Record<string, Value> | null = null;
  const lines = text.split(/\r?\n/);
  const stripComment = (line: string) => {
    let inString: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        if (ch === "\\" && inString === '"') i++;
        else if (ch === inString) inString = null;
      } else if (ch === '"' || ch === "'") inString = ch;
      else if (ch === "#") return line.slice(0, i);
    }
    return line;
  };
  const parseString = (raw: string): string | null => {
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return null;
      }
    }
    return null;
  };
  lines.forEach((original, i) => {
    const line = stripComment(original).trim();
    if (!line) return;
    const table = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (table) {
      current = tables[table[1]] ??= {};
      return;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv || !current) {
      errors.push(`línea ${i + 1}: ${original.trim().slice(0, 80)}`);
      return;
    }
    const raw = kv[2].trim();
    let value: Value | null = null;
    if (raw === "true" || raw === "false") value = raw === "true";
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (raw.startsWith("[") && raw.endsWith("]")) {
      const items = raw.slice(1, -1).trim();
      const parts = items ? items.split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map((p) => p.trim()).filter(Boolean) : [];
      const strings = parts.map(parseString);
      value = strings.every((s): s is string => s !== null) ? strings : null;
    } else value = parseString(raw);
    if (value === null) errors.push(`línea ${i + 1}: ${original.trim().slice(0, 80)}`);
    else current[kv[1]] = value;
  });
  return { tables, errors };
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
const inside = (p: string) => !p.split("/").includes("..") && !p.startsWith("/");

/** Los despliegues de un backcode.toml / backcode.json (en `fileDir`, relativo al repo). */
export function readDeployConfig(fileDir: string, fileName: string, text: string): ConfigResult {
  const errors: string[] = [];
  let entries: [string, Record<string, unknown>][] = [];
  if (fileName.endsWith(".json")) {
    try {
      const json = JSON.parse(text) as { deploy?: Record<string, Record<string, unknown>> };
      entries = Object.entries(json.deploy ?? {});
    } catch (err) {
      return { deploys: [], errors: [`${(err as Error).message.slice(0, 120)}`] };
    }
  } else {
    const parsed = parseToml(text);
    errors.push(...parsed.errors);
    entries = Object.entries(parsed.tables)
      .filter(([k]) => k.startsWith("deploy."))
      .map(([k, v]) => [k.slice("deploy.".length), v]);
  }
  const deploys: ConfigDeploy[] = [];
  for (const [name, d] of entries) {
    if (!NAME_RE.test(name)) {
      errors.push(`[deploy.${name}]: nombre no válido (minúsculas, números y guiones)`);
      continue;
    }
    const run = d.run;
    const cmd = typeof run === "string" && run.trim() ? ["sh", "-c", run] : Array.isArray(run) && run.length && run.every((x) => typeof x === "string" && x) ? (run as string[]) : null;
    if (!cmd) {
      errors.push(`[deploy.${name}]: falta «run» (un comando o una lista)`);
      continue;
    }
    const sub = typeof d.dir === "string" ? norm(d.dir) : "";
    const dir = norm([fileDir, sub].filter(Boolean).join("/"));
    if (!inside(sub) || !inside(dir)) {
      errors.push(`[deploy.${name}]: «dir» tiene que estar dentro del repo`);
      continue;
    }
    const kind = d.kind === undefined ? "service" : d.kind;
    if (typeof kind !== "string" || !(kind in KINDS)) {
      errors.push(`[deploy.${name}]: «kind» es migration, functions o service`);
      continue;
    }
    const paths = Array.isArray(d.paths) && d.paths.every((p) => typeof p === "string") ? (d.paths as string[]).map((p) => norm([fileDir, p].filter(Boolean).join("/"))).filter(inside) : [dir];
    deploys.push({ name, dir, cmd, rank: KINDS[kind as keyof typeof KINDS], paths });
  }
  return { deploys, errors };
}
