import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNumberFrom, otaInfoFrom, readVersion, versionDir } from "../src/versions.js";

const files = (map: Record<string, string>) => async (path: string) => map[path];

test("readVersion: expo.version de app.json antes que package.json; sin versión, undefined", async () => {
  assert.equal(await readVersion(files({ "app/app.json": JSON.stringify({ expo: { version: "1.4.0" } }), "app/package.json": '{"version":"1.0.0"}' }), "app"), "1.4.0");
  assert.equal(await readVersion(files({ "backcode-runner/package.json": '{"version":"1.0.78"}' }), "backcode-runner"), "1.0.78");
  assert.equal(await readVersion(files({ "app.json": JSON.stringify({ expo: { version: "2.0.0" } }) }), ""), "2.0.0");
  assert.equal(await readVersion(files({ "landing/index.html": "<html>" }), "landing"), undefined);
  assert.equal(await readVersion(files({ "x/package.json": "no es json" }), "x"), undefined);
});

test("versionDir: reglas y functions no tienen versión; un destino de backcode.toml, la de su única carpeta", () => {
  assert.equal(versionDir({ dir: "tests", env: { only: "firestore:rules" } }, 0), null);
  assert.equal(versionDir({ dir: "tests", env: { only: "functions" } }, 1), null);
  assert.equal(versionDir({ dir: "app" }, 2), "app");
  assert.equal(versionDir({ dir: "" }, 2), null);
  assert.equal(versionDir({ dir: "", auto: { cmd: ["x"], rank: 2, paths: ["backcode-runner"] } }, 2), "backcode-runner");
  assert.equal(versionDir({ dir: "", auto: { cmd: ["x"], rank: 2, paths: ["a", "b"] } }, 2), null);
});

test("buildNumberFrom: el número que asigna EAS", () => {
  assert.equal(buildNumberFrom("✔ Incremented buildNumber from 52 to 53."), "53");
  assert.equal(buildNumberFrom("Initialized versionCode with 1"), "1");
  assert.equal(buildNumberFrom("Build finished"), undefined);
});

test("otaInfoFrom: runtime e id del update de `eas update`", () => {
  const out = "Branch             production\nRuntime version    1.4.0\nPlatform           android, ios\nUpdate group ID    3f2a9c1e-1111-2222-3333-444455556666\n";
  assert.deepEqual(otaInfoFrom(out), { runtimeVersion: "1.4.0", updateId: "3f2a9c1e-1111-2222-3333-444455556666" });
  assert.deepEqual(otaInfoFrom("nada"), {});
});

test("otaInfoFrom: «Runtime versions» (plural) no cuela «s»; se queda con la línea buena", () => {
  const out = "✔ Computed runtime versions\nRuntime versions: checked\nBranch             production\nRuntime version    1.4.0\nUpdate group ID    3f2a9c1e-1111-2222-3333-444455556666\n";
  assert.deepEqual(otaInfoFrom(out), { runtimeVersion: "1.4.0", updateId: "3f2a9c1e-1111-2222-3333-444455556666" });
  assert.deepEqual(otaInfoFrom("Runtime versions  s\nRuntime version   s\n"), {});
  assert.equal(otaInfoFrom("Runtime version: 1.4.0").runtimeVersion, "1.4.0");
});

test("otaInfoFrom: tabla con «│», ids por plataforma y colores ANSI", () => {
  const table = [
    "┌───────────────────┬──────────────────────────────────────┐",
    "│ Branch            │ production                           │",
    "│ Runtime version   │ 1.4.0                                │",
    "│ Platform          │ android, ios                         │",
    "│ Update group ID   │ 3f2a9c1e-1111-2222-3333-444455556666 │",
    "│ Android update ID │ aaaaaaaa-1111-2222-3333-444455556666 │",
    "│ iOS update ID     │ bbbbbbbb-1111-2222-3333-444455556666 │",
    "└───────────────────┴──────────────────────────────────────┘",
  ].join("\n");
  assert.deepEqual(otaInfoFrom(table), { runtimeVersion: "1.4.0", updateId: "3f2a9c1e-1111-2222-3333-444455556666" });
  const ansi = "\u001b[1mBranch\u001b[22m             production\n\u001b[1mRuntime version\u001b[22m    \u001b[36m1.4.0\u001b[39m\n\u001b[1mUpdate group ID\u001b[22m    \u001b[36m3f2a9c1e-1111-2222-3333-444455556666\u001b[39m\n";
  assert.deepEqual(otaInfoFrom(ansi), { runtimeVersion: "1.4.0", updateId: "3f2a9c1e-1111-2222-3333-444455556666" });
  // Sin «Update group ID»: el de la primera plataforma; runtime por plataforma.
  const perPlatform = "Android runtime version  1.4.0\niOS runtime version      1.4.0\nAndroid update ID  aaaaaaaa-1111-2222-3333-444455556666\n";
  assert.deepEqual(otaInfoFrom(perPlatform), { runtimeVersion: "1.4.0", updateId: "aaaaaaaa-1111-2222-3333-444455556666" });
});
