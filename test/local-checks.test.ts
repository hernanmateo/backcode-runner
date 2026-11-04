import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CheckItem, CommitStatus, PrHost } from "../src/hosts.js";
import { checkEnv, cleanOutput, installFor, type LocalCheck, onlyNotStarted, readCheckConfig, runLocalChecks } from "../src/local-checks.js";

test("backcode.toml: [check.<nombre>] con run, dir, install, timeout y description", () => {
  const { checks, errors } = readCheckConfig(`
[deploy.web]
run = "./deploy.sh"

[check.app]
run = "npm run typecheck && npm run lint"
dir = "./app/"
description = "  Tipos   y lint "

[check.runner]
run = ["npm", "test"]
dir = "backcode-runner"
install = false
timeout = 90

[check.Mal]
run = "x"

[check.sin-run]
dir = "x"

[check.fuera]
run = "x"
dir = "../otro"
`);
  assert.deepEqual(
    checks.map((c) => ({ name: c.name, dir: c.dir, cmd: c.cmd, install: c.install, timeoutMs: c.timeoutMs, description: c.description })),
    [
      { name: "app", dir: "app", cmd: ["sh", "-c", "npm run typecheck && npm run lint"], install: true, timeoutMs: 20 * 60_000, description: "Tipos y lint" },
      { name: "runner", dir: "backcode-runner", cmd: ["npm", "test"], install: false, timeoutMs: 60 * 60_000, description: undefined },
    ],
  );
  assert.equal(errors.length, 3);
});

test("installFor: la carpeta con lockfile más cercana y su comando congelado; sin lockfile, npm install", () => {
  const wt = mkdtempSync(join(tmpdir(), "lc-"));
  mkdirSync(join(wt, "app", "src"), { recursive: true });
  writeFileSync(join(wt, "app", "package-lock.json"), "{}");
  mkdirSync(join(wt, "web"));
  writeFileSync(join(wt, "web", "package.json"), "{}");
  mkdirSync(join(wt, "go"));
  assert.deepEqual(installFor(wt, "app/src"), { dir: "app", cmd: ["npm", "ci", "--no-audit", "--no-fund"] });
  assert.deepEqual(installFor(wt, "web"), { dir: "web", cmd: ["npm", "install", "--no-audit", "--no-fund"] });
  assert.equal(installFor(wt, "go"), null);
  writeFileSync(join(wt, "pnpm-lock.yaml"), "");
  assert.deepEqual(installFor(wt, "go"), { dir: "", cmd: ["pnpm", "install", "--frozen-lockfile"] });
});

test("checkEnv: sin tokens del runner, con los binarios del paquete en el PATH y CI=1", () => {
  const env = checkEnv("/wt", "/wt/app", { PATH: "/usr/bin", HOME: "/h", GITHUB_TOKEN: "x", BITBUCKET_API_TOKEN: "y", ANTHROPIC_API_KEY: "z", JAVA_HOME: "/j" });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.BITBUCKET_API_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.JAVA_HOME, "/j");
  assert.equal(env.CI, "1");
  assert.equal(env.PATH, "/wt/app/node_modules/.bin:/wt/node_modules/.bin:/usr/bin");
});

test("cleanOutput: sin colores ni líneas vacías, solo el final", () => {
  assert.equal(cleanOutput("\x1b[31mError\x1b[0m\n\n  at x\n", 100), "Error\n  at x");
  assert.equal(cleanOutput("hola mundo ".repeat(5).trim(), 10), "…\nla mundo");
});

const check = (name: string, over: Partial<LocalCheck> = {}): LocalCheck => ({ name, dir: "", cmd: ["true"], install: false, timeoutMs: 1000, ...over });

function fakeHost(items: CheckItem[] = []) {
  const published: (CommitStatus & { sha: string })[] = [];
  const host = {
    commitItems: async () => items,
    setStatus: async (sha: string, s: CommitStatus) => void published.push({ sha, ...s }),
  } as unknown as PrHost;
  return { host, published };
}

