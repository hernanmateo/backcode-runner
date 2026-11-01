import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deployHint, failureOutput, gradleFailure, installCommand, installDirFor, missingModulesHint, storageNotSetUpHint, stripNpmUsage } from "../src/actions.js";
import { classify } from "../src/diagnostics.js";
import { setLangOverride } from "../src/i18n.js";

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

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bc-installdir-"));
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), content);
  }
  return root;
}

test("installDirFor: functions con package.json sin lockfile y raíz con su propio paquete → en functions", () => {
  const root = repo({ "package.json": '{"name":"app"}', "package-lock.json": "{}", "functions/package.json": '{"name":"functions"}' });
  try {
    assert.equal(installDirFor(root, join(root, "functions")), join(root, "functions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installDirFor: functions con su lockfile → en functions", () => {
  const root = repo({ "package.json": "{}", "functions/package.json": "{}", "functions/package-lock.json": "{}" });
  try {
    assert.equal(installDirFor(root, join(root, "functions")), join(root, "functions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installDirFor: monorepo con workspaces que incluyen la carpeta → en la raíz", () => {
  const arr = repo({ "package.json": '{"workspaces":["packages/*","./functions"]}', "package-lock.json": "{}", "packages/api/package.json": "{}", "functions/package.json": "{}", "other/package.json": "{}" });
  const obj = repo({ "package.json": '{"workspaces":{"packages":["apps/**"]}}', "yarn.lock": "", "apps/web/site/package.json": "{}" });
  try {
    assert.equal(installDirFor(arr, join(arr, "packages/api")), arr);
    assert.equal(installDirFor(arr, join(arr, "functions")), arr);
    // Fuera de los workspaces: su carpeta.
    assert.equal(installDirFor(arr, join(arr, "other")), join(arr, "other"));
    assert.equal(installDirFor(obj, join(obj, "apps/web/site"), "yarn.lock"), obj);
  } finally {
    rmSync(arr, { recursive: true, force: true });
    rmSync(obj, { recursive: true, force: true });
  }
});

test("installDirFor: pnpm-workspace.yaml → en la raíz", () => {
  const root = repo({ "package.json": "{}", "pnpm-workspace.yaml": "packages:\n  - apps/*\n", "pnpm-lock.yaml": "", "apps/mobile/package.json": "{}" });
  try {
    assert.equal(installDirFor(root, join(root, "apps/mobile"), "pnpm-lock.yaml"), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installDirFor: carpeta sin package.json (o la propia raíz) → en la raíz", () => {
  const root = repo({ "package.json": "{}", "functions/index.js": "" });
  try {
    assert.equal(installDirFor(root, join(root, "functions")), root);
    assert.equal(installDirFor(root, root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy sin módulos (TS2307): pista con la carpeta en es/en/ca y diagnóstico de Backcode", () => {
  const out = "npx terminó con código 2:\nsrc/index.ts(1,24): error TS2307: Cannot find module 'firebase-functions/v2' or its corresponding type declarations.\nError: functions predeploy error: Command terminated with non-zero exit code 2";
  setLangOverride("es");
  assert.match(missingModulesHint(out, ["functions"]), /Faltan las dependencias de functions/);
  setLangOverride("en");
  assert.match(missingModulesHint(out, ["functions"]), /dependencies of functions are missing/);
  setLangOverride("ca");
  assert.match(missingModulesHint(out, ["functions", "functions", ""]), /Falten les dependències de functions, \. /);
  assert.equal(missingModulesHint("npx terminó con código 1:\nError: HTTP Error: 400", ["functions"]), "");
  assert.equal(classify(out, { thrown: false, source: "detected" }), "backcode");
  // Un script del propio proyecto: sigue siendo cosa del proyecto.
  assert.equal(classify(out, { thrown: false, source: "script" }), null);
});

test("deploy con Storage sin activar: pista en es/en/ca con los dos caminos y el enlace a la consola si viene", () => {
  const url = "https://console.firebase.google.com/project/mi-app-123/storage";
  const out = `npx terminó con código 1:\nError: Firebase Storage has not been set up on project 'mi-app-123'. Go to ${url} and click 'Get Started' to set up Firebase Storage.`;
  setLangOverride("es");
  const es = storageNotSetUpHint(out);
  assert.match(es, /Firebase Storage no está activado/);
  assert.match(es, /Get Started/);
  assert.match(es, /quita la clave "storage" de firebase\.json/);
  assert.ok(es.endsWith(` ${url}`));
  setLangOverride("en");
  assert.match(storageNotSetUpHint(out), /isn't enabled on this Firebase project.*remove the "storage" key/);
  setLangOverride("ca");
  assert.match(storageNotSetUpHint(out), /no està activat.*treu la clau "storage"/);
  // Sin URL: la pista sin enlace.
  const bare = storageNotSetUpHint("Error: Firebase Storage has not been set up on project 'x'.");
  assert.match(bare, /no està activat/);
  assert.doesNotMatch(bare, /https:/);
  // Otros errores: nada.
  assert.equal(storageNotSetUpHint("npx terminó con código 1:\nError: HTTP Error: 400"), "");
  assert.equal(deployHint("npx terminó con código 1:\nError: HTTP Error: 400", ["functions"]), "");
  // deployHint agrupa ambas y mantiene la de módulos que faltan.
  const modules = "error TS2307: Cannot find module 'firebase-functions/v2'";
  setLangOverride("es");
  assert.equal(deployHint(modules, ["functions"]), missingModulesHint(modules, ["functions"]));
  assert.equal(deployHint(out, ["."]), storageNotSetUpHint(out));
});
