import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChecksVerification, verifiedChecksPlan, type MergeChecksInput, readVerification, shouldVerifyAfterTask, VERIFY_MAX_AGE_MS } from "../src/checks-verify.js";

const NOW = 1_800_000_000_000;
const passed: ChecksVerification = { state: "passed", headSha: "h1", baseSha: "b1", checkedAt: NOW - 60_000, checks: ["app", "runner"] };
const input = (over: Partial<MergeChecksInput> = {}): MergeChecksInput => ({ mode: "local", verification: passed, headSha: "h1", baseSha: "b1", baseContained: false, checks: ["runner", "app"], now: NOW, ...over });

test("shouldVerifyAfterTask: solo con checks en local y alguno declarado", () => {
  assert.equal(shouldVerifyAfterTask("local", 2), true);
  assert.equal(shouldVerifyAfterTask("local", 0), false);
  assert.equal(shouldVerifyAfterTask("host", 2), false);
  assert.equal(shouldVerifyAfterTask(undefined, 2), false);
  assert.equal(shouldVerifyAfterTask("none", 2), false);
});

test("verifiedChecksPlan: local, verificado en verde y nada ha cambiado → reuse", () => {
  assert.equal(verifiedChecksPlan(input()), "reuse");
});

test("verifiedChecksPlan: host (o modo desconocido/ausente) → la CI del host, aunque haya verificación", () => {
  assert.equal(verifiedChecksPlan(input({ mode: "host" })), "host");
  assert.equal(verifiedChecksPlan(input({ mode: undefined })), "host");
  assert.equal(verifiedChecksPlan(input({ mode: "raro" })), "host");
});

test("verifiedChecksPlan: none o skipChecks → nada que comprobar", () => {
  assert.equal(verifiedChecksPlan(input({ mode: "none" })), "none");
  assert.equal(verifiedChecksPlan(input({ mode: "none", verification: null })), "none");
  assert.equal(verifiedChecksPlan(input({ skipChecks: true })), "none");
  assert.equal(verifiedChecksPlan(input({ mode: "host", skipChecks: true })), "none");
});

test("verifiedChecksPlan: el PR cambió → run", () => {
  assert.equal(verifiedChecksPlan(input({ headSha: "h2" })), "run");
  assert.equal(verifiedChecksPlan(input({ headSha: "" })), "run");
});

test("verifiedChecksPlan: la base se movió → run, salvo que la rama ya la contenga", () => {
  assert.equal(verifiedChecksPlan(input({ baseSha: "b2" })), "run");
  assert.equal(verifiedChecksPlan(input({ baseSha: "b2", baseContained: true })), "reuse");
});

test("verifiedChecksPlan: sin verificación, en rojo o aún verificando → run", () => {
  assert.equal(verifiedChecksPlan(input({ verification: null })), "run");
  assert.equal(verifiedChecksPlan(input({ verification: undefined })), "run");
  assert.equal(verifiedChecksPlan(input({ verification: { ...passed, state: "failed" } })), "run");
  assert.equal(verifiedChecksPlan(input({ verification: { ...passed, state: "verifying" } })), "run");
});

test("verifiedChecksPlan: antigua, sin fecha o con otros checks → run", () => {
  assert.equal(verifiedChecksPlan(input({ verification: { ...passed, checkedAt: NOW - VERIFY_MAX_AGE_MS - 1 } })), "run");
  assert.equal(verifiedChecksPlan(input({ verification: { ...passed, checkedAt: undefined } })), "run");
  assert.equal(verifiedChecksPlan(input({ checks: ["app"] })), "run");
  assert.equal(verifiedChecksPlan(input({ checks: ["app", "runner", "e2e"] })), "run");
  assert.equal(verifiedChecksPlan(input({ checks: [], verification: { ...passed, checks: [] } })), "run");
});

test("readVerification: convierte el Timestamp y descarta lo que no tiene forma", () => {
  const v = readVerification({ state: "passed", headSha: "h", baseSha: "b", checkedAt: { toMillis: () => 42 }, checks: ["a", 3], summary: "x" });
  assert.deepEqual(v, { state: "passed", headSha: "h", baseSha: "b", checkedAt: 42, checks: ["a"], summary: "x" });
  assert.equal(readVerification(null), null);
  assert.equal(readVerification({ state: "ok", headSha: "h", baseSha: "b" }), null);
  assert.equal(readVerification({ state: "passed", headSha: 1, baseSha: "b" }), null);
});