test("runLocalChecks: ejecuta cada check, publica pendiente y resultado, y devuelve el log de los que fallan", async () => {
  const { host, published } = fakeHost();
  const ran: string[] = [];
  let cleaned = false;
  const res = await runLocalChecks({
    repoPath: "/repo",
    worktreesDir: "/wts",
    host,
    sha: "abc1234def",
    checks: [check("app"), check("tests", { cmd: ["fail"] })],
    worktree: async () => tmpdir(),
    cleanup: async () => void (cleaned = true),
    run: async (cmd) => {
      ran.push(cmd[0]);
      return cmd[0] === "fail" ? { ok: false, out: "boom\nAssertionError: 1 !== 2" } : { ok: true, out: "ok" };
    },
  });
  assert.deepEqual(ran, ["true", "fail"]);
  assert.equal(cleaned, true);
  assert.equal(res.checks.state, "failing");
  assert.deepEqual(res.checks.pending, ["Backcode · tests: fail"]);
  assert.match(res.log, /## Backcode · tests\nboom\nAssertionError/);
  assert.deepEqual(published.map((p) => `${p.name}=${p.state}`), ["Backcode · app=pending", "Backcode · tests=pending", "Backcode · app=ok", "Backcode · tests=fail"]);
  assert.match(published[3].description, /AssertionError: 1 !== 2$/);
});

test("runLocalChecks: los que ya pasaron en ese commit no se repiten; sin checks, none", async () => {
  const { host } = fakeHost([{ name: "Backcode · app", state: "ok" }, { name: "Backcode · tests", state: "fail" }]);
  const ran: string[] = [];
  const res = await runLocalChecks({
    repoPath: "/repo2",
    worktreesDir: "/wts",
    host,
    sha: "fff",
    checks: [check("app"), check("tests")],
    worktree: async () => tmpdir(),
    cleanup: async () => undefined,
    run: async (cmd) => (ran.push(cmd[0]), { ok: true, out: "" }),
  });
  assert.equal(ran.length, 1);
  assert.equal(res.checks.state, "green");
  assert.equal((await runLocalChecks({ repoPath: "/r", worktreesDir: "/w", host, sha: "x", checks: [] })).checks.state, "none");
});

test("runLocalChecks: si fallan las dependencias, falla el check sin ejecutarlo", async () => {
  const wt = mkdtempSync(join(tmpdir(), "lc-"));
  writeFileSync(join(wt, "package-lock.json"), "{}");
  const ran: string[] = [];
  const res = await runLocalChecks({
    repoPath: "/repo3",
    worktreesDir: "/wts",
    host: undefined,
    sha: "aaa",
    checks: [check("a", { install: true }), check("b", { install: true })],
    worktree: async () => wt,
    cleanup: async () => undefined,
    run: async (cmd) => (ran.push(cmd.join(" ")), cmd[0] === "npm" ? { ok: false, out: "ERESOLVE" } : { ok: true, out: "" }),
  });
  assert.deepEqual(ran, ["npm ci --no-audit --no-fund"]);
  assert.equal(res.checks.state, "failing");
  assert.match(res.log, /ERESOLVE/);
});

test("onlyNotStarted: solo si todo lo que está en rojo no llegó a ejecutarse", async () => {
  const host = { notStarted: async () => ["App · tipos y lint", "Tests"] } as unknown as PrHost;
  assert.equal(await onlyNotStarted(host, "u", { state: "failing", pending: ["App · tipos y lint: fail", "Tests: fail"] }), true);
  assert.equal(await onlyNotStarted(host, "u", { state: "failing", pending: ["App · tipos y lint: fail", "Runner: fail"] }), false);
  assert.equal(await onlyNotStarted(host, "u", { state: "failing", pending: ["Tests: fail", "Lint: pending"] }), false);
  assert.equal(await onlyNotStarted(host, "u", { state: "green", pending: [] }), false);
  assert.equal(await onlyNotStarted({} as PrHost, "u", { state: "failing", pending: ["Tests: fail"] }), false);
});
