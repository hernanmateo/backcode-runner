import { posix } from "node:path";

// Red de seguridad al abrir el PR: si cambian las dependencias de un package.json y su lockfile no, el PR rompería la CI
// (que instala con --frozen-lockfile / npm ci) y el lockfile acababa como un paso «a mano» tras mergear. Ahora Claude puede
// instalar dentro del sandbox (dep-cache.ts), así que se le pide que lo regenere antes de abrir el PR.

/** Lockfiles que se reconocen (el más cercano hacia la raíz es el de ese package.json: en un monorepo, el de la raíz). */
export const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json"];

/** Campos de package.json que, si cambian, cambian el lockfile. */
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions", "workspaces", "catalog", "catalogs", "pnpm"];

function depsOf(pkg: string | null): string | null {
  if (pkg === null) return null;
  try {
    const json = JSON.parse(pkg) as Record<string, unknown>;
    return JSON.stringify(DEP_FIELDS.map((f) => [f, json[f] ?? null]));
  } catch {
    return null;
  }
}

/** ¿Cambian las dependencias entre dos versiones de un package.json (null = no existía)? Ilegible: no se sabe → no. */
export function depsChanged(before: string | null, after: string | null): boolean {
  if (after === null) return false;
  const b = depsOf(before);
  const a = depsOf(after);
  if (a === null) return false;
  if (before === null) return JSON.parse(a).some(([, v]: [string, unknown]) => v !== null);
  return b !== a;
}

/** El lockfile de un package.json: el más cercano subiendo carpetas, entre los que hay en el árbol; null si ninguno. */
export function lockfileFor(pkgPath: string, lockfiles: ReadonlySet<string>): string | null {
  let dir = posix.dirname(pkgPath);
  for (;;) {
    for (const name of LOCKFILES) {
      const candidate = dir === "." ? name : `${dir}/${name}`;
      if (lockfiles.has(candidate)) return candidate;
    }
    if (dir === "." || dir === "") return null;
    dir = posix.dirname(dir);
  }
}

/**
 * package.json cuyas dependencias cambian respecto a la base sin que cambie su lockfile. `changed`: ficheros que cambia el
 * PR (respecto a la base, incluido lo que está por commitear); `tree`: todos los ficheros del árbol del PR;
 * `show(rev, path)`: contenido en la base o en el PR (null si no existe).
 */
export async function missingLockfiles(
  changed: string[],
  tree: string[],
  show: (rev: "base" | "head", path: string) => Promise<string | null>,
): Promise<{ pkg: string; lock: string }[]> {
  const lockfiles = new Set(tree.filter((f) => LOCKFILES.includes(posix.basename(f)) && !/(^|\/)node_modules\//.test(f)));
  const changedSet = new Set(changed);
  const out: { pkg: string; lock: string }[] = [];
  for (const pkg of changed.filter((f) => /(^|\/)package\.json$/.test(f) && !/(^|\/)node_modules\//.test(f)).slice(0, 30)) {
    const lock = lockfileFor(pkg, lockfiles);
    if (!lock || changedSet.has(lock)) continue;
    const [before, after] = await Promise.all([show("base", pkg), show("head", pkg)]);
    if (depsChanged(before, after)) out.push({ pkg, lock });
  }
  return out;
}
