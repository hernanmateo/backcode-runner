// Poner al día un PR que va por detrás de la rama base antes de mergearlo con la CI del host. Sus checks corrieron contra
// una base vieja: lo que se mergeó después (p. ej. otro PR de «Mergear todo») no se probó junto a él. Se mezcla la base en
// la rama en una copia aparte, se sube (sin forzar) y la CI vuelve a correr sobre el commit nuevo, que es lo que se espera
// antes de mergear. Con checks en local no hace falta subir nada: se comprueba el commit mezclado en local (mergedCommit).
import { createDetachedWorktree, git, gitPush, isAncestor, mergeBaseIntoBranch, removeWorktree } from "./git.js";

export interface PrUpdate {
  /** uptodate: ya contenía la base; merged: se mezcló y se subió (`sha`); conflicts: choca (`files`), no se sube nada. */
  status: "uptodate" | "merged" | "conflicts";
  sha?: string;
  files: string[];
}

/** Mezcla `<remote>/<base>` en la rama del PR y la sube si iba por detrás. Lanza si falla el push (alguien subió a la vez). */
export async function updateBehindPr(o: { repoPath: string; worktreesDir: string; remote: string; base: string; branch: string; name: string }): Promise<PrUpdate> {
  await git(o.repoPath, ["fetch", "--quiet", o.remote, o.base, `+${o.branch}:refs/remotes/${o.remote}/${o.branch}`]);
  if (await isAncestor(o.repoPath, `${o.remote}/${o.base}`, `${o.remote}/${o.branch}`)) return { status: "uptodate", files: [] };
  const path = await createDetachedWorktree(o.repoPath, o.worktreesDir, `_update-${o.name}`, `${o.remote}/${o.branch}`);
  try {
    const sync = await mergeBaseIntoBranch(path, o.remote, o.base);
    if (sync.status === "conflicts") {
      await git(path, ["merge", "--abort"]).catch(() => undefined);
      return { status: "conflicts", files: sync.files };
    }
    if (sync.status === "uptodate") return { status: "uptodate", files: [] };
    const sha = await git(path, ["rev-parse", "HEAD"]);
    // Sin forzar: si alguien subió a la rama mientras tanto, falla y no se pisa nada.
    await gitPush(path, ["--no-verify", o.remote, `HEAD:refs/heads/${o.branch}`]);
    return { status: "merged", sha, files: [] };
  } finally {
    await removeWorktree(o.repoPath, path);
  }
}

/**
 * Espera a que el host vea `sha` como cabeza del PR (si no, sus checks serían aún los del commit anterior, en verde) y da
 * true; false si no lo ve en `timeoutMs`. Sin forma de leerlo (`read` ausente), espera `timeoutMs / 3` y da true.
 */
export async function waitHostHead(read: (() => Promise<string>) | undefined, sha: string, opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 3000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!read) {
    await sleep(Math.round(timeoutMs / 3));
    return true;
  }
  for (let waited = 0; ; waited += pollMs) {
    if ((await read().catch(() => "")) === sha) return true;
    if (waited >= timeoutMs) return false;
    await sleep(pollMs);
  }
}
