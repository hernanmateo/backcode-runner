import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { failureOutput, gradleFailure, installCommand, stripNpmUsage } from "../src/actions.js";
import { classify } from "../src/diagnostics.js";

test("npm sin lockfile: npm install en vez de npm ci; con lockfile u otro gestor, el congelado", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-install-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    assert.deepEqual(installCommand("npm", ["npm", "ci"], dir), ["npm", "install", "--no-audit", "--no-fund"]);
    assert.deepEqual(installCommand("pnpm", ["pnpm", "install", "--frozen-lockfile"], dir), ["pnpm", "install", "--frozen-lockfile"]);
    writeFileSync(join(dir, "npm-shrinkwrap.json"), "{}");
    assert.deepEqual(installCommand("npm", ["npm", "ci"], dir), ["npm", "ci"]);
    rmSync(join(dir, "npm-shrinkwrap.json"));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    assert.deepEqual(installCommand("npm", ["npm", "ci"], dir), ["npm", "ci"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const USAGE = [
  "npm error Clean install a project",
  "npm error",
  "npm error Usage:",
  "npm error npm ci",
  "npm error",
  "npm error Options:",
  "npm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]",
  ...Array.from({ length: 200 }, (_, i) => `npm error   --option-${i}\nnpm error     Some long description of option ${i}.\nnpm error`),
  "npm error aliases: clean-install, ic, install-clean, isntall-clean",
  "npm error",
  'npm error Run "npm help ci" for more info',
].join("\n");

test("quita la ayuda de uso de npm y deja el error que la explica", () => {
  const out = [
    "npm error code EUSAGE",
    "npm error",
    "npm error `npm ci` can only install packages when your package.json and",
    "npm error package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.",
    "npm error",
    USAGE,
    "npm error A complete log of this run can be found in: ~/.npm/_logs/x-debug-0.log",
  ].join("\n");
  const stripped = stripNpmUsage(out);
  assert.doesNotMatch(stripped, /--option-|Usage:|npm help ci/);
  assert.match(stripped, /are in sync/);
  assert.match(stripped, /A complete log/);
  assert.ok(stripped.length < 2800);
  // Lockfile desfasado: del proyecto, no se envía como diagnóstico.
  assert.equal(classify(`npm ci terminó con código 1:\n${stripped}`, { thrown: false, source: "detected" }), null);
  // Sin ayuda de uso, no cambia nada.
  assert.equal(stripNpmUsage("npm error code E404\nnpm error 404 Not Found"), "npm error code E404\nnpm error 404 Not Found");
});

test("fallo de Gradle: el «What went wrong» va delante aunque la traza final lo deje fuera del recorte", () => {
  const out = [
    "[RUN_GRADLEW] > Task :app:bundleRelease FAILED",
    "[RUN_GRADLEW] FAILURE: Build failed with an exception.",
    "[RUN_GRADLEW] * What went wrong:",
    "[RUN_GRADLEW] Could not determine the dependencies of task ':app:bundleRelease'.",
    "[RUN_GRADLEW] > SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.",
    "[RUN_GRADLEW] * Try:",
    "[RUN_GRADLEW] > Run with --stacktrace option to get the stack trace.",
    "[RUN_GRADLEW] BUILD FAILED in 12s",
    ...Array.from({ length: 200 }, (_, i) => `    at buildAsync (node_modules/@expo/build-tools/dist/android.js:47:${i})`),
    "Error: build command failed.",
  ].join("\n");
  assert.equal(gradleFailure(out), "[RUN_GRADLEW] Could not determine the dependencies of task ':app:bundleRelease'.\n[RUN_GRADLEW] > SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.");
  const shown = failureOutput(out, 2800);
  assert.ok(shown.length <= 2800);
  assert.match(shown, /SDK location not found/);
  assert.match(shown, /build command failed\.$/);
  // Sin Gradle, o si la causa ya cabe en el recorte, igual que antes.
  assert.equal(failureOutput("npm error code E404", 2800), "npm error code E404");
  const short = out.split("\n").slice(0, 8).join("\n");
  assert.equal(failureOutput(short, 2800), short);
});
