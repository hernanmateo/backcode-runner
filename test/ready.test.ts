import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// HOME_DIR se lee al importar: la carpeta de pruebas va antes.
process.env.BACKCODE_HOME = mkdtempSync(join(tmpdir(), "bc-ready-home-"));
const { awake, listDeploys } = await import("../src/ready.js");
const { STATE_FILE } = await import("../src/paths.js");
const { writeGuard } = await import("../src/workflow-guard.js");

test("awake: valida el modo, lo escribe en el estado del panel y dice el que se aplica", () => {
  assert.deepEqual(awake(), { mode: "off", appMode: "off", effective: "off" });
  assert.deepEqual(awake("plugged"), { mode: "plugged", appMode: "off", effective: "plugged" });
  assert.equal(JSON.parse(readFileSync(STATE_FILE, "utf8")).keepAwake, "plugged");
  assert.throws(() => awake("yes"));
  assert.throws(() => awake(""));
  assert.equal(JSON.parse(readFileSync(STATE_FILE, "utf8")).keepAwake, "plugged");
  // El de la app cuenta para el que se aplica (gana el más fuerte), pero no se toca.
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, appKeepAwake: "always", keepAwakePlugged: true }));
  assert.deepEqual(awake("off"), { mode: "off", appMode: "always", effective: "always" });
  const after = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  assert.equal(after.appKeepAwake, "always");
  assert.equal(after.keepAwakePlugged, undefined);
});

test("deploys: los de la rama principal, desde el repo, un worktree o con --project, sin comandos", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-ready-repo-"));
  const repo = join(root, "app");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "wrangler.toml"), 'name = "w"\n');
  writeFileSync(join(repo, "backcode.toml"), '[deploy.api]\nrun = "make deploy"\n');
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  // Lo que no está en la rama principal no cuenta.
  git(repo, "worktree", "add", "-q", "-b", "feat/x", join(root, "wt"));
  writeFileSync(join(root, "wt", "backcode.json"), '{ "deploy": { "otro": { "run": "x" } } }');
  git(join(root, "wt"), "add", ".");
  git(join(root, "wt"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "otro");
  writeGuard({ projectId: "p1", projectName: "Demo", repoPath: repo, baseBranch: "main", remote: "origin", workflow: "off" });

  const expected = [
    { id: "#api", name: "api", dir: "", provider: null, source: "config" },
    { id: "#worker", name: "worker", dir: "", provider: "wrangler", source: "detected" },
  ];
  const sorted = (l: { name: string }[]) => [...l].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(sorted(await listDeploys({ dir: repo })), expected);
  assert.deepEqual(sorted(await listDeploys({ dir: join(root, "wt") })), expected);
  assert.deepEqual(sorted(await listDeploys({ projectId: "p1" })), expected);
  assert.ok(!JSON.stringify(await listDeploys({ dir: repo })).includes("make deploy"));
  await assert.rejects(listDeploys({ projectId: "nope" }));
  await assert.rejects(listDeploys({ dir: tmpdir() }));
});
