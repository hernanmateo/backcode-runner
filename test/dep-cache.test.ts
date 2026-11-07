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

// --- Limpieza de la caché (cleanDepCache) ---

import { mkdirSync, mkdtempSync, existsSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDepCache, DEP_CACHE_ACTIVE_MS, DEP_CACHE_IDLE_MS, dirBytes, LAST_USED } from "../src/dep-cache.js";

const NOW = Date.UTC(2026, 10, 7, 12);

/** Una caché de proyecto con `bytes` de contenido, usada por última vez hace `ago` ms. */
function cache(root: string, id: string, ago: number, bytes = 10): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "bun"), { recursive: true });
  writeFileSync(join(dir, "bun", "pkg.tgz"), Buffer.alloc(bytes));
  const marker = join(dir, LAST_USED);
  writeFileSync(marker, "x");
  const t = (NOW - ago) / 1000;
  utimesSync(marker, t, t);
  return dir;
}

test("cleanDepCache: vacía la de un proyecto desconectado, la caducada y la que pasa del tope; deja las demás", () => {
  const root = mkdtempSync(join(tmpdir(), "depcache-"));
  const gone = cache(root, "gone", DEP_CACHE_ACTIVE_MS * 2);
  const old = cache(root, "old", DEP_CACHE_IDLE_MS + 1000);
  const big = cache(root, "big", DEP_CACHE_ACTIVE_MS * 2, 5000);
  const ok = cache(root, "ok", DEP_CACHE_ACTIVE_MS * 2);
  const r = cleanDepCache({ root, connected: new Set(["old", "big", "ok"]), maxBytes: 1000, now: NOW });
  assert.deepEqual(
    r.removed.map((x) => [x.id, x.reason]).sort(),
    [["big", "tooBig"], ["gone", "disconnected"], ["old", "idle"]],
  );
  assert.ok(r.freedBytes >= 5000);
  assert.ok(!existsSync(gone) && !existsSync(old) && !existsSync(big));
  assert.ok(existsSync(ok));
});

test("cleanDepCache: nunca toca una caché en uso (este runner ocupado o usada hace menos de 2 h)", () => {
  const root = mkdtempSync(join(tmpdir(), "depcache-"));
  const busy = cache(root, "busy", DEP_CACHE_IDLE_MS + 1000, 5000); // caducada y enorme, pero con una tarea en marcha
  const recent = cache(root, "recent", 60_000); // desconectada, pero usada hace un minuto (quizá por otro runner)
  const r = cleanDepCache({ root, connected: new Set(["busy"]), busy: new Set(["busy"]), maxBytes: 1000, now: NOW });
  assert.deepEqual(r.removed, []);
  assert.ok(existsSync(busy) && existsSync(recent));
});

test("cleanDepCache: no sigue enlaces simbólicos ni toca nombres que no son ids", () => {
  const root = mkdtempSync(join(tmpdir(), "depcache-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "keep.txt"), "importante");
  // Un enlace en la raíz con nombre de proyecto desconectado: no es una carpeta nuestra, no se sigue.
  symlinkSync(outside, join(root, "linked"));
  // Dentro de una caché que sí se vacía, un enlace hacia fuera: se borra el enlace, nunca su destino.
  const gone = cache(root, "gone", DEP_CACHE_ACTIVE_MS * 2);
  symlinkSync(outside, join(gone, "escape"));
  mkdirSync(join(root, "not an id"), { recursive: true });
  const r = cleanDepCache({ root, connected: new Set(), maxBytes: 1, now: NOW });
  assert.deepEqual(r.removed.map((x) => x.id), ["gone"]);
  assert.ok(existsSync(join(outside, "keep.txt")));
  assert.ok(existsSync(join(root, "linked")) && existsSync(join(root, "not an id")));
});

test("dirBytes: suma ficheros sin seguir enlaces", () => {
  const root = mkdtempSync(join(tmpdir(), "depcache-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "big"), Buffer.alloc(100_000));
  writeFileSync(join(root, "a"), Buffer.alloc(300));
  symlinkSync(outside, join(root, "link"));
  assert.equal(dirBytes(root), 300);
});

test("cleanDepCache: sin raíz no hace nada", () => {
  assert.deepEqual(cleanDepCache({ root: join(tmpdir(), "no-existe-" + process.pid), connected: new Set(), maxBytes: 1, now: NOW }), { removed: [], freedBytes: 0 });
});
