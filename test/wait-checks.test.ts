import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checks } from "../src/hosts.js";
import { gatePrChecks, waitForChecks } from "../src/wait-checks.js";

const pending: Checks = { state: "pending", pending: ["ci: pending"] };

/** Reloj falso: `sleep` adelanta el tiempo al momento, sin esperar de verdad. */
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return { now: () => time, sleep: async (ms: number) => void (sleeps.push(ms), (time += ms)), sleeps };
}

function reader(...seq: Checks[]) {
  let calls = 0;
  return { read: async () => seq[Math.min(calls++, seq.length - 1)]!, calls: () => calls };
}

test("waitForChecks: en verde a la primera no espera", async () => {
  const clock = fakeClock();
  const r = reader({ state: "green", pending: [] });
  assert.equal((await waitForChecks(r.read, { ...clock })).state, "green");
  assert.equal(r.calls(), 1);
  assert.deepEqual(clock.sleeps, []);
});

test("waitForChecks: pending → green devuelve green", async () => {
  const clock = fakeClock();
  let waited = 0;
  const r = reader(pending, pending, { state: "green", pending: [] });
  const out = await waitForChecks(r.read, { ...clock, pollMs: 15_000, maxMs: 900_000, onWait: () => waited++ });
  assert.equal(out.state, "green");
  assert.equal(r.calls(), 3);
  assert.deepEqual(clock.sleeps, [15_000, 15_000]);
  assert.equal(waited, 1);
});

test("waitForChecks: pending → failing devuelve failing", async () => {
  const clock = fakeClock();
  const failing: Checks = { state: "failing", pending: ["test: failure"] };
  const out = await waitForChecks(reader(pending, failing).read, { ...clock });
  assert.deepEqual(out, failing);
});

test("waitForChecks: al agotar el tiempo devuelve los checks en curso", async () => {
  const clock = fakeClock();
  const r = reader(pending);
  const out = await waitForChecks(r.read, { ...clock, pollMs: 15_000, maxMs: 40_000 });
  assert.equal(out.state, "pending");
  assert.deepEqual(clock.sleeps, [15_000, 15_000, 10_000]);
  assert.equal(r.calls(), 4);
});

test("waitForChecks: deja de esperar al parar el runner", async () => {
  const clock = fakeClock();
  let stop = false;
  const r = reader(pending);
  const out = await waitForChecks(r.read, { ...clock, sleep: async (ms) => { await clock.sleep(ms); stop = true; }, shouldStop: () => stop });
  assert.equal(out.state, "pending");
  assert.equal(r.calls(), 1);
});

const none: Checks = { state: "none", pending: [] };
const green: Checks = { state: "green", pending: [] };

test("waitForChecks: sin noneGraceMs, none se devuelve al momento (repo sin CI)", async () => {
  const clock = fakeClock();
  const r = reader(none, green);
  assert.equal((await waitForChecks(r.read, { ...clock })).state, "none");
  assert.equal(r.calls(), 1);
});

test("waitForChecks: con CI, none → pending → green espera a que aparezcan y devuelve green", async () => {
  const clock = fakeClock();
  const r = reader(none, none, pending, green);
  const out = await waitForChecks(r.read, { ...clock, pollMs: 15_000, maxMs: 900_000, noneGraceMs: 240_000 });
  assert.equal(out.state, "green");
  assert.equal(r.calls(), 4);
});

test("waitForChecks: con CI, none persistente se deja de esperar al acabar el margen", async () => {
  const clock = fakeClock();
  const r = reader(none);
  const out = await waitForChecks(r.read, { ...clock, pollMs: 15_000, maxMs: 900_000, noneGraceMs: 60_000 });
  assert.equal(out.state, "none");
  assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), 60_000);
  assert.equal(clock.now(), 60_000);
});

test("waitForChecks: el margen de none no alarga la espera de pending más allá de maxMs", async () => {
  const clock = fakeClock();
  const r = reader(none, pending);
  const out = await waitForChecks(r.read, { ...clock, pollMs: 15_000, maxMs: 120_000, noneGraceMs: 60_000 });
  assert.equal(out.state, "pending");
  assert.equal(clock.now(), 120_000);
});

function gateDeps(seq: Checks[], conflicts: string[][], ciExpected: boolean) {
  const clock = fakeClock();
  const r = reader(...seq);
  let conflictCalls = 0;
  return {
    deps: { read: r.read, conflicts: async () => conflicts[Math.min(conflictCalls++, conflicts.length - 1)] ?? [], ciExpected, wait: { ...clock, pollMs: 15_000, maxMs: 900_000, noneGraceMs: 240_000 } },
    reads: r.calls,
    conflictCalls: () => conflictCalls,
    clock,
  };
}

test("gatePrChecks: checks none porque el PR choca con la base → conflictos, sin esperar", async () => {
  const g = gateDeps([none], [["app/chat.tsx"]], true);
  const out = await gatePrChecks(g.deps);
  assert.deepEqual(out.conflicts, ["app/chat.tsx"]);
  assert.equal(out.ciNoChecks, undefined);
  assert.equal(g.reads(), 1);
  assert.deepEqual(g.clock.sleeps, []);
});

test("gatePrChecks: con CI, none → pending → green devuelve green", async () => {
  const g = gateDeps([none, pending, green], [[]], true);
  const out = await gatePrChecks(g.deps);
  assert.equal(out.checks.state, "green");
  assert.equal(out.conflicts, undefined);
  assert.equal(out.ciNoChecks, undefined);
  assert.equal(g.reads(), 3);
});

test("gatePrChecks: con CI, none persistente sin conflictos → ciNoChecks (no «sin CI»)", async () => {
  const g = gateDeps([none], [[]], true);
  const out = await gatePrChecks(g.deps);
  assert.equal(out.checks.state, "none");
  assert.equal(out.ciNoChecks, true);
  assert.equal(g.conflictCalls(), 2);
});

test("gatePrChecks: con CI, none persistente y conflictos que aparecen durante la espera → conflictos", async () => {
  const g = gateDeps([none], [[], ["a.ts"]], true);
  assert.deepEqual((await gatePrChecks(g.deps)).conflicts, ["a.ts"]);
});

test("gatePrChecks: sin CI, none se devuelve al momento como antes", async () => {
  const g = gateDeps([none, green], [[]], false);
  const out = await gatePrChecks(g.deps);
  assert.equal(out.checks.state, "none");
  assert.equal(out.ciNoChecks, undefined);
  assert.equal(g.reads(), 1);
  assert.deepEqual(g.clock.sleeps, []);
});

test("gatePrChecks: con checks en verde no mira conflictos", async () => {
  const g = gateDeps([green], [["x"]], true);
  assert.equal((await gatePrChecks(g.deps)).checks.state, "green");
  assert.equal(g.conflictCalls(), 0);
});
