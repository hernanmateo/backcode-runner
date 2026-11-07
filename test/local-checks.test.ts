import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CheckItem, CommitStatus, PrHost } from "../src/hosts.js";
import { checkEnv, cleanOutput, installFor, type LocalCheck, onlyNotStarted, onlyNotStartedIn, oneAtATime, readCheckConfig, runCommand, runLocalChecks, saveFailedLog, takeCheckSlot } from "../src/local-checks.js";

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
paths = ["backcode-runner", "./functions/src/not-ours.ts", "../fuera"]

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
  assert.deepEqual(checks[1].paths, ["backcode-runner", "functions/src/not-ours.ts"]);
  assert.deepEqual(checks[0].paths, []);
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

const check = (name: string, over: Partial<LocalCheck> = {}): LocalCheck => ({ name, dir: "", cmd: ["true"], install: false, timeoutMs: 1000, idleMs: 60_000, paths: [], ...over });
/** Caché en memoria para los tests (sin tocar ~/.backcode). */
const memCache = () => {
  const keys = new Set<string>();
  return { has: (k: string) => keys.has(k), remember: (k: string) => void keys.add(k), keys };
};

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
    cache: memCache(),
    key: async (c) => `k-${c.name}`,
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
    cache: memCache(),
    key: async (c) => `k2-${c.name}`,
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
    cache: memCache(),
    key: async (c) => `k3-${c.name}`,
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

test("onlyNotStartedIn: lo mismo en un commit (antes de un despliegue)", async () => {
  assert.equal(await onlyNotStartedIn(async () => ["Runner"], { state: "failing", pending: ["Runner: fail"] }), true);
  assert.equal(await onlyNotStartedIn(async () => [], { state: "failing", pending: ["Runner: fail"] }), false);
  assert.equal(await onlyNotStartedIn(undefined, { state: "failing", pending: ["Runner: fail"] }), false);
  assert.equal(await onlyNotStartedIn(async () => { throw new Error("x"); }, { state: "failing", pending: ["Runner: fail"] }), false);
});

test("runLocalChecks: lo ya comprobado con el mismo contenido no se repite (aunque el host no lo sepa) y lo nuevo va a la vez", async () => {
  const cache = memCache();
  cache.remember("same-app");
  const { host, published } = fakeHost();
  let running = 0;
  let maxRunning = 0;
  const res = await runLocalChecks({
    repoPath: "/repo4",
    worktreesDir: "/wts",
    host,
    sha: "bbb",
    checks: [check("app"), check("tests"), check("runner")],
    worktree: async () => tmpdir(),
    cleanup: async () => undefined,
    cache,
    key: async (c) => (c.name === "app" ? "same-app" : `new-${c.name}`),
    run: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { ok: true, out: "" };
    },
  });
  assert.equal(res.checks.state, "green");
  assert.equal(maxRunning, 2); // tests y runner a la vez; app no se ejecuta
  assert.equal(published.find((p) => p.name === "Backcode · app")?.state, "ok");
  assert.equal(cache.keys.has("new-tests") && cache.keys.has("new-runner"), true);
});

test("runLocalChecks: un check que falla no entra en la caché", async () => {
  const cache = memCache();
  await runLocalChecks({
    repoPath: "/repo5",
    worktreesDir: "/wts",
    host: undefined,
    sha: "ccc",
    checks: [check("app")],
    worktree: async () => tmpdir(),
    cleanup: async () => undefined,
    cache,
    key: async () => "k-fail",
    run: async () => ({ ok: false, out: "boom" }),
  });
  assert.equal(cache.keys.has("k-fail"), false);
});

test("runLocalChecks: con publishSha comprueba un commit y publica en otro, sin fiarse de los estados que ya tenía", async () => {
  // La cabeza del PR ya tenía «tests» en verde (de la rama sola): con el PR mezclado con la base no cuenta.
  const { host, published } = fakeHost([{ name: "Backcode · tests", state: "ok" }]);
  const ran: string[] = [];
  const keys: string[] = [];
  const res = await runLocalChecks({
    repoPath: "/repo-publish",
    worktreesDir: "/wts",
    host,
    sha: "merged123",
    publishSha: "head456",
    checks: [check("tests")],
    worktree: async (sha) => (ran.push(`wt:${sha}`), tmpdir()),
    cleanup: async () => undefined,
    cache: memCache(),
    key: async (c) => (keys.push(c.name), `k-${c.name}-merged`),
    run: async (cmd) => (ran.push(cmd[0]), { ok: true, out: "" }),
  });
  assert.equal(res.checks.state, "green");
  assert.deepEqual(ran, ["wt:merged123", "true"]);
  assert.ok(published.length > 0);
  assert.ok(published.every((p) => p.sha === "head456"));
});

