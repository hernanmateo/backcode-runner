// Cambio de ejecutor (reassignFeature en functions): un admin pasa una tarea parada al runner de otra persona.
//
// La sesión de Claude Code no viaja (es un fichero de este ordenador), así que lo que importa es que el código llegue:
// - Punto de guardado: al quedarse una tarea esperando respuesta o fallida, lo que haya en el worktree sin subir (cambios
//   sin commit o commits locales) se sube a una ref aparte, refs/backcode/wip/<id>. No es una rama: no toca el PR, ni
//   dispara CI, ni lo puede mergear el modo auto. Si no hay nada nuevo, no se sube nada.
// - Relevo: el runner nuevo, antes de empezar, trae esa ref y, si continúa la rama que tiene (no está desfasada), deja el
//   worktree igual que estaba: los commits, y los cambios sin commit otra vez sin commit.
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SECRET_PATTERNS } from "./git.js";
import { t } from "./i18n.js";

const run = promisify(execFile);
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
/** Marca del commit sintético con los cambios sin commit: al recuperarlo se deshace y vuelven a quedar sin commit. */
export const CHECKPOINT_TRAILER = "Backcode-Checkpoint";

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await run("git", [...NO_HOOKS, ...args], { cwd, maxBuffer: 50 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  return stdout.trim();
}

export function wipRef(featureId: string): string {
  if (!/^[A-Za-z0-9]{1,64}$/.test(featureId)) throw new Error(`featureId: ${featureId}`);
  return `refs/backcode/wip/${featureId}`;
}

/** Secretos en las líneas añadidas de un diff (los mismos patrones que al abrir el PR). */
export function secretsInDiff(diff: string): string[] {
  const findings: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+")) for (const [re, label] of SECRET_PATTERNS) if (re.test(line)) findings.push(t("git.secretIn", { label: t(label), file }));
  }
  return [...new Set(findings)];
}

export type SaveResult = { saved: false; reason: "clean" | "protected" | "secrets"; files?: string[] } | { saved: true; sha: string; files: number };

/**
 * Sube lo que el worktree tenga sin publicar a refs/backcode/wip/<id>, sin tocar el worktree, su índice ni la rama.
 * Lo protegido (ficheros que el runner no deja subir) o con secretos no se sube: se devuelve el motivo.
 */
export async function saveProgress(opts: { worktree: string; remote: string; baseBranch: string; branch: string; featureId: string; isProtected: (file: string) => boolean }): Promise<SaveResult> {
  const { worktree, remote } = opts;
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  const published = (await git(worktree, ["ls-remote", "--heads", remote, opts.branch]).catch(() => "")).split(/\s/)[0] || "";
  // Índice temporal: `git add -A` sobre él no cambia lo que el agente o la persona tengan preparado en el real.
  const index = join(tmpdir(), `backcode-wip-${opts.featureId}-${process.pid}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(worktree, ["read-tree", "HEAD"], env);
    await git(worktree, ["add", "-A"], env);
    const dirty = (await git(worktree, ["diff", "--cached", "--name-only", "HEAD"], env)) !== "";
    if (!dirty && head === published) return { saved: false, reason: "clean" };
    let sha = head;
    if (dirty) {
      const tree = await git(worktree, ["write-tree"], env);
      sha = await git(worktree, ["commit-tree", tree, "-p", "HEAD", "-m", `Backcode: progreso guardado sin PR\n\n${CHECKPOINT_TRAILER}: ${opts.featureId}`], {
        GIT_AUTHOR_NAME: "Backcode",
        GIT_AUTHOR_EMAIL: "runner@backcode.local",
        GIT_COMMITTER_NAME: "Backcode",
        GIT_COMMITTER_EMAIL: "runner@backcode.local",
      });
    }
    // Lo que se sube y no está ya en el remoto: desde la rama publicada (si la contiene) o desde la base.
    await git(worktree, ["fetch", "--quiet", remote, opts.baseBranch]).catch(() => undefined);
    const from = published && (await git(worktree, ["merge-base", "--is-ancestor", published, sha]).then(() => true, () => false))
      ? published
      : await git(worktree, ["merge-base", `${remote}/${opts.baseBranch}`, sha]);
    const files = (await git(worktree, ["diff", "--name-only", "-z", from, sha])).split("\0").filter(Boolean);
    // Nada que no esté ya en la rama publicada (o en la base, si no se publicó): no hay qué guardar.
    if (files.length === 0) return { saved: false, reason: "clean" };
    const blocked = files.filter(opts.isProtected);
    if (blocked.length) return { saved: false, reason: "protected", files: blocked };
    const secrets = secretsInDiff(await git(worktree, ["diff", "-U0", "--no-color", from, sha]));
    if (secrets.length) return { saved: false, reason: "secrets", files: secrets };
    await git(worktree, ["push", "--no-verify", "--quiet", "--force", remote, `${sha}:${wipRef(opts.featureId)}`]);
    return { saved: true, sha, files: files.length };
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Relevo: trae el punto de guardado del ejecutor anterior y, si continúa lo que hay en el worktree (HEAD es antecesor
 * suyo), lo aplica. Uno desfasado (el anterior siguió y subió la rama después) se ignora. Devuelve si lo aplicó.
 * Después se borra la ref del remoto: ya está en este worktree, y el siguiente punto de guardado será de este runner.
 */
export async function restoreProgress(opts: { worktree: string; remote: string; featureId: string }): Promise<"restored" | "none" | "stale"> {
  const { worktree, remote } = opts;
  const ref = wipRef(opts.featureId);
  const fetched = await git(worktree, ["fetch", "--quiet", "--no-tags", remote, `+${ref}:${ref}`]).then(() => true, () => false);
  if (!fetched) return "none";
  const sha = await git(worktree, ["rev-parse", ref]);
  const usable = await git(worktree, ["merge-base", "--is-ancestor", "HEAD", sha]).then(() => true, () => false);
  if (usable) {
    await git(worktree, ["merge", "--ff-only", "--quiet", sha]);
    const message = await git(worktree, ["log", "-1", "--format=%B", "HEAD"]);
    // Los cambios que estaban sin commit vuelven a estarlo (el commit sintético no llega al PR).
    if (message.includes(`${CHECKPOINT_TRAILER}: ${opts.featureId}`)) await git(worktree, ["reset", "--mixed", "--quiet", "HEAD~1"]);
  }
  await git(worktree, ["update-ref", "-d", ref]).catch(() => undefined);
  await git(worktree, ["push", "--no-verify", "--quiet", remote, `:${ref}`]).catch(() => undefined);
  return usable ? "restored" : "stale";
}

/** Al abrir el PR ya no hace falta: se borra (sin esperar ni fallar si no existe). */
export async function dropProgress(opts: { worktree: string; remote: string; featureId: string }): Promise<void> {
  await git(opts.worktree, ["push", "--no-verify", "--quiet", opts.remote, `:${wipRef(opts.featureId)}`]).catch(() => undefined);
}
