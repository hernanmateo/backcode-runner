import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// HOME_DIR se lee al importar: la carpeta de pruebas va antes.
process.env.BACKCODE_HOME = mkdtempSync(join(tmpdir(), "bc-guard-home-"));
const { guardFor, touchesBase, writeGuard } = await import("../src/workflow-guard.js");

test("commit o push a la rama base: lo detecta en comandos compuestos, con -C y con refspecs", () => {
  const on = (branch: string) => () => branch;
  assert.equal(touchesBase('git commit -m "x"', "/r", "main", on("main")), "commit");
  assert.equal(touchesBase('git add -A && git commit -m "x"', "/r", "main", on("main")), "commit");
  assert.equal(touchesBase('git commit -m "x"', "/r", "main", on("feat/a")), null);
  assert.equal(touchesBase("git push", "/r", "main", on("main")), "push");
  assert.equal(touchesBase("git push -u origin feat/a", "/r", "main", on("feat/a")), null);
  assert.equal(touchesBase("git push origin HEAD:main", "/r", "main", on("feat/a")), "push");
  assert.equal(touchesBase("git push origin +main", "/r", "main", on("feat/a")), "push");
  assert.equal(touchesBase("git push origin HEAD", "/r", "main", on("main")), "push");
  assert.equal(touchesBase("git push origin v1.0.38", "/r", "main", on("main")), null);
  assert.equal(touchesBase("git push --all origin", "/r", "main", on("feat/a")), "push");
  assert.equal(touchesBase("git -C ../otro -c user.name=x commit -m y", "/r", "main", (d) => (d === "/otro" ? "main" : "feat/a")), "commit");
  assert.equal(touchesBase("git status && git log --oneline", "/r", "main", on("main")), null);
  assert.equal(touchesBase('echo "git commit" > notes.txt', "/r", "main", on("main")), null);
});

test("el repo conectado y sus worktrees se reconocen; otro repo, no", () => {
  const root = mkdtempSync(join(tmpdir(), "bc-guard-repo-"));
  const repo = join(root, "app");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  git(repo, "worktree", "add", "-q", "-b", "feat/x", join(root, "wt"));
  writeGuard({ projectId: "p1", projectName: "Demo", repoPath: repo, baseBranch: "main", remote: "origin", workflow: "require" });

  const inRepo = guardFor(repo);
  assert.equal(inRepo?.projectId, "p1");
  assert.equal(inRepo?.branch, "main");
  assert.equal(inRepo?.inWorktree, false);
  const inWt = guardFor(join(root, "wt"));
  assert.equal(inWt?.projectId, "p1");
  assert.equal(inWt?.branch, "feat/x");
  assert.equal(inWt?.inWorktree, true);

  const other = join(root, "other");
  execFileSync("git", ["init", "-q", other]);
  assert.equal(guardFor(other), null);
  assert.equal(guardFor(tmpdir()), null);
});
