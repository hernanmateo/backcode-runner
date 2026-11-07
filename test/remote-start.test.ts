import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRemoteStartPrompt } from "../src/prompt.js";
import { remoteArgs, startsInRemote } from "../src/remote.js";
import type { Feature } from "../src/store.js";

test("remoteArgs: retomar la sesión de la tarea, como siempre", () => {
  assert.deepEqual(remoteArgs({ bin: "claude", name: "P · T", sessionId: "abc" }), ["claude", "--resume", "abc", "--remote-control", "P · T"]);
});

test("remoteArgs: sesión nueva con id, modelo, modo plan y el encargo tras --", () => {
  assert.deepEqual(remoteArgs({ bin: "claude", name: "P · T", newSessionId: "u-1", model: "claude-opus-5-5", planMode: true, prompt: "-hola" }), [
    "claude",
    "--session-id",
    "u-1",
    "--model",
    "claude-opus-5-5",
    "--permission-mode",
    "plan",
    "--remote-control",
    "P · T",
    "--",
    "-hola",
  ]);
  // Sin modelo ni plan: solo el id.
  assert.deepEqual(remoteArgs({ bin: "claude", name: "n", newSessionId: "u-2" }), ["claude", "--session-id", "u-2", "--remote-control", "n"]);
});

test("startsInRemote: solo recién aceptada (sin sesión) y con Remote Control pedido", () => {
  assert.equal(startsInRemote({ requested: true, handoff: false, ci: false }), true);
  assert.equal(startsInRemote({ requested: false, handoff: false, ci: false }), false);
  // Con sesión: se retoma (el camino de siempre), no se arranca otra.
  assert.equal(startsInRemote({ requested: true, sessionId: "s", handoff: false, ci: false }), false);
  assert.equal(startsInRemote({ requested: true, handoff: true, ci: false }), false);
  assert.equal(startsInRemote({ requested: true, handoff: false, ci: true }), false);
});

test("buildRemoteStartPrompt: el encargo, la rama y quién publica el PR o el plan", () => {
  const feature = { title: "Botón", refinedPrompt: "Añade un botón", acceptanceCriteria: ["Sale"] } as Feature;
  const run = buildRemoteStartPrompt("f1", feature, { planning: false, branch: "backcode/ana/f1", base: "origin/main" });
  assert.match(run, /<feature_request id="f1">/);
  assert.match(run, /backcode\/ana\/f1/);
  assert.match(run, /opens the pull request/);
  assert.doesNotMatch(run, /PLAN MODE/);
  const plan = buildRemoteStartPrompt("f1", feature, { planning: true, branch: "b", base: "origin/main" });
  assert.match(plan, /PLAN MODE/);
  assert.match(plan, /sends the plan for approval/);
});
