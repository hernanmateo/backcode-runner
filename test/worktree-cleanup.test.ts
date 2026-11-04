import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideTask, decideTemp, lastUse, TASK_STALE_MS, type TaskFacts } from "../src/worktree-cleanup.ts";
import { holdWorktree, isSafeWorktreePath, releaseWorktree, removeWorktree, worktreeInUse } from "../src/git.ts";

const DAY = 86_400_000;
const base: TaskFacts = { inUse: false, feature: { exists: true, status: "done" }, pr: "open", local: { dirty: false, unpushed: false }, idleMs: 0 };
const facts = (patch: Partial<TaskFacts>): TaskFacts => ({ ...base, ...patch });

test("decideTask: se conserva si está en uso o no se sabe el estado", () => {
  assert.equal(decideTask(facts({ inUse: true, pr: "merged" })).remove, false);
  assert.equal(decideTask(facts({ feature: null, pr: "merged" })).remove, false);
  assert.equal(decideTask(facts({ pr: "unknown" })).remove, false);
});

test("decideTask: se borra si la tarea ya no existe o se descartó, aunque tenga trabajo sin subir", () => {
  const dirty = { dirty: true, unpushed: true };
  assert.equal(decideTask(facts({ feature: { exists: false }, local: dirty })).remove, true);
  assert.equal(decideTask(facts({ feature: { exists: true, status: "rejected" }, pr: "none", local: dirty })).remove, true);
});

test("decideTask: PR mergeado o cerrado se borra aunque haya cambios locales", () => {
  const dirty = { dirty: true, unpushed: true };
  assert.equal(decideTask(facts({ pr: "merged", local: dirty })).remove, true);
  assert.equal(decideTask(facts({ pr: "closed", local: dirty })).remove, true);
  assert.equal(decideTask(facts({ feature: { exists: true, status: "done", merged: true }, pr: "unknown", local: null })).remove, true);
});

test("decideTask: tareas activas o con PR abierto se conservan aunque lleven mucho sin usarse", () => {
  for (const status of ["backlog", "execute", "running", "waiting"]) {
    assert.equal(decideTask(facts({ feature: { exists: true, status }, pr: "none", idleMs: 100 * DAY })).remove, false, status);
  }
  assert.equal(decideTask(facts({ pr: "open", idleMs: 100 * DAY })).remove, false);
});

test("decideTask: sin PR, solo se borra tras días sin uso, limpia y subida", () => {
  const old = TASK_STALE_MS + DAY;
  assert.equal(decideTask(facts({ pr: "none", idleMs: DAY })).remove, false);
  assert.equal(decideTask(facts({ pr: "none", idleMs: old })).remove, true);
  assert.equal(decideTask(facts({ pr: "none", idleMs: old, local: { dirty: true, unpushed: false } })).remove, false);
  assert.equal(decideTask(facts({ pr: "none", idleMs: old, local: { dirty: false, unpushed: true } })).remove, false);
  assert.equal(decideTask(facts({ pr: "none", idleMs: old, local: null })).remove, false);
  assert.equal(decideTask(facts({ feature: { exists: true, status: "failed" }, pr: "none", idleMs: old })).remove, true);
});

test("decideTemp: nunca en uso; chat e install duran 14 días, el resto 1", () => {
  assert.equal(decideTemp("_checks-abc", 30 * DAY, true).remove, false);
  assert.equal(decideTemp("_checks-abc", 2 * DAY, false).remove, true);
  assert.equal(decideTemp("_checks-abc", 3_600_000, false).remove, false);
  assert.equal(decideTemp("_chat-x1", 2 * DAY, false).remove, false);
  assert.equal(decideTemp("_chat-x1", 15 * DAY, false).remove, true);
  assert.equal(decideTemp("_install", 2 * DAY, false).remove, false);
  assert.equal(decideTemp("_dev", 2 * DAY, false).remove, false);
  assert.equal(decideTemp("weird-name", 2 * DAY, false).remove, false);
  assert.equal(decideTemp("weird-name", 15 * DAY, false).remove, true);
});

test("holdWorktree / releaseWorktree cuentan los usos", () => {
  const p = join(tmpdir(), "bc-hold-test");
  holdWorktree(p);
  holdWorktree(p);
  releaseWorktree(p);
  assert.equal(worktreeInUse(p), true);
  releaseWorktree(p);
  assert.equal(worktreeInUse(p), false);
});

test("lastUse: cuenta el HEAD del gitdir, no solo la carpeta", () => {
  const root = mkdtempSync(join(tmpdir(), "bc-lastuse-"));
  try {
    const wt = join(root, "wt");
    const gitdir = join(root, "gitdir");
    mkdirSync(wt);
    mkdirSync(gitdir);
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, "HEAD"), "ref: x\n");
    const old = new Date(Date.now() - 30 * DAY);
    utimesSync(join(wt, ".git"), old, old);
    utimesSync(wt, old, old);
    assert.ok(Date.now() - lastUse(wt) < DAY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSafeWorktreePath: solo hijos directos reales de la carpeta de worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "bc-safe-"));
  try {
    const dir = join(root, "worktrees");
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(join(dir, "task1", "nested"), { recursive: true });
    mkdirSync(repo);
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "link"));
    symlinkSync(repo, join(dir, "repolink"));

    assert.equal(isSafeWorktreePath(dir, join(dir, "task1"), repo), true);
    assert.equal(isSafeWorktreePath(dir, join(dir, "task1", "nested"), repo), false); // no es hijo directo
    assert.equal(isSafeWorktreePath(dir, join(dir, "..", "outside"), repo), false); // se sale con ..
    assert.equal(isSafeWorktreePath(dir, join(dir, "link"), repo), false); // enlace que sale fuera
    assert.equal(isSafeWorktreePath(dir, join(dir, "repolink"), repo), false); // enlace al repo
    assert.equal(isSafeWorktreePath(dir, dir, repo), false); // la propia carpeta
    assert.equal(isSafeWorktreePath(dir, join(dir, "missing"), repo), false); // no existe
    // El repo dentro de la carpeta de worktrees: nunca se borra.
    mkdirSync(join(dir, "inner-repo"));
    assert.equal(isSafeWorktreePath(dir, join(dir, "inner-repo"), join(dir, "inner-repo")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeWorktree: si git ya no conoce la copia, la carpeta se borra igualmente (dentro de la carpeta de worktrees)", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-rm-"));
  try {
    const repo = join(root, "repo");
    const dir = join(root, "worktrees");
    mkdirSync(repo);
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(repo, "a.txt"), "a");
    // Copia cuyos metadatos git ya no tiene (p. ej. tras un `worktree prune`): `git worktree remove` falla.
    const wt = join(dir, "task1");
    mkdirSync(join(wt, "node_modules", "x"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "task1")}\n`);
    writeFileSync(join(wt, "dirty.txt"), "x");
    const r = await removeWorktree(repo, wt, dir);
    assert.equal(r.removed, true);
    assert.equal(existsSync(wt), false);
    assert.equal(existsSync(join(repo, "a.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