test("oneAtATime: el mismo check no corre dos veces a la vez; otro distinto sí; un fallo no bloquea la cola", async () => {
  let live = 0;
  let max = 0;
  const waited: string[] = [];
  const job = (ms: number, fail = false) => async () => {
    max = Math.max(max, ++live);
    await new Promise((r) => setTimeout(r, ms));
    live--;
    if (fail) throw new Error("x");
    return "ok";
  };
  const a = oneAtATime("/r#tests", job(40, true), () => waited.push("a"));
  const b = oneAtATime("/r#tests", job(10), () => waited.push("b"));
  const c = oneAtATime("/r#tests", job(10), () => waited.push("c"));
  await assert.rejects(a);
  assert.deepEqual(await Promise.all([b, c]), ["ok", "ok"]);
  assert.equal(max, 1);
  assert.deepEqual(waited, ["b", "c"]);
  max = 0;
  await Promise.all([oneAtATime("/r#app", job(20)), oneAtATime("/r#runner", job(20))]);
  assert.equal(max, 2);
});

test("runLocalChecks: dos commits con el mismo check lo ejecutan por turnos", async () => {
  let live = 0;
  let max = 0;
  const deps = (sha: string) => ({
    repoPath: "/repo-turns",
    worktreesDir: "/wts",
    host: undefined,
    sha,
    checks: [check("tests")],
    worktree: async () => tmpdir(),
    cleanup: async () => undefined,
    cache: memCache(),
    key: async () => null,
    run: async () => {
      max = Math.max(max, ++live);
      await new Promise((r) => setTimeout(r, 30));
      live--;
      return { ok: true, out: "" };
    },
  });
  const [x, y] = await Promise.all([runLocalChecks(deps("aaa")), runLocalChecks(deps("bbb"))]);
  assert.equal(x.checks.state, "green");
  assert.equal(y.checks.state, "green");
  assert.equal(max, 1);
});

test("runLocalChecks: con signal abortado, el check en marcha se cancela; quien comparte la ejecución sin signal la mantiene", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const base = {
    repoPath: "/repo-abort",
    worktreesDir: "/wts",
    host: undefined,
    checks: [check("tests")],
    worktree: async () => tmpdir(),
    cleanup: async () => undefined,
    cache: memCache(),
    key: async () => null,
    run: (_cmd: string[], _cwd: string, _env: Record<string, string>, _ms: number, abort?: AbortSignal) =>
      new Promise<{ ok: boolean; out: string }>((resolve) => {
        seen.push(abort);
        const t = setTimeout(() => resolve({ ok: true, out: "" }), 60);
        abort?.addEventListener("abort", () => (clearTimeout(t), resolve({ ok: false, out: "cancelado" })));
      }),
  };
  const solo = new AbortController();
  const p = runLocalChecks({ ...base, sha: "s1", signal: solo.signal });
  setTimeout(() => solo.abort(), 10);
  assert.equal((await p).checks.state, "failing");

  const shared = new AbortController();
  const q1 = runLocalChecks({ ...base, sha: "s2", signal: shared.signal });
  const q2 = runLocalChecks({ ...base, sha: "s2" });
  setTimeout(() => shared.abort(), 10);
  const [r1, r2] = await Promise.all([q1, q2]);
  assert.equal(r1.checks.state, "green");
  assert.equal(r2.checks.state, "green");
});

