import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientGhError, mergeWithRetry } from "../src/hosts.js";

const ghError = (stderr: string) => Object.assign(new Error("Command failed: gh pr merge https://github.com/o/r/pull/1 --squash --delete-branch"), { stderr });
const graphql = ghError("GraphQL: Something went wrong while executing your query on 2026-10-30T14:25:58Z. Please include `153F:2A244A` when reporting this issue.");

test("isTransientGhError: reconoce los fallos pasajeros de GitHub y no los del PR", () => {
  assert.equal(isTransientGhError(graphql), true);
  assert.equal(isTransientGhError(ghError("HTTP 502: Bad Gateway")), true);
  assert.equal(isTransientGhError(ghError("Pull request is not mergeable: the merge commit cannot be cleanly created.")), false);
  assert.equal(isTransientGhError(ghError("GraphQL: Required status check \"ci\" is expected.")), false);
});

test("mergeWithRetry: reintenta un error GraphQL transitorio y acaba mergeando", async () => {
  let calls = 0;
  await mergeWithRetry(async () => { if (++calls < 2) throw graphql; }, async () => "OPEN", [0, 0]);
  assert.equal(calls, 2);
});

test("mergeWithRetry: da por bueno el merge si el PR ya consta como mergeado", async () => {
  let calls = 0;
  await mergeWithRetry(async () => { calls++; throw ghError("failed to delete local branch"); }, async () => "MERGED", [0, 0]);
  assert.equal(calls, 1);
});

test("mergeWithRetry: no reintenta los errores del PR y se rinde tras los reintentos", async () => {
  let calls = 0;
  const conflict = ghError("Pull request is not mergeable");
  await assert.rejects(mergeWithRetry(async () => { calls++; throw conflict; }, async () => "OPEN", [0, 0]), conflict);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(mergeWithRetry(async () => { calls++; throw graphql; }, async () => "OPEN", [0, 0]), graphql);
  assert.equal(calls, 3);
});
