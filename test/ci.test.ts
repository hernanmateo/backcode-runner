import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCiConfig } from "../src/ci.js";

test("hasCiConfig: reconoce los ficheros de CI habituales en la raíz", () => {
  assert.equal(hasCiConfig([".github/workflows/ci.yml"]), true);
  assert.equal(hasCiConfig(["src/a.ts", ".github/workflows/test.yaml"]), true);
  assert.equal(hasCiConfig(["bitbucket-pipelines.yml"]), true);
  assert.equal(hasCiConfig([".gitlab-ci.yml"]), true);
  assert.equal(hasCiConfig([".circleci/config.yml"]), true);
  assert.equal(hasCiConfig(["Jenkinsfile"]), true);
});

test("hasCiConfig: no confunde otros ficheros con CI", () => {
  assert.equal(hasCiConfig([]), false);
  assert.equal(hasCiConfig(["src/index.ts", "package.json", ".github/ISSUE_TEMPLATE/bug.yml", ".github/dependabot.yml"]), false);
  // La CI de un subproyecto no corre en este repo (GitHub solo lee .github/workflows de la raíz).
  assert.equal(hasCiConfig(["backcode-runner/.github/workflows/ci.yml"]), false);
});
