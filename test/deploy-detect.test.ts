import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDeploys, providerOfCommand } from "../src/deploy-detect.js";

const repo = (contents: Record<string, string>) => ({ files: Object.keys(contents), show: async (p: string) => contents[p] ?? Promise.reject(new Error("no")) });

test("Cloudflare Workers: el worker y, antes, sus migraciones de D1 (jsonc con comentarios y toml)", async () => {
  const jsonc = repo({
    "server/wrangler.jsonc": '{\n  // comentario\n  "name": "api", /* otro */\n  "d1_databases": [{ "binding": "DB", "database_name": "pokescan", "database_id": "x", },],\n}',
    "server/migrations/0001_init.sql": "create table t();",
    "server/src/index.ts": "",
  });
  const found = await detectDeploys(jsonc.files, jsonc.show, new Set());
  assert.deepEqual(found.map((d) => [d.name, d.cmd.join(" "), d.rank]), [
    ["server-db", "npx --yes wrangler d1 migrations apply pokescan --remote", 0],
    ["server", "npx --yes wrangler deploy", 2],
  ]);
  const toml = repo({ "wrangler.toml": 'name = "w"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "main"\nmigrations_dir = "db/migrations"\n', "db/migrations/1.sql": "" });
  assert.deepEqual((await detectDeploys(toml.files, toml.show, new Set())).map((d) => d.name), ["worker-db", "worker"]);
  // Sin migraciones, solo el worker.
  const plain = repo({ "api/wrangler.json": '{ "name": "api" }' });
  assert.deepEqual((await detectDeploys(plain.files, plain.show, new Set())).map((d) => d.name), ["api"]);
});

test("Supabase: migraciones (db push) y edge functions, con el enlace local del proyecto", async () => {
  const r = repo({ "supabase/config.toml": "", "supabase/migrations/2026_init.sql": "", "supabase/functions/hello/index.ts": "" });
  const found = await detectDeploys(r.files, r.show, new Set());
  assert.deepEqual(found.map((d) => [d.name, d.cmd.slice(2).join(" "), d.rank]), [
    ["supabase-db", "supabase db push --linked --yes", 0],
    ["supabase-functions", "supabase functions deploy --yes", 1],
  ]);
  assert.ok(found[0].local?.includes("supabase/.temp/project-ref"));
});

test("Firebase: reglas y functions; y nada de una plataforma que el repo ya declara con su script", async () => {
  const r = repo({ "firebase.json": '{ "firestore": { "rules": "firestore.rules" }, "storage": { "rules": "storage.rules" }, "functions": [{ "source": "functions" }] }', "firestore.rules": "", "storage.rules": "" });
  assert.deepEqual((await detectDeploys(r.files, r.show, new Set())).map((d) => [d.name, d.cmd.at(-2), d.rank]), [
    ["firebase-rules", "firestore,storage", 0],
    ["firebase-functions", "functions", 1],
  ]);
  assert.deepEqual(await detectDeploys(r.files, r.show, new Set(["firebase"])), []);
  assert.equal(providerOfCommand("firebase deploy --only functions"), "firebase");
  assert.equal(providerOfCommand("npx wrangler deploy"), "wrangler");
  assert.equal(providerOfCommand("supabase db push"), "supabase");
  assert.equal(providerOfCommand("./scripts/deploy-web.sh"), null);
});

test("si el proyecto ya tiene su script de despliegue (con pasos previos), se usa ese y no el comando a secas", async () => {
  const r = repo({
    "server/wrangler.jsonc": '{ "name": "api", "d1_databases": [{ "database_name": "pokescan" }] }',
    "server/migrations/0001.sql": "",
    "server/package.json": JSON.stringify({ scripts: { deploy: "npm run export:catalogue && wrangler deploy", "export:catalogue": "node x.mjs", "db:migrate": "wrangler d1 migrations apply pokescan --remote", "db:migrate:local": "wrangler d1 migrations apply pokescan --local" } }),
  });
  const found = await detectDeploys(r.files, r.show, new Set());
  assert.deepEqual(found.map((d) => [d.name, d.script]), [["server-db", "db:migrate"], ["server", "deploy"]]);
  // Sin package.json (o sin script que lo haga), el comando de la plataforma.
  const bare = repo({ "wrangler.toml": 'name = "w"' });
  assert.equal((await detectDeploys(bare.files, bare.show, new Set()))[0].script, undefined);
  const sb = repo({ "supabase/config.toml": "", "supabase/migrations/1.sql": "", "package.json": JSON.stringify({ scripts: { "db:push": "supabase db push --linked" } }) });
  assert.equal((await detectDeploys(sb.files, sb.show, new Set()))[0].script, "db:push");
});
