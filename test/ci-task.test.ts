import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoMerge } from "../src/auto-merge.js";
import { buildCiPrompt, CI_TOOLS, ciFileFor, ciGuard, ciSystemAppend, isCiTask } from "../src/ci-task.js";
import { createGuardHook, protectedMatcher } from "../src/guard.js";

const base = protectedMatcher([]);

test("tarea de CI en GitHub: solo los workflows y docs", () => {
  const { isProtected } = ciGuard("github", base);
  assert.equal(isProtected(".github/workflows/ci.yml"), false);
  assert.equal(isProtected(".github/workflows/test.yaml"), false);
  assert.equal(isProtected("docs/ci.md"), false);
  assert.equal(isProtected("README.md"), false);
  // Todo lo demás, bloqueado.
  assert.equal(isProtected("src/index.ts"), true);
  assert.equal(isProtected("package.json"), true);
  assert.equal(isProtected(".github/actions/setup/action.yml"), true);
  assert.equal(isProtected(".github/workflows/nested/ci.yml"), true);
  assert.equal(isProtected("bitbucket-pipelines.yml"), true);
  assert.equal(isProtected(".env"), true);
  assert.equal(isProtected("CLAUDE.md"), true);
  assert.equal(isProtected("app/README.md"), true);
});

test("tarea de CI en Bitbucket: solo bitbucket-pipelines.yml y docs", () => {
  const { isProtected } = ciGuard("bitbucket", base);
  assert.equal(isProtected("bitbucket-pipelines.yml"), false);
  assert.equal(isProtected("docs/guide/ci.md"), false);
  assert.equal(isProtected(".github/workflows/ci.yml"), true);
  assert.equal(isProtected("src/a.ts"), true);
});

test("tarea de CI: no puede leer ficheros de secretos", () => {
  const { denyRead } = ciGuard("github", base);
  for (const p of [".env", ".env.local", "app/.env.production", ".npmrc", "key.pem", "android/app/google-services.json"]) assert.equal(denyRead(p), true, p);
  for (const p of ["package.json", "src/environment.ts", "src/env.ts"]) assert.equal(denyRead(p), false, p);
});

test("el hook de la tarea de CI bloquea escribir fuera del alcance y leer secretos", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-task-")));
  const { isProtected, denyRead } = ciGuard("github", base);
  const hook = createGuardHook(root, isProtected, { denyRead });
  const run = (tool_name: string, tool_input: Record<string, unknown>) =>
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", transcript_path: "", cwd: root, tool_use_id: "t" } as never, undefined, { signal: new AbortController().signal });
  const denied = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === "deny";
  assert.equal(denied(await run("Write", { file_path: join(root, ".github/workflows/ci.yml") })), false);
  assert.equal(denied(await run("Write", { file_path: join(root, "src/index.ts") })), true);
  assert.equal(denied(await run("Read", { file_path: join(root, ".env") })), true);
  assert.equal(denied(await run("Read", { file_path: join(root, "package.json") })), false);
  assert.equal(denied(await run("Grep", { pattern: "TOKEN", glob: ".env*" })), true);
  assert.equal(denied(await run("Glob", { pattern: "**/.env*" })), true);
  assert.equal(denied(await run("Glob", { pattern: "**/package.json" })), false);
});

test("prompt y herramientas de la tarea de CI", () => {
  assert.equal(isCiTask({ kind: "ci" }), true);
  assert.equal(isCiTask({}), false);
  assert.equal(CI_TOOLS.includes("Bash"), false);
  assert.equal(ciFileFor("github"), ".github/workflows/ci.yml");
  const gh = buildCiPrompt("github");
  assert.match(gh, /\$\{\{ secrets\.NAME \}\}/);
  assert.match(gh, /gh secret set NAME/);
  assert.match(gh, /Secrets and variables → Actions/);
  const bb = buildCiPrompt("bitbucket");
  assert.match(bb, /bitbucket-pipelines\.yml/);
  assert.match(bb, /Secured/);
  assert.match(ciSystemAppend("github"), /never merged or deployed automatically/);
});

test("el modo auto nunca mergea un PR de CI", async () => {
  let merged = false;
  const state = await autoMerge({
    featureId: "f",
    base: "main",
    retries: 1,
    hasCi: true,
    ciTask: true,
    merge: async () => ((merged = true), { ok: true, result: {} }),
    fixChecks: async () => ({ ok: false, result: {} }),
    fixConflicts: async () => ({ ok: false, result: {} }),
    setState: async () => undefined,
    takeTurn: async () => true,
    releaseTurn: async () => undefined,
    sleep: async () => undefined,
  });
  assert.equal(state.state, "stopped");
  assert.equal(merged, false);
});
