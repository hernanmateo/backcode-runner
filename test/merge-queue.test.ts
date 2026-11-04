import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeOrder, setAutoHoldsTurn, withMergeLock, withMergeTurn } from "../src/merge-queue.js";

test("mergeOrder: primero los que no se solapan con nadie (menos ficheros antes), luego los que chocan", () => {
  const order = mergeOrder([
    { id: "big-alone", files: ["a", "b", "c"] },
    { id: "x1", files: ["shared", "x"] },
    { id: "small-alone", files: ["d"] },
    { id: "x2", files: ["shared"] },
  ]);
  assert.deepEqual(order.slice(0, 2), ["small-alone", "big-alone"]);
  // x2 (1 fichero) antes que x1; al quedar solo x1, ya no choca con nadie.
  assert.deepEqual(order.slice(2), ["x2", "x1"]);
});

test("mergeOrder: el que choca con más PR va al final; empates por orden de llegada; sin ficheros, al final", () => {
  const order = mergeOrder([
    { id: "hub", files: ["p", "q", "r"] },
    { id: "a", files: ["p"] },
    { id: "b", files: ["q"] },
    { id: "unknown", files: null },
    { id: "c", files: ["r"] },
  ]);
  assert.deepEqual(order, ["a", "b", "c", "hub", "unknown"]);
  assert.deepEqual(mergeOrder([{ id: "1", files: ["f"] }, { id: "2", files: ["g"] }]), ["1", "2"]);
  assert.deepEqual(mergeOrder([]), []);
});

test("withMergeLock: los merges de este runner van de uno en uno, aunque alguno falle", async () => {
  let live = 0;
  let max = 0;
  const job = (fail: boolean) => async () => {
    max = Math.max(max, ++live);
    await new Promise((r) => setTimeout(r, 15));
    live--;
    if (fail) throw new Error("x");
    return 1;
  };
  const results = await Promise.allSettled([withMergeLock(job(true)), withMergeLock(job(false)), withMergeLock(job(false))]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "fulfilled"]);
  assert.equal(max, 1);
});

test("withMergeTurn: espera el turno, lo suelta al acabar; si lo tiene el modo auto de este runner, ni lo pide ni lo suelta", async () => {
  const log: string[] = [];
  let free = false;
  setTimeout(() => (free = true), 30);
  const res = await withMergeTurn(
    { take: async () => (log.push("take"), free), release: async () => void log.push("release"), stop: () => false, onWait: () => log.push("wait"), pollMs: 10 },
    async () => (log.push("run"), "ok"),
  );
  assert.equal(res, "ok");
  assert.equal(log.filter((l) => l === "wait").length, 1);
  assert.deepEqual(log.slice(-2), ["run", "release"]);

  setAutoHoldsTurn(true);
  const calls: string[] = [];
  await withMergeTurn({ take: async () => (calls.push("take"), true), release: async () => void calls.push("release"), stop: () => false }, async () => void calls.push("run"));
  setAutoHoldsTurn(false);
  assert.deepEqual(calls, ["run"]);
});
