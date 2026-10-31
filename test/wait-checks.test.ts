import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checks } from "../src/hosts.js";
import { waitForChecks } from "../src/wait-checks.js";

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
