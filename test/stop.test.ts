import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { exec } from "../src/actions.js";
import { isStoppedError, pointOfNoReturn, stopRequested, throwIfStopped, withStopScope, type StopScope } from "../src/stop.js";
import { waitForChecks } from "../src/wait-checks.js";

const scopeOf = (ctrl: AbortController, marks: string[] = []): StopScope => ({ signal: ctrl.signal, noStop: false, markNoStop: async () => void marks.push("noStop") });

test("pointOfNoReturn: si ya se pidió parar, para ahí; si no, marca noStop una vez y luego ya no se para", async () => {
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(withStopScope(scopeOf(stopped), () => pointOfNoReturn()), (e) => isStoppedError(e));

  const ctrl = new AbortController();
  const marks: string[] = [];
  const s = scopeOf(ctrl, marks);
  await withStopScope(s, async () => {
    await pointOfNoReturn();
    await pointOfNoReturn();
  });
  assert.deepEqual(marks, ["noStop"]);
  assert.equal(s.noStop, true);
  // Fuera de una acción no hace nada.
  await pointOfNoReturn();
  assert.equal(stopRequested(), false);
  throwIfStopped();
});

test("exec: al pedir parar mata el comando (y lo que lanzó) y rechaza con StoppedError", { skip: process.platform === "win32" }, async () => {
  const ctrl = new AbortController();
  const started = Date.now();
  setTimeout(() => ctrl.abort(), 200);
  await assert.rejects(withStopScope(scopeOf(ctrl), () => exec(["sh", "-c", "sleep 30 & sleep 30"], tmpdir())), (e) => isStoppedError(e));
  assert.ok(Date.now() - started < 15_000);
  // Ya parada antes de empezar: ni lo lanza.
  await assert.rejects(withStopScope(scopeOf(ctrl), () => exec(["true"], tmpdir())), (e) => isStoppedError(e));
});

test("waitForChecks: deja de esperar en cuanto se pide parar la acción", async () => {
  const ctrl = new AbortController();
  let reads = 0;
  const res = await withStopScope(scopeOf(ctrl), () =>
    waitForChecks(
      async () => {
        if (++reads === 2) ctrl.abort();
        return { state: "pending", pending: ["ci"] };
      },
      { pollMs: 1, maxMs: 60_000, sleep: async () => undefined },
    ),
  );
  assert.equal(res.state, "pending");
  assert.ok(reads <= 3);
});
