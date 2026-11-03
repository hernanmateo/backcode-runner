// Reintentos automáticos de los despliegues: clasificación de errores (con logs reales de cada proveedor) y límite estricto.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deployAll, withAutoRetry, type ActionResult } from "../src/actions.js";
import type { RunnerConfig } from "../src/config.js";
import { classifyDeployError, clampDeployRetries, type DeployLock, isTransientDeployError, retryDelays } from "../src/deploy-progress.js";
import type { Store } from "../src/store.js";

const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);

test("comunes: red y HTTP 429/5xx son temporales", () => {
  for (const log of [
    "Error: read ECONNRESET",
    "connect ETIMEDOUT 142.250.184.10:443",
    "getaddrinfo EAI_AGAIN firebaseapp.googleapis.com",
    "FetchError: request to api.expo.dev/graphql failed, reason: socket hang up",
    "Error: HTTP Error: 502, Bad Gateway",
    "Request failed: 504 Gateway Timeout",
    "The server responded with status 503: Service Unavailable. Please try again later.",
    "500 Internal Server Error",
    "429 Too Many Requests",
  ])
    assert.equal(classifyDeployError(log), "transient", log);
});

test("Firebase: errores de la API, temporales", () => {
  for (const log of [
    "Error: Failed to list functions for backcode-app",
    "HTTP Error: 503, The service is currently unavailable.",
    "HTTP Error: 429, Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute'",
    "Error: An unexpected error has occurred.",
  ])
    assert.ok(isTransientDeployError(log, "firebase"), log);
});

test("EAS / Expo: errores de los servidores y de subida, temporales", () => {
  for (const log of [
    "Request failed with status code 502",
    "GraphQL request failed.",
    "Error: Failed to upload the bundle to EAS.",
    "Uploading assets timed out after 120000 ms",
    "Expo servers are temporarily unavailable",
  ])
    assert.ok(isTransientDeployError(log, "eas"), log);
});

test("Cloudflare (wrangler), Supabase y git: temporales", () => {
  assert.ok(isTransientDeployError("✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/api) failed. Service Unavailable", "wrangler"));
  assert.ok(isTransientDeployError("error sending request for url (api.supabase.com/v1/projects/abc/functions/x)", "supabase"));
  assert.ok(isTransientDeployError("error: RPC failed; curl 22 The requested URL returned error: 502\nfatal: the remote end hung up unexpectedly", "firebase"));
  assert.ok(isTransientDeployError("fatal: unable to access 'github.com/a/b.git/': Could not resolve host: github.com", "eas"));
});

test("candados: otro despliegue en curso se espera y se reintenta", () => {
  assert.equal(classifyDeployError("Error: Another deployment is already in progress for this site."), "lock");
  assert.equal(classifyDeployError("fatal: Unable to create '/repo/.git/index.lock': File exists."), "lock");
  assert.equal(classifyDeployError("Error: operation already in progress"), "lock");
  assert.ok(isTransientDeployError("Error: Another deployment is already in progress for this site."));
});

test("errores reales: código, compilación, tests, credenciales, configuración y disco no se reintentan", () => {
  for (const log of [
    "src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "Error: Cannot find module 'firebase-functions'",
    "SyntaxError: Unexpected token '}'",
    "Error: functions predeploy error: Command terminated with non-zero exit code 2",
    "Build failed: Gradle build failed with unknown error.",
    "Tests: 2 failed, 40 passed, 42 total",
    "  3 failing",
    "HTTP Error: 401, Request had invalid authentication credentials.",
    "HTTP Error: 403, The caller does not have permission",
    "Error: Failed to authenticate, have you run firebase login? Not logged in",
    "An Expo user account is required to proceed. Log in required.",
    "Your session has expired. Please log in again.",
    "✘ [ERROR] Authentication error [code: 10000]",
    "Missing required environment variable EXPO_TOKEN",
    "Error: ENOSPC: no space left on device, write",
    // Aunque además diga 503: el fallo real manda.
    "error TS2304: Cannot find name 'x'\nHTTP Error: 503",
  ])
    assert.equal(classifyDeployError(log), "real", log);
  assert.equal(classifyDeployError(""), "unknown");
  assert.equal(classifyDeployError("Something odd happened"), "unknown");
});