// killTree lee los descendientes con `ps`: en un sandbox que lo bloquea (p. ej. el de Claude Code) no se puede probar.
const psWorks = (() => {
  try {
    execFileSync("ps", ["-A", "-o", "pid="], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("runCommand: al cortar por tiempo mata también los procesos que el check sacó a otro grupo (p. ej. emuladores)", { skip: process.platform === "win32" || !psWorks }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-kill-"));
  const pidFile = join(dir, "pid");
  // Un hijo `detached` (su propio grupo, como los emuladores de Firebase) que ignora SIGTERM: solo cae con SIGKILL.
  const script = `const { spawn } = require("node:child_process"); const fs = require("node:fs");
const c = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  const started = Date.now();
  const res = await runCommand([process.execPath, "-e", script], dir, { ...process.env } as Record<string, string>, 1500, undefined, { graceMs: 500 });
  assert.equal(res.ok, false);
  assert.match(res.out, /min/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0);
  const alive = (() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  assert.equal(alive, false, "el proceso detached sigue vivo");
  assert.ok(Date.now() - started < 10_000);
});

test("runCommand: con signal abortado mata el comando y avisa", { skip: process.platform === "win32" }, async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 200);
  const res = await runCommand(["sleep", "30"], tmpdir(), { ...process.env } as Record<string, string>, 60_000, ctrl.signal, { graceMs: 500 });
  assert.equal(res.ok, false);
  assert.ok(res.out.length > 0);
  assert.equal((await runCommand(["true"], tmpdir(), { ...process.env } as Record<string, string>, 60_000, ctrl.signal)).ok, false);
});

test("saveFailedLog: guarda la salida limpia y deja solo las últimas", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-logs-"));
  const file = saveFailedLog("tests", "abcdef123456", "\x1b[31mboom\x1b[0m\n\nAssertionError", dir);
  assert.ok(file.startsWith(dir) && file.endsWith("-abcdef1-tests.log"));
  assert.equal(readFileSync(file, "utf8"), "boom\nAssertionError\n");
  for (let i = 0; i < 35; i++) saveFailedLog(`c${i}`, "abcdef123456", "x", dir);
  assert.equal(readdirSync(dir).length, 30);
});

test("runCommand: un comando que deja de escribir se corta por silencio antes del tope total", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const res = await runCommand(["sh", "-c", "echo hola; sleep 30"], tmpdir(), { ...process.env } as Record<string, string>, 60_000, undefined, { graceMs: 500, idleMs: 400 });
  assert.equal(res.ok, false);
  assert.match(res.out, /hola/);
  assert.ok(Date.now() - started < 10_000);
  // Uno que escribe a menudo no se corta aunque tarde más que idleMs.
  const busy = await runCommand(["sh", "-c", "for i in 1 2 3 4 5 6; do echo $i; sleep 0.3; done"], tmpdir(), { ...process.env } as Record<string, string>, 60_000, undefined, { idleMs: 1500 });
  assert.equal(busy.ok, true);
});

test("takeCheckSlot: como mucho `max` a la vez en el ordenador; el siguiente espera y entra al soltar uno", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-slots-"));
  const a = await takeCheckSlot(dir, 2, undefined, undefined, 20);
  const b = await takeCheckSlot(dir, 2, undefined, undefined, 20);
  let waited = false;
  let got = false;
  const c = takeCheckSlot(dir, 2, undefined, () => (waited = true), 20).then((rel) => ((got = true), rel));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(waited, true);
  assert.equal(got, false);
  a();
  (await c)();
  assert.equal(got, true);
  b();
  // Abortado mientras espera: deja de esperar.
  const x = await takeCheckSlot(dir, 1, undefined, undefined, 20);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 60);
  const rel = await takeCheckSlot(dir, 1, ctrl.signal, undefined, 20);
  rel();
  x();
});

test("readCheckConfig: idle en minutos (por defecto 5)", () => {
  const { checks } = readCheckConfig('[check.a]\nrun = "true"\n\n[check.b]\nrun = "true"\nidle = 2\n');
  assert.deepEqual(checks.map((c) => c.idleMs), [5 * 60_000, 2 * 60_000]);
});

test("runChecksReport: qué pasa, qué falla y el log de lo que falla", async () => {
  const { runChecksReport } = await import("../src/local-checks.js");
  const green = runChecksReport(["app", "tests"], { checks: { state: "green", pending: [] }, log: "" });
  assert.equal(green, "All checks pass.\n- app: ok\n- tests: ok");
  const bad = runChecksReport(["app", "tests"], { checks: { state: "failing", pending: ["Backcode · tests: fail"] }, log: "## Backcode · tests\nboom" });
  assert.equal(bad, "Some checks fail.\n- app: ok\n- tests: FAIL\n\n## Backcode · tests\nboom");
});

test("snapshotCommit: commit suelto con lo modificado y lo nuevo, sin tocar HEAD ni el índice", async () => {
  const { snapshotCommit } = await import("../src/git.js");
  const repo = mkdtempSync(join(tmpdir(), "bc-snap-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repo, "a.txt"), "uno\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const head = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "dos\n");
  writeFileSync(join(repo, "nuevo.txt"), "nuevo\n");
  writeFileSync(join(repo, "ignored.txt"), "no\n");
  const status = g("status", "--porcelain");

  const sha = await snapshotCommit(repo);
  assert.equal(g("rev-parse", "HEAD"), head);
  assert.equal(g("status", "--porcelain"), status);
  assert.equal(g("rev-parse", `${sha}^`), head);
  assert.equal(g("show", `${sha}:a.txt`), "dos");
  assert.equal(g("show", `${sha}:nuevo.txt`), "nuevo");
  assert.throws(() => g("show", `${sha}:ignored.txt`));
});
