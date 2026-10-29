import assert from "node:assert/strict";
import { test } from "node:test";
import { mapDecision } from "../src/knowledge.js";

const H = 60 * 60_000;
const now = 1_000_000_000_000;

test("mapa del código: Actualizar ahora, como mucho uno cada 10 minutos", () => {
  assert.equal(mapDecision({ force: true, now, commit: "b", saved: { commit: "b", updatedAt: now - 5 * 60_000 } }), "tooSoon");
  assert.equal(mapDecision({ force: true, now, commit: "b", saved: { commit: "b", updatedAt: now - 11 * 60_000 } }), "refresh");
  assert.equal(mapDecision({ force: true, now, commit: "b", saved: {} }), "refresh");
});

test("mapa del código: solo si cambió la rama y tiene más de 24 h", () => {
  assert.equal(mapDecision({ force: false, now, commit: "b", saved: { commit: "b", updatedAt: now - 48 * H } }), "skip");
  assert.equal(mapDecision({ force: false, now, commit: "c", saved: { commit: "b", updatedAt: now - 25 * H } }), "refresh");
  assert.equal(mapDecision({ force: false, now, commit: "c", saved: { commit: "b", updatedAt: now - 2 * H }, files: { saved: 200, now: 210 } }), "skip");
  assert.equal(mapDecision({ force: false, now, commit: "c", saved: {} }), "refresh");
});

test("mapa del código: la excepción del repo casi vacío, una sola vez", () => {
  const young = { commit: "b", updatedAt: now - 2 * H };
  assert.equal(mapDecision({ force: false, now, commit: "c", saved: young, files: { saved: 3, now: 80 } }), "early");
  assert.equal(mapDecision({ force: false, now, commit: "c", saved: { ...young, earlyRefresh: true }, files: { saved: 3, now: 80 } }), "skip");
  assert.equal(mapDecision({ force: false, now, commit: "c", saved: young, files: { saved: 3, now: 6 } }), "skip");
});
