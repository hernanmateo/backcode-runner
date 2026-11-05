import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitPushAndOpenPr, mergeBaseIntoBranch, stageAll } from "../src/git.js";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const commit = (repo: string, file: string, text: string, msg: string) => {
  writeFileSync(join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", msg);
};

/**
 * El caso del PR que no se podía mergear: la rama `feat` lleva el commit de otro PR (`dep`) y encima su cambio; main
 * mergea `dep` squasheado (otro commit, mismo contenido). Al traer main, a.txt choca, y la resolución correcta (la
 * versión de la rama) deja los ficheros idénticos a HEAD.
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "merge-push-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "remote", "add", "origin", origin);
  commit(repo, "a.txt", "uno\n", "init");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-qb", "feat");
  commit(repo, "a.txt", "dos\n", "dep");
  commit(repo, "a.txt", "dos\ntres\n", "feat");
  git(repo, "push", "-q", "origin", "feat");
  git(repo, "checkout", "-q", "main");
  commit(repo, "a.txt", "dos\n", "dep (squash)");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "feat");
  return { repo };
}

test("commitPushAndOpenPr cierra el merge con la base aunque la resolución no cambie ningún fichero", async () => {
  const { repo } = setup();
  const before = git(repo, "rev-parse", "HEAD");
  const sync = await mergeBaseIntoBranch(repo, "origin", "main");
  assert.equal(sync.status, "conflicts");
  assert.deepEqual(sync.files, ["a.txt"]);
  // Claude resuelve quedándose con la versión de la rama: idéntica a HEAD.
  writeFileSync(join(repo, "a.txt"), "dos\ntres\n");
  await stageAll(repo);
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "");

  await commitPushAndOpenPr({ worktree: repo, remote: "origin", baseBranch: "main", branch: "feat", title: "Feat", body: "", featureId: "f1" });

  const pushed = git(repo, "rev-parse", "origin/feat");
  assert.notEqual(pushed, before);
  assert.equal(git(repo, "rev-parse", `${pushed}^1`), before);
  assert.equal(git(repo, "rev-parse", `${pushed}^2`), git(repo, "rev-parse", "origin/main"));
  // La rama ya contiene la base: el PR deja de chocar.
  assert.equal(git(repo, "rev-list", "--count", "origin/feat..origin/main"), "0");
  assert.equal(git(repo, "show", `${pushed}:a.txt`), "dos\ntres");
});

test("commitPushAndOpenPr sin nada que commitear ni merge a medias no crea commits", async () => {
  const { repo } = setup();
  const before = git(repo, "rev-parse", "HEAD");
  await commitPushAndOpenPr({ worktree: repo, remote: "origin", baseBranch: "main", branch: "feat", title: "Feat", body: "", featureId: "f1" });
  assert.equal(git(repo, "rev-parse", "origin/feat"), before);
});
