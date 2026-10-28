import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeployEnvContext, firebaseDeployEnv } from "../src/firebase-env.js";

const ctx = (over: Partial<DeployEnvContext> = {}): DeployEnvContext => ({ scripts: {}, firebaserc: null, readFile: async () => null, ...over });

test("firebase directo: canal de preview con alias de .firebaserc", async () => {
  const env = await firebaseDeployEnv("firebase hosting:channel:deploy staging -P staging --expires 7d", ctx({ firebaserc: { default: "derbi-admin", staging: "derbi-admin-staging" } }));
  assert.deepEqual(env, { provider: "firebase", project: "derbi-admin-staging", channel: "staging" });
});

test("firebase deploy con hosting es el sitio principal (live), con el proyecto por defecto", async () => {
  assert.deepEqual(await firebaseDeployEnv("firebase deploy --only hosting --non-interactive", ctx({ firebaserc: { default: "derbi-admin" } })), { provider: "firebase", project: "derbi-admin", channel: "live" });
  assert.deepEqual(await firebaseDeployEnv("npx firebase deploy --project=derbi-admin-staging", ctx()), { provider: "firebase", project: "derbi-admin-staging", channel: "live" });
});

test("sin hosting (functions, reglas) se enseña el --only", async () => {
  assert.deepEqual(await firebaseDeployEnv("firebase deploy --only functions,firestore:rules", ctx({ firebaserc: { default: "p1" } })), { provider: "firebase", project: "p1", only: "functions,firestore:rules" });
});

test("sigue npm run <otro> y firebase use <alias>", async () => {
  const env = await firebaseDeployEnv("npm run deploy:staging", ctx({ scripts: { "deploy:staging": "firebase use staging && firebase deploy --only hosting" }, firebaserc: { default: "p1", staging: "p1-staging" } }));
  assert.deepEqual(env, { provider: "firebase", project: "p1-staging", channel: "live" });
});

test("script de shell con $1: con argumento es el canal; sin él, el sitio principal", async () => {
  const sh = `#!/usr/bin/env bash
set -euo pipefail
npx expo export -p web --output-dir dist
cd ..
if [[ $# -gt 0 ]]; then
  firebase hosting:channel:deploy "$1" --expires 7d --non-interactive
else
  firebase deploy --only hosting --non-interactive
fi
`;
  const files: Record<string, string> = { "scripts/deploy-web.sh": sh };
  const c = ctx({ firebaserc: { default: "backcode-626c6" }, readFile: async (p) => files[p] ?? null });
  assert.deepEqual(await firebaseDeployEnv("./scripts/deploy-web.sh staging", c), { provider: "firebase", project: "backcode-626c6", channel: "staging" });
  assert.deepEqual(await firebaseDeployEnv("./scripts/deploy-web.sh", c), { provider: "firebase", project: "backcode-626c6", channel: "live" });
  assert.deepEqual(await firebaseDeployEnv("bash scripts/deploy-web.sh preview", c), { provider: "firebase", project: "backcode-626c6", channel: "preview" });
});

test("sin firebase no hay entorno; los bucles entre scripts no cuelgan", async () => {
  assert.equal(await firebaseDeployEnv("vercel --prod", ctx()), null);
  assert.equal(await firebaseDeployEnv("npm run a", ctx({ scripts: { a: "npm run b", b: "npm run a" } })), null);
  assert.equal(await firebaseDeployEnv("./scripts/missing.sh", ctx()), null);
});
