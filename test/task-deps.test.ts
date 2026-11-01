import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockfileDirs, prepareTaskDependencies } from "../src/task-deps.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

/** Repo con una app (bun.lockb + yarn.lock: gana bun), unas functions con package-lock y un paquete sin lockfile. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bc-deps-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "bun.lockb"), "x");
  writeFileSync(join(dir, "yarn.lock"), "x");
  mkdirSync(join(dir, "functions"));
  writeFileSync(join(dir, "functions/package.json"), "{}");
  writeFileSync(join(dir, "functions/package-lock.json"), "{}");
  mkdirSync(join(dir, "tools"));
  writeFileSync(join(dir, "tools/package.json"), "{}");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

test("carpetas con lockfile versionado y el comando de su gestor (bun antes que yarn)", async () => {
  const dir = repo();
  assert.deepEqual(await lockfileDirs(dir), [
    { dir: "", lock: "bun.lockb", cmd: ["bun", "install", "--frozen-lockfile"] },
    { dir: "functions", lock: "package-lock.json", cmd: ["npm", "ci", "--no-audit", "--no-fund"] },
  ]);
});

test("no instala si node_modules no está ignorado o si Claude ya cambió las dependencias", async () => {
  const dir = repo();
  // Sin .gitignore: node_modules acabaría en el PR → no se instala nada.
  assert.deepEqual(await prepareTaskDependencies({ worktree: dir, base: "main" }), []);
  // Ignorado, pero con package.json cambiados respecto a la base → tampoco (lo instala Claude en su sandbox).
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(dir, "package.json"), '{"dependencies":{"x":"1"}}');
  writeFileSync(join(dir, "functions/package.json"), '{"dependencies":{"y":"1"}}');
  assert.deepEqual(await prepareTaskDependencies({ worktree: dir, base: "main" }), []);
});

test("si ya hay node_modules, no se toca", async () => {
  const dir = repo();
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  mkdirSync(join(dir, "node_modules"));
  mkdirSync(join(dir, "functions/node_modules"));
  assert.deepEqual(await prepareTaskDependencies({ worktree: dir, base: "main" }), []);
});
