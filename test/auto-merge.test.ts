import { test } from "node:test";
import assert from "node:assert/strict";
import { autoMerge, clampRetries, type AutoMergeDeps, type AutoMergeState } from "../src/auto-merge.ts";
import type { MergeBlock } from "../src/actions.ts";

type MergeOutcome = { ok: boolean; result: { error?: string; checks?: string[] }; blocked?: MergeBlock };

/** Dependencias falsas: los merges devuelven por orden `merges`; se apuntan estados, arreglos y turnos. */
function deps(merges: MergeOutcome[], extra: Partial<AutoMergeDeps> = {}) {
  const states: AutoMergeState[] = [];
  const calls: string[] = [];
  let turn = false;
  const d: AutoMergeDeps = {
    featureId: "f1",
    base: "main",
    retries: 3,
    hasCi: true,
    merge: async () => {
      assert.ok(turn, "se mergea siempre con el turno del proyecto");
      calls.push("merge");
      return merges.shift() ?? { ok: false, result: { error: "?" }, blocked: "closed" };
    },
    fixChecks: async () => (calls.push("fixChecks"), { ok: true, result: {} }),
    fixConflicts: async () => (calls.push("fixConflicts"), { ok: true, result: {} }),
    setState: async (s) => void states.push(s),
    takeTurn: async () => ((turn = true), true),
    releaseTurn: async () => void (turn = false),
    sleep: async () => undefined,
    ...extra,
  };
  return { d, states, calls };
}

const green: MergeOutcome = { ok: true, result: {} };
const red: MergeOutcome = { ok: false, result: { error: "tests", checks: ["test"] }, blocked: "checks" };
const conflict: MergeOutcome = { ok: false, result: { error: "conflicts" }, blocked: "conflicts" };

test("CI en verde y sin conflictos: se mergea a la primera", async () => {
  const { d, states, calls } = deps([green]);
  const final = await autoMerge(d);
  assert.equal(final.state, "merged");
  assert.deepEqual(calls, ["merge"]);
  assert.equal(states[0].state, "waiting");
});

test("sin CI no se mergea nunca", async () => {
  const { d, calls } = deps([green], { hasCi: false });
  assert.equal((await autoMerge(d)).state, "stopped");
  assert.deepEqual(calls, []);
  const none = deps([{ ok: false, result: { error: "no checks" }, blocked: "noChecks" }], { hasCi: undefined });
  assert.equal((await autoMerge(none.d)).state, "stopped");
});

test("con CI y sin ningún check en el PR: motivo específico, no «sin CI»", async () => {
  const { d, calls } = deps([{ ok: false, result: { error: "no checks" }, blocked: "ciNoChecks" }]);
  const final = await autoMerge(d);
  assert.equal(final.state, "stopped");
  assert.deepEqual(calls, ["merge"]);
  assert.doesNotMatch(final.reason ?? "", /no tiene CI|has no CI|no té CI/);
  assert.match(final.reason ?? "", /CI/);
  const legacy = deps([{ ok: false, result: { error: "no checks" }, blocked: "noChecks" }], { hasCi: true });
  assert.doesNotMatch((await autoMerge(legacy.d)).reason ?? "", /no tiene CI|has no CI|no té CI/);
});

test("checks none porque el PR choca con la base: se arreglan los conflictos y se reintenta, no «sin CI»", async () => {
  const { d, calls, states } = deps([conflict, green]);
  const final = await autoMerge(d);
  assert.equal(final.state, "merged");
  assert.deepEqual(calls, ["merge", "fixConflicts", "merge"]);
  assert.ok(states.every((s) => !/no tiene CI|has no CI|no té CI/.test(s.reason ?? "")));
});

test("checks en rojo o conflictos: Claude arregla (vuelve a En curso) y se reintenta", async () => {
  const { d, states, calls } = deps([red, conflict, green]);
  const final = await autoMerge(d);
  assert.equal(final.state, "merged");
  assert.deepEqual(calls, ["merge", "fixChecks", "merge", "fixConflicts", "merge"]);
  assert.equal(states.filter((s) => s.state === "fixing").length, 2);
  assert.match(states.find((s) => s.state === "fixing")!.reason ?? "", /test/);
});

test("agotados los reintentos queda para revisar, sin más intentos", async () => {
  const { d, calls } = deps([red, red, red, red, red], { retries: 2 });
  const final = await autoMerge(d);
  assert.equal(final.state, "gaveUp");
  assert.equal(final.attempts, 2);
  assert.deepEqual(calls, ["merge", "fixChecks", "merge", "fixChecks", "merge"]);
});

test("serializado: espera a que el otro runner suelte el turno", async () => {
  let tries = 0;
  const { d, calls } = deps([green]);
  const take = d.takeTurn;
  d.takeTurn = async () => (++tries < 3 ? false : take());
  assert.equal((await autoMerge(d)).state, "merged");
  assert.equal(tries, 3);
  assert.deepEqual(calls, ["merge"]);
});

test("el enganche previo al merge puede pararlo", async () => {
  const { d, calls } = deps([green], { beforeMerge: async () => ({ ok: false, reason: "review" }) });
  const final = await autoMerge(d);
  assert.equal(final.state, "stopped");
  assert.match(final.reason ?? "", /review/);
  assert.deepEqual(calls, []);
});

test("reintentos del proyecto entre 1 y 10 (3 por defecto)", () => {
  assert.equal(clampRetries(undefined), 3);
  assert.equal(clampRetries(0), 1);
  assert.equal(clampRetries(50), 10);
  assert.equal(clampRetries(5), 5);
});
