import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { isInstallStep, withoutInstallSteps } from "../src/after-merge.js";
import { DEP_CACHE_ROOT, depCacheDir, depCacheEnv } from "../src/dep-cache.js";
import { depsChanged, lockfileFor, missingLockfiles } from "../src/lockfile-check.js";

test("depCacheDir: una carpeta por proyecto dentro de la del runner, nunca con ids raros", () => {
  assert.ok(depCacheDir("abc_123").startsWith(DEP_CACHE_ROOT));
  assert.throws(() => depCacheDir("../x"));
  assert.throws(() => depCacheDir(""));
});

test("depCacheEnv: todo lo que escriben los gestores va a la caché del proyecto, nada al HOME", () => {
  const dir = depCacheDir("p1");
  const env = depCacheEnv(dir);
  for (const key of ["BUN_INSTALL_CACHE_DIR", "BUN_INSTALL_GLOBAL_DIR", "npm_config_cache", "npm_config_store_dir", "npm_config_cache_dir", "npm_config_state_dir", "YARN_CACHE_FOLDER", "YARN_GLOBAL_FOLDER", "COREPACK_HOME"]) {
    assert.ok(env[key]?.startsWith(dir), key);
  }
  for (const v of Object.values(env)) assert.ok(!v.startsWith(homedir()) || v.startsWith(dir) || !v.includes("/"), v);
  assert.equal(env.npm_config_update_notifier, "false");
});

test("depsChanged: solo los campos de dependencias cuentan", () => {
  const base = JSON.stringify({ name: "a", scripts: { t: "x" }, dependencies: { a: "1" } });
  assert.equal(depsChanged(base, JSON.stringify({ name: "a", scripts: { t: "y" }, dependencies: { a: "1" } })), false);
  assert.equal(depsChanged(base, JSON.stringify({ name: "a", dependencies: { a: "1", b: "2" } })), true);
  assert.equal(depsChanged(base, JSON.stringify({ name: "a", dependencies: { a: "1" }, devDependencies: { c: "1" } })), true);
  assert.equal(depsChanged(null, JSON.stringify({ name: "n", dependencies: { a: "1" } })), true);
  assert.equal(depsChanged(null, JSON.stringify({ name: "n" })), false);
  assert.equal(depsChanged(base, null), false);
  assert.equal(depsChanged(base, "{ roto"), false);
});

test("lockfileFor: el más cercano subiendo carpetas", () => {
  const locks = new Set(["bun.lock", "web/bun.lock"]);
  assert.equal(lockfileFor("web/package.json", locks), "web/bun.lock");
  assert.equal(lockfileFor("functions/package.json", locks), "bun.lock");
  assert.equal(lockfileFor("package.json", locks), "bun.lock");
  assert.equal(lockfileFor("x/package.json", new Set()), null);
});

test("missingLockfiles: dependencias nuevas sin su lockfile", async () => {
  const before: Record<string, string> = {
    "functions/package.json": JSON.stringify({ dependencies: { a: "1" } }),
    "web/package.json": JSON.stringify({ dependencies: { a: "1" } }),
    "app/package.json": JSON.stringify({ dependencies: { a: "1" } }),
  };
  const after: Record<string, string> = {
    "functions/package.json": JSON.stringify({ dependencies: { a: "1", turf: "7" } }),
    "web/package.json": JSON.stringify({ dependencies: { a: "1", "@turf/simplify": "7" } }),
    "app/package.json": JSON.stringify({ dependencies: { a: "1" }, scripts: { x: "y" } }),
  };
  const show = async (rev: "base" | "head", p: string) => (rev === "base" ? before : after)[p] ?? null;
  const tree = ["functions/package.json", "functions/bun.lock", "web/package.json", "web/bun.lock", "app/package.json", "app/package-lock.json"];
  // functions sin su lockfile; web con el suyo cambiado; app solo cambia scripts.
  const changed = ["functions/package.json", "web/package.json", "web/bun.lock", "app/package.json"];
  assert.deepEqual(await missingLockfiles(changed, tree, show), [{ pkg: "functions/package.json", lock: "functions/bun.lock" }]);
  // Sin lockfile en el repo: no se exige.
  assert.deepEqual(await missingLockfiles(["functions/package.json"], ["functions/package.json"], show), []);
});

test("isInstallStep: solo los pasos que son únicamente instalar", () => {
  for (const command of ["cd functions && bun install", "bun install", "npm ci", "npm install --no-audit", "cd web && pnpm install --frozen-lockfile", "yarn", "yarn install"]) {
    assert.equal(isInstallStep({ command }), true, command);
  }
  for (const command of ["bun add lodash", "npm install lodash", "cd functions && bun install && bun run deploy", "npm ci | tee log", "firebase deploy --only functions", "npm run test"]) {
    assert.equal(isInstallStep({ command }), false, command);
  }
  assert.equal(isInstallStep({ command: "bun install", deployTarget: "api" }), false);
  assert.equal(isInstallStep({}), false);
});

test("withoutInstallSteps: quita los de instalar y deja el resto", () => {
  const steps = [{ why: "a", command: "cd web && bun install" }, { why: "b", command: "firebase deploy --only functions" }];
  assert.deepEqual(withoutInstallSteps(steps), [steps[1]]);
  assert.equal(withoutInstallSteps([steps[0]]), undefined);
  assert.equal(withoutInstallSteps(undefined), undefined);
});
