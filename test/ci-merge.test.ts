import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { merge, runAction } from "../src/actions.js";
import type { RunnerConfig } from "../src/config.js";
import type { PrHost } from "../src/hosts.js";
import type { Store } from "../src/store.js";

const PR = "https://github.com/o/r/pull/7";

// Merge de una tarea con un store y un host falsos (sin git: el repo es una carpeta vacía y el repo no tiene CI).
function setup(kind?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-merge-")));
  const cfg = { repoPath: dir, worktreesDir: join(dir, "wt"), remote: "origin", baseBranch: "main" } as unknown as RunnerConfig;
  const calls = { merged: 0, marked: [] as unknown[][], events: [] as string[] };
  const store = {
    uid: "u1",
    capabilities: { ci: false },
    prUrlOf: async () => PR,
    featureInfo: async () => ({ title: "Preparar la CI", branch: "backcode/ci", prUrl: PR, refinedPrompt: "", ...(kind ? { kind } : {}) }),
    markMerged: async (...args: unknown[]) => void calls.marked.push(args),
    event: async (_id: string, type: string, text: string) => void calls.events.push(`${type}: ${text}`),
    setConflicts: async () => undefined,
  } as unknown as Store;
  const host = {
    kind: "github",
    prState: async () => ({ state: "open" }),
    prChecks: async () => ({ state: "green", pending: [] }),
    merge: async () => ((calls.merged += 1), { sha: "abc123" }),
  } as unknown as PrHost;
  return { cfg, store, host, calls };
}

test("sin confirmCi, el runner no mergea un PR de CI (blocked ciTask)", async () => {
  const { cfg, store, host, calls } = setup("ci");
  const r = await merge(cfg, store, host, "f1");
  assert.equal(r.ok, false);
  assert.equal(r.blocked, "ciTask");
  assert.equal(calls.merged, 0);
  // La acción de la app sin la marca (p. ej. «Mergear todo») tampoco.
  const viaAction = await runAction(cfg, store, host, { type: "merge", featureId: "f1" });
  assert.equal(viaAction.ok, false);
  assert.equal(calls.merged, 0);
});

test("con confirmCi, el merge individual de un PR de CI se hace y queda quién lo confirmó", async () => {
  const { cfg, store, host, calls } = setup("ci");
  const r = await runAction(cfg, store, host, { type: "merge", featureId: "f1", confirmCi: true });
  assert.equal(r.ok, true);
  assert.equal(calls.merged, 1);
  assert.deepEqual(calls.marked, [["f1", "abc123", undefined, true]]);
  assert.equal(calls.events.length, 1);
  assert.match(calls.events[0], /^merge: .*u1/);
});

test("el modo auto nunca mergea un PR de CI, aunque llegue confirmCi", async () => {
  const { cfg, store, host, calls } = setup("ci");
  const r = await merge(cfg, store, host, "f1", { auto: true, confirmCi: true });
  assert.equal(r.blocked, "ciTask");
  assert.equal(calls.merged, 0);
});

test("una tarea normal se mergea sin confirmCi (y sin marca de CI)", async () => {
  const { cfg, store, host, calls } = setup();
  const r = await merge(cfg, store, host, "f1");
  assert.equal(r.ok, true);
  assert.deepEqual(calls.marked, [["f1", "abc123", undefined, false]]);
  assert.equal(calls.events.length, 0);
});
