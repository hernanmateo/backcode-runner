import assert from "node:assert/strict";
import { test } from "node:test";
import { Timestamp } from "firebase/firestore";
import { Store } from "../src/store.js";

function fake(): Store {
  const s = Object.create(Store.prototype) as Store;
  (s as unknown as { cfg: unknown }).cfg = { runnerId: "r1" };
  return s;
}

test("la renovación del lock conserva githubActions, queue, plan y prs (se escribe sin merge)", () => {
  const s = fake();
  s.githubActions = { minutes: 10 };
  s.queue = { reason: "x", featureIds: ["a"], at: Timestamp.now() };
  s.plan = { a: 1 } as never;
  s.prs = { items: [] };
  const p = s.lockPayload();
  assert.deepEqual(p.githubActions, { minutes: 10 });
  assert.equal((p.queue as { reason: string }).reason, "x");
  assert.deepEqual(p.plan, { a: 1 });
  assert.deepEqual(p.prs, { items: [] });
  assert.equal(p.holder, "r1");
});

test("sin estado guardado no se escriben campos vacíos", () => {
  const p = fake().lockPayload();
  assert.ok(!("githubActions" in p) && !("queue" in p));
});
