import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergedCommit } from "../src/git.js";
import { updateBehindPr, waitHostHead } from "../src/pr-update.js";

// El merge de updateBehindPr (git merge en una copia aparte) necesita una identidad.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** origin (bare) + un clon con main (a.txt) y una rama `feat` que toca b.txt. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pr-update-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, "a.txt"), "uno\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "b.txt"), "rama\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "feat");
  git(repo, "push", "-q", "origin", "feat");
  git(repo, "checkout", "-q", "main");
  return { root, origin, repo, wts: join(root, "wts") };
}

/** Avanza main en origin con un commit que escribe `file`. */
function advanceMain(repo: string, file: string, text: string) {
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `main ${file}`);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
}

test("mergedCommit: si la rama ya contiene la base, es la propia cabeza", async () => {
  const { repo } = setup();
  git(repo, "fetch", "-q", "origin");
  const head = git(repo, "rev-parse", "origin/feat");
  assert.equal(await mergedCommit(repo, head, git(repo, "rev-parse", "origin/main")), head);
});

test("mergedCommit: con la base avanzada, un commit local con los dos lados, siempre el mismo", async () => {
  const { repo } = setup();
  advanceMain(repo, "c.txt", "main\n");
  const head = git(repo, "rev-parse", "origin/feat");
  const base = git(repo, "rev-parse", "origin/main");
  const merged = await mergedCommit(repo, head, base);
  assert.ok(merged && merged !== head);
  assert.equal(git(repo, "rev-parse", `${merged}^1`), head);
  assert.equal(git(repo, "rev-parse", `${merged}^2`), base);
  assert.equal(git(repo, "show", `${merged}:b.txt`), "rama");
  assert.equal(git(repo, "show", `${merged}:c.txt`), "main");
  assert.equal(await mergedCommit(repo, head, base), merged);
  // No queda ninguna rama apuntándolo ni se sube nada.
  assert.equal(git(repo, "branch", "-a", "--contains", merged!), "");
});

test("mergedCommit: si chocan, null", async () => {
  const { repo } = setup();
  advanceMain(repo, "b.txt", "otra cosa\n");
  assert.equal(await mergedCommit(repo, git(repo, "rev-parse", "origin/feat"), git(repo, "rev-parse", "origin/main")), null);
});

test("updateBehindPr: al día no sube nada; por detrás mezcla la base y la sube; con conflictos no sube", async () => {
  const { repo, origin, wts } = setup();
  const opts = { repoPath: repo, worktreesDir: wts, remote: "origin", base: "main", branch: "feat", name: "t1" };
  const before = git(origin, "rev-parse", "feat");
  assert.deepEqual(await updateBehindPr(opts), { status: "uptodate", files: [] });
  assert.equal(git(origin, "rev-parse", "feat"), before);

  advanceMain(repo, "c.txt", "main\n");
  const res = await updateBehindPr(opts);
  assert.equal(res.status, "merged");
  assert.equal(git(origin, "rev-parse", "feat"), res.sha);
  assert.equal(git(origin, "show", "feat:c.txt"), "main");
  assert.equal(git(origin, "show", "feat:b.txt"), "rama");

  advanceMain(repo, "b.txt", "choca\n");
  const pushed = git(origin, "rev-parse", "feat");
  const bad = await updateBehindPr(opts);
  assert.equal(bad.status, "conflicts");
  assert.deepEqual(bad.files, ["b.txt"]);
  assert.equal(git(origin, "rev-parse", "feat"), pushed);
});

test("waitHostHead: espera a ver el commit; se rinde a tiempo; sin forma de leerlo, espera un rato", async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  const reads = ["old", "old", "new"];
  assert.equal(await waitHostHead(async () => reads.shift() ?? "new", "new", { pollMs: 10, timeoutMs: 1000, sleep }), true);
  assert.deepEqual(slept, [10, 10]);
  slept.length = 0;
  assert.equal(await waitHostHead(async () => "old", "new", { pollMs: 10, timeoutMs: 30, sleep }), false);
  assert.deepEqual(slept, [10, 10, 10]);
  slept.length = 0;
  assert.equal(await waitHostHead(undefined, "new", { timeoutMs: 90, sleep }), true);
  assert.deepEqual(slept, [30]);
});
