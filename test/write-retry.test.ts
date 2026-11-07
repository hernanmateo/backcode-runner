// Escrituras que la app espera para dejar de cargar (resultado de openProjectSession, «open» de Remote Control).
import assert from "node:assert/strict";
import { test } from "node:test";
import { retryWrite } from "../src/write-retry.js";

const noSleep = async () => undefined;

test("un fallo suelto al escribir se reintenta: la app recibe el resultado igual", async () => {
  let calls = 0;
  const r = await retryWrite(
    async () => {
      if (++calls < 3) throw new Error("unavailable");
      return "ok";
    },
    { sleep: noSleep },
  );
  assert.equal(r, "ok");
  assert.equal(calls, 3);
});

test("si sigue fallando, tras los reintentos se lanza el último error", async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    retryWrite(
      async () => {
        calls++;
        throw new Error(`fallo ${calls}`);
      },
      { delaysMs: [1, 2], sleep: async (ms) => void waits.push(ms) },
    ),
    /fallo 3/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1, 2]);
});
