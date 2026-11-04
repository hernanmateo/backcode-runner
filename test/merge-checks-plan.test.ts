import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChecksMode, isBranchProtectionError, mergeChecksPlan, parseChecksMode } from "../src/local-checks.js";

const plan = (mode: ChecksMode, o: Partial<{ skipChecks: boolean; auto: boolean; requireChecks: boolean; local: boolean }> = {}) =>
  mergeChecksPlan({ mode, skipChecks: false, auto: false, requireChecks: false, local: false, ...o });

test("parseChecksMode: sin campo o desconocido, la CI del host", () => {
  assert.equal(parseChecksMode(undefined), "host");
  assert.equal(parseChecksMode("github"), "host");
  assert.equal(parseChecksMode("local"), "local");
  assert.equal(parseChecksMode("none"), "none");
});

test("modo host: la CI del host, o local si Actions está pausado con checks locales", () => {
  assert.equal(plan("host"), "host");
  assert.equal(plan("host", { local: true }), "local");
  assert.equal(plan("local"), "local");
});

test("«Merge sense CI»: salta los checks en cualquier modo, también con «Exigir checks»", () => {
  for (const mode of ["host", "local", "none"] as const) {
    assert.equal(plan(mode, { skipChecks: true }), "skip");
    assert.equal(plan(mode, { skipChecks: true, requireChecks: true }), "skip");
    assert.equal(plan(mode, { skipChecks: true, local: true }), "skip");
  }
});

test("modo sin CI: mergea sin checks salvo con «Exigir checks»", () => {
  assert.equal(plan("none"), "skip");
  assert.equal(plan("none", { requireChecks: true }), "blocked");
});

test("el modo auto nunca mergea sin checks", () => {
  assert.equal(plan("none", { auto: true }), "blocked");
  assert.equal(plan("host", { auto: true, skipChecks: true }), "host");
  assert.equal(plan("local", { auto: true, skipChecks: true }), "local");
  assert.equal(plan("host", { auto: true, local: true }), "local");
});

test("isBranchProtectionError: reconoce la protección de rama de GitHub y Bitbucket", () => {
  assert.ok(isBranchProtectionError(new Error('GraphQL: Required status check "test" is expected. (mergePullRequest)')));
  assert.ok(isBranchProtectionError(new Error("X Pull request #3 is not mergeable: the base branch policy prohibits the merge.")));
  assert.ok(isBranchProtectionError(new Error("At least 1 approving review is required by reviewers with write access.")));
  assert.ok(isBranchProtectionError(new Error("Bitbucket: Merge checks failed")));
  assert.ok(!isBranchProtectionError(new Error("HTTP 502: Bad Gateway")));
  assert.ok(!isBranchProtectionError(new Error("Pull request is not mergeable: merge conflict")));
});
