import assert from "node:assert/strict";
import { test } from "node:test";
import { orphanFate } from "../src/store.js";

test("una tarea en marcha de un runner anterior vuelve a la cola mientras le queden intentos", () => {
  assert.equal(orphanFate({ attempts: 0 }, 2), "execute");
  assert.equal(orphanFate({}, 2), "execute");
  assert.equal(orphanFate({ attempts: 2 }, 2), "failed");
});

test("las empezadas con backcode task start (origin local) siguen «En curso»: no son del runner", () => {
  assert.equal(orphanFate({ origin: "local", attempts: 0 }, 2), "keep");
  assert.equal(orphanFate({ origin: "local", attempts: 5 }, 2), "keep");
});

test("las de diagnóstico se tratan como cualquier otra", () => {
  assert.equal(orphanFate({ origin: "diagnostic" }, 2), "execute");
});
