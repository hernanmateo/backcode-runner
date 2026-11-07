import assert from "node:assert/strict";
import { test } from "node:test";
import { afterMergeHint, BUILD_AFTER_MERGE_TARGET, checkRunText, checksHint, DEPLOY_TARGET_INPUT, isCheckStep, normalizeAfterMerge, OTA_AFTER_MERGE_TARGET, REPEATABLE_HINT, type CheckCommand } from "../src/after-merge.js";

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

// Los checks de este mismo repo (backcode.toml).
const CHECKS: CheckCommand[] = [
  { name: "app", dir: "app", run: "npm run typecheck && npm run lint" },
  { name: "tests", dir: "tests", run: "npm run test:unit && npm run test:rules" },
  { name: "runner", dir: "backcode-runner", run: "npm run build && npm test" },
];

test("isCheckStep: un check del proyecto (o parte de él) en su carpeta", () => {
  assert.ok(isCheckStep("cd tests && npm run test:rules", CHECKS));
  assert.ok(isCheckStep("cd tests && npm run test:unit && npm run test:rules", CHECKS));
  assert.ok(isCheckStep("cd ./tests/ && npm ci && npm run test:rules", CHECKS));
  assert.ok(isCheckStep("(cd backcode-runner && npm test)", CHECKS));
  assert.ok(isCheckStep("cd backcode-runner &&   npm run test", CHECKS));
  assert.ok(isCheckStep("cd app && npm run lint", CHECKS));
});

test("isCheckStep: ante la duda, no (se queda como paso)", () => {
  assert.equal(isCheckStep("npm run test:rules", CHECKS), false); // la raíz no tiene check
  assert.equal(isCheckStep("cd tests && npm run test:e2e", CHECKS), false); // ningún check lo ejecuta
  assert.equal(isCheckStep("cd app && npm run lint && firebase deploy --only firestore:rules", CHECKS), false);
  assert.equal(isCheckStep("cd tests && npm run test:rules | tee log", CHECKS), false);
  assert.equal(isCheckStep("cd tests && npm ci", CHECKS), false); // solo instalar no es un check
  assert.equal(isCheckStep("cd tests && npm run test:rules", []), false);
  assert.equal(isCheckStep("cd app && cd ../tests && npm run test:rules", CHECKS), false);
  // Un check de la raíz.
  assert.ok(isCheckStep("npm test", [{ name: "all", dir: "", run: "npm test" }]));
});

test("normalizeAfterMerge: quita los pasos que solo ejecutan checks y deja el resto", () => {
  const out = normalizeAfterMerge(
    [
      { why: "Los tests de reglas no se pudieron ejecutar en el sandbox", command: "cd tests && npm run test:rules" },
      { why: "Desplegar las reglas", command: "firebase deploy --only firestore:rules" },
      { why: "Publicar la OTA" },
      { why: "Con destino del repo aunque el comando parezca un check", command: "cd tests && npm run test:rules", deployTarget: "rules" },
    ],
    ["rules"],
    false,
    [],
    false,
    CHECKS,
  );
  assert.deepEqual(
    out?.map((s) => s.why),
    ["Desplegar las reglas", "Publicar la OTA", "Con destino del repo aunque el comando parezca un check"],
  );
  // Sin checks, como antes.
  assert.equal(normalizeAfterMerge([{ why: "Tests", command: "cd tests && npm run test:rules" }], [], false)?.length, 1);
});

test("checksHint: lista los checks y prohíbe ponerlos como paso; run_checks si está", () => {
  assert.equal(checksHint([], true), "");
  const hint = checksHint(CHECKS, true);
  assert.match(hint, /tests \(tests: npm run test:unit && npm run test:rules\)/);
  assert.match(hint, /Never list running tests or these checks as an afterMerge step/);
  assert.match(hint, /call run_checks/);
  assert.doesNotMatch(checksHint(CHECKS, false), /run_checks/);
});

test("checkRunText: el comando de shell o la lista", () => {
  assert.equal(checkRunText(["sh", "-c", "npm test"]), "npm test");
  assert.equal(checkRunText(["make", "test"]), "make test");
});
