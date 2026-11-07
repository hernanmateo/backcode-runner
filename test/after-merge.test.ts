import assert from "node:assert/strict";
import { test } from "node:test";
import { afterMergeHint, DEPLOY_TARGET_INPUT, normalizeAfterMerge, OTA_AFTER_MERGE_TARGET } from "../src/after-merge.js";

test("afterMergeHint: con OTA en Backcode pide no añadirla como paso manual", () => {
  assert.equal(afterMergeHint([], false), "");
  assert.match(afterMergeHint(["api"], false), /deploy targets.*api/);
  const hint = afterMergeHint([], true);
  assert.match(hint, /do not list publishing an OTA/);
  assert.ok(hint.includes(`"${OTA_AFTER_MERGE_TARGET}"`));
  assert.doesNotMatch(afterMergeHint(["api"], false), /OTA/);
});

test("deployTarget: nombres del repo o el destino reservado de la OTA", () => {
  assert.ok(DEPLOY_TARGET_INPUT.test("api"));
  assert.ok(DEPLOY_TARGET_INPUT.test("backcode:ota"));
  assert.ok(!DEPLOY_TARGET_INPUT.test("backcode:deploy"));
  assert.ok(!DEPLOY_TARGET_INPUT.test("Api"));
});

test("normalizeAfterMerge: solo destinos que existen; el de OTA solo con OTA en Backcode", () => {
  assert.equal(normalizeAfterMerge(undefined, [], true), undefined);
  const steps = [
    { why: "API", deployTarget: "api" },
    { why: "Web", command: "npm run deploy", deployTarget: "web" },
    { why: "OTA", deployTarget: "backcode:ota" },
  ];
  assert.deepEqual(normalizeAfterMerge(steps, ["api"], true), [{ why: "API", deployTarget: "api" }, { why: "Web", command: "npm run deploy" }, { why: "OTA", deployTarget: "backcode:ota" }]);
  assert.deepEqual(normalizeAfterMerge(steps, ["api"], false)?.[2], { why: "OTA" });
});
