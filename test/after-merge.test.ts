import assert from "node:assert/strict";
import { test } from "node:test";
import { afterMergeHint, BUILD_AFTER_MERGE_TARGET, DEPLOY_TARGET_INPUT, normalizeAfterMerge, OTA_AFTER_MERGE_TARGET, REPEATABLE_HINT } from "../src/after-merge.js";

test("afterMergeHint: con OTA en Backcode pide no añadirla como paso manual", () => {
  assert.equal(afterMergeHint([], false), REPEATABLE_HINT);
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

test("afterMergeHint: lo repetible con privilegios, como destino declarado en el propio PR", () => {
  assert.match(afterMergeHint([], false), /\[deploy\.<name>\] entry in backcode\.toml/);
  assert.match(afterMergeHint([], false), /paths = \[\]/);
});

test("normalizeAfterMerge: destinos que añade el propio PR, pendientes del merge", () => {
  const steps = [
    { why: "Datos", deployTarget: "georank-data" },
    { why: "API", deployTarget: "api" },
    { why: "Nada", command: "x", deployTarget: "fantasma" },
    { why: "OTA", deployTarget: "backcode:ota" },
  ];
  assert.deepEqual(normalizeAfterMerge(steps, ["api"], false, ["api", "georank-data", "backcode:ota"]), [
    { why: "Datos", deployTarget: "georank-data", pendingMerge: true },
    { why: "API", deployTarget: "api" },
    { why: "Nada", command: "x" },
    { why: "OTA" },
  ]);
  // Si ya está en la principal no queda pendiente aunque el PR también lo declare.
  assert.deepEqual(normalizeAfterMerge([{ why: "API", deployTarget: "api" }], ["api"], false, ["api"]), [{ why: "API", deployTarget: "api" }]);
});

test("afterMergeHint: con builds en Backcode pide el destino reservado en vez de eas build", () => {
  assert.doesNotMatch(afterMergeHint([], true), /backcode:build/);
  const hint = afterMergeHint([], false, true);
  assert.ok(hint.includes(`"${BUILD_AFTER_MERGE_TARGET}"`));
  assert.match(hint, /don't give an eas build command/);
  assert.doesNotMatch(hint, /OTA/);
});

test("deployTarget y normalizeAfterMerge: el destino reservado de la build solo con builds en Backcode", () => {
  assert.ok(DEPLOY_TARGET_INPUT.test("backcode:build"));
  const steps = [{ why: "Build iOS", deployTarget: "backcode:build" }];
  assert.deepEqual(normalizeAfterMerge(steps, [], false, [], true), [{ why: "Build iOS", deployTarget: "backcode:build" }]);
  assert.deepEqual(normalizeAfterMerge(steps, [], true, [], false), [{ why: "Build iOS" }]);
  // Nunca queda «pendiente del merge» aunque un PR lo nombre.
  assert.deepEqual(normalizeAfterMerge(steps, [], false, ["backcode:build"], false), [{ why: "Build iOS" }]);
});
