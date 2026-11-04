import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CACHE_MAX, CACHE_TTL_MS, checkKey, fileChecksCache, pruneCache } from "../src/checks-cache.js";

test("pruneCache: fuera lo caducado (7 días) y, si sobran, lo más antiguo", () => {
  const now = 10 * CACHE_TTL_MS;
  assert.deepEqual(pruneCache({ viejo: now - CACHE_TTL_MS, nuevo: now - 1000 }, now), { nuevo: now - 1000 });
  const many = Object.fromEntries(Array.from({ length: CACHE_MAX + 5 }, (_, i) => [`k${i}`, now - i]));
  const kept = pruneCache(many, now);
  assert.equal(Object.keys(kept).length, CACHE_MAX);
  assert.equal("k0" in kept, true);
  assert.equal(`k${CACHE_MAX + 4}` in kept, false);
});

test("fileChecksCache: recuerda, caduca y aguanta un fichero roto", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cc-")), "checks-cache.json");
  let now = 1_000_000;
  const cache = fileChecksCache(file, () => now);
  assert.equal(cache.has("a"), false);
  cache.remember("a");
  assert.equal(cache.has("a"), true);
  assert.equal(readFileSync(file, "utf8").includes('"a"'), true);
  now += CACHE_TTL_MS;
  assert.equal(cache.has("a"), false);
  cache.remember("b");
  assert.equal(readFileSync(file, "utf8").includes('"a"'), false); // lo caducado se borra al escribir
  writeFileSync(file, "{roto");
  assert.equal(cache.has("b"), false);
  cache.remember("c");
  assert.equal(cache.has("c"), true);
});

test("checkKey: misma clave con el mismo contenido de sus paths; cambia si cambian ellos o el comando", async () => {
  const objects: Record<string, string> = { "sha1:app": "t-app-1", "sha2:app": "t-app-1", "sha3:app": "t-app-2", "sha1^{tree}": "root1", "sha2^{tree}": "root2" };
  const gitFn = async (_repo: string, args: string[]) => objects[args[1]] ?? Promise.reject(new Error("no existe"));
  const app = { name: "app", dir: "app", cmd: ["sh", "-c", "npm test"], install: true, paths: ["app"] };
  const k1 = await checkKey("/r", "sha1", app, gitFn);
  assert.equal(await checkKey("/r", "sha2", app, gitFn), k1); // otro commit (p. ej. el squash), mismo app/
  assert.notEqual(await checkKey("/r", "sha3", app, gitFn), k1); // app/ cambió
  assert.notEqual(await checkKey("/r", "sha1", { ...app, cmd: ["sh", "-c", "npm run lint"] }, gitFn), k1);
  // Sin paths: todo el repo (el árbol raíz).
  const all = { ...app, paths: [] };
  assert.notEqual(await checkKey("/r", "sha1", all, gitFn), await checkKey("/r", "sha2", all, gitFn));
  // Un path que no existe en ese commit también cuenta (no rompe).
  assert.equal(typeof (await checkKey("/r", "sha1", { ...app, paths: ["app", "no-existe"] }, gitFn)), "string");
});