test("límite: 2 por defecto, nunca más de 3, con espera creciente", () => {
  assert.equal(clampDeployRetries(undefined), 2);
  assert.equal(clampDeployRetries(10), 3);
  assert.equal(clampDeployRetries(-1), 0);
  assert.deepEqual(retryDelays(2), [20_000, 60_000]);
  assert.deepEqual(retryDelays(9), [20_000, 60_000, 120_000]);
});

test("withAutoRetry: al llegar al límite queda fallido con el motivo de cada intento", async () => {
  sleeps.length = 0;
  let calls = 0;
  const notices: string[] = [];
  const done = await withAutoRetry("OTA preview", "eas", async () => (calls++, { ok: false, result: { error: `GraphQL request failed (${calls})` } }), async (n, max, reason) => void notices.push(`${n}/${max} ${reason}`), {
    settings: { on: true, retries: 10 },
    sleep,
  });
  assert.equal(calls, 4);
  assert.equal(done.ok, false);
  assert.deepEqual(sleeps, [20_000, 60_000, 120_000]);
  assert.deepEqual(notices, ["1/3 GraphQL request failed (1)", "2/3 GraphQL request failed (2)", "3/3 GraphQL request failed (3)"]);
  assert.deepEqual(done.result.autoRetry, { retries: 3, max: 3, reasons: ["GraphQL request failed (1)", "GraphQL request failed (2)", "GraphQL request failed (3)", "GraphQL request failed (4)"], transient: true });
});

test("withAutoRetry: si sale bien al reintentar, lo dice; desactivado o noRetry, no reintenta", async () => {
  sleeps.length = 0;
  let calls = 0;
  const ok = await withAutoRetry("functions", "firebase", async () => (++calls === 1 ? { ok: false, result: { error: "HTTP Error: 503" } } : { ok: true, result: {} }), undefined, { settings: { on: true, retries: 2 }, sleep });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.autoRetry?.retries, 1);
  calls = 0;
  const off = await withAutoRetry("functions", "firebase", async () => (calls++, { ok: false, result: { error: "HTTP Error: 503" } }), undefined, { settings: { on: false, retries: 2 }, sleep });
  assert.equal(calls, 1);
  assert.deepEqual(off.result.autoRetry, { retries: 0, max: 0, reasons: ["HTTP Error: 503"], transient: true });
  calls = 0;
  await withAutoRetry("Build", "eas", async () => (calls++, { ok: false, noRetry: true, result: { error: "HTTP Error: 503" } }), undefined, { settings: { on: true, retries: 2 }, sleep });
  assert.equal(calls, 1);
  calls = 0;
  const real = await withAutoRetry("functions", "firebase", async () => (calls++, { ok: false, result: { error: "Not logged in" } }), undefined, { settings: { on: true, retries: 2 }, sleep });
  assert.equal(calls, 1);
  assert.equal(real.result.autoRetry?.transient, false);
});

test("deployAll reintenta cada paso (OTA incluida) y guarda los reintentos en el paso", async () => {
  sleeps.length = 0;
  const store = { plan: { steps: [] }, capabilities: { deploys: [] }, actionProgress: async () => undefined } as unknown as Store;
  const lock: DeployLock = { take: async () => ({ ok: true }), release: async () => undefined };
  let ota = 0;
  const step = async (id: string): Promise<{ ok: boolean; result: ActionResult }> =>
    id.startsWith("ota:") && ++ota < 3 ? { ok: false, result: { error: "Request failed with status code 503" } } : { ok: true, result: { sha: "abc" } };
  const done = await deployAll({} as RunnerConfig, store, undefined, ["deploy:.#rules", "ota:preview"], "msg", false, "a1", { step, lock, sleep, retry: { on: true, retries: 2 } });
  assert.equal(done.ok, true);
  assert.equal(ota, 3);
  assert.equal(done.result.steps?.find((s) => s.id === "ota:preview")?.autoRetry?.retries, 2);
});
