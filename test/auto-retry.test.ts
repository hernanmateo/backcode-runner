import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, clampRetryMax, decideRetry, retryDue, RETRY_DELAYS_MS, type AutoRetryState } from "../src/auto-retry.ts";

const kind = (error: string, extra: { errorCode?: string; cancelled?: boolean } = {}) => classifyFailure({ error, ...extra });

test("classifyFailure: errores temporales se reintentan", () => {
  for (const [error, k] of [
    ["Error: read ECONNRESET", "network"],
    ["connect ETIMEDOUT 140.82.112.3:443", "network"],
    ["getaddrinfo EAI_AGAIN api.anthropic.com", "network"],
    ["socket hang up", "network"],
    ["API Error: 500 Internal Server Error", "overloaded"],
    ["502 Bad Gateway", "overloaded"],
    ["503 Service Unavailable", "overloaded"],
    ["504 Gateway Timeout", "overloaded"],
    ['API Error: 529 {"type":"overloaded_error"}', "overloaded"],
    ["Overloaded", "overloaded"],
    ["Please try again later", "overloaded"],
    ["El runner se detuvo durante la ejecución", "interrupted"],
    ["The runner stopped during the run", "interrupted"],
    ["El runner s'ha aturat durant l'execució", "interrupted"],
    ["lease expired", "interrupted"],
    ["! [rejected] backcode/x -> backcode/x (fetch first)\nerror: failed to push some refs", "pushRejected"],
    ["Updates were rejected because the tip of your current branch is behind (non-fast-forward)", "pushRejected"],
  ] as const) {
    assert.deepEqual(kind(error), { kind: k, retry: true }, error);
  }
});

test("classifyFailure: errores definitivos no se reintentan nunca", () => {
  for (const [error, k] of [
    ["Not logged in · Please run /login", "credentials"],
    ["401 Unauthorized", "credentials"],
    ["HTTP 403 Forbidden", "credentials"],
    ["OAuth token has expired", "credentials"],
    ["EACCES: permission denied, open '/x'", "permissions"],
    ["Operation not permitted", "permissions"],
    ["sh: pnpm: command not found", "missingTool"],
    ["ENOSPC: no space left on device", "diskFull"],
    ["error_max_budget_usd: Reached maximum budget", "budget"],
    ["error_max_turns: max turns", "budget"],
    ["Tests failed: 3 failing", "tests"],
    ["Test Suites: 2 failed, 10 passed", "tests"],
    ["src/a.ts(3,1): error TS2322: Type 'x' is not assignable", "build"],
    ["Failed to compile.", "build"],
  ] as const) {
    assert.deepEqual(kind(error), { kind: k, retry: false }, error);
  }
});

test("classifyFailure: lo definitivo gana a lo temporal en el mismo texto", () => {
  assert.equal(kind("ETIMEDOUT after 401 Unauthorized").kind, "credentials");
  assert.equal(kind("tests failed (ECONNRESET in one test)").kind, "tests");
  assert.equal(kind("ENOSPC while fetching: 503").kind, "diskFull");
});

test("classifyFailure: Claude no puede, cancelación y desconocidos", () => {
  assert.deepEqual(kind("Claude terminó sin abrir un PR (ver resumen)", { errorCode: "noPr" }), { kind: "cannotDo", retry: false });
  assert.deepEqual(kind("", { errorCode: "noPlan" }), { kind: "cannotDo", retry: false });
  assert.deepEqual(kind("socket hang up", { cancelled: true }), { kind: "cancelled", retry: false });
  assert.deepEqual(kind("algo raro"), { kind: "unknown", retry: false });
  assert.deepEqual(kind(""), { kind: "unknown", retry: false });
});

test("classifyFailure: el límite del plan de Claude Code no se trata aquí", () => {
  for (const error of ["Claude AI usage limit reached|1700000000", "You've hit your limit · resets at 5pm", "429 rate_limit_error"]) {
    assert.deepEqual(kind(error), { kind: "planLimit", retry: false }, error);
  }
});

test("clampRetryMax: 2 por defecto, entre 1 y 3", () => {
  assert.equal(clampRetryMax(undefined), 2);
  assert.equal(clampRetryMax(0), 1);
  assert.equal(clampRetryMax(3), 3);
  assert.equal(clampRetryMax(10), 3);
  assert.equal(clampRetryMax(1.5), 2);
});

const S = { on: true, max: 2, maxCostUsd: 10 };
const NOW = 1_000_000;

test("decideRetry: apagado o límite del plan → nada", () => {
  assert.equal(decideRetry(undefined, { error: "ECONNRESET" }, { ...S, on: false }, NOW), null);
  assert.equal(decideRetry(undefined, { error: "usage limit reached" }, S, NOW), null);
});

test("decideRetry: reintenta con espera creciente hasta el máximo y luego se rinde", () => {
  const first = decideRetry(undefined, { error: "socket hang up", costUsd: 1 }, S, NOW)!;
  assert.equal(first.state, "scheduled");
  assert.equal(first.count, 1);
  assert.equal(first.nextAt, NOW + RETRY_DELAYS_MS[0]);
  assert.equal(RETRY_DELAYS_MS[0], 2 * 60_000);
  assert.equal(first.kind, "network");

  const second = decideRetry({ ...first, state: "retrying" }, { error: "503 Service Unavailable", costUsd: 1 }, S, NOW)!;
  assert.equal(second.state, "scheduled");
  assert.equal(second.count, 2);
  assert.equal(second.nextAt, NOW + 10 * 60_000);

  const third = decideRetry({ ...second, state: "retrying" }, { error: "ECONNRESET", costUsd: 1 }, S, NOW)!;
  assert.equal(third.state, "gaveUp");
  assert.equal(third.count, 2);
  assert.equal(third.nextAt, undefined);
  assert.equal(third.costCap, undefined);
  assert.deepEqual(third.history.map((h) => h.kind), ["network", "overloaded", "network"]);
  assert.equal(third.totalCostUsd, 3);

  // Aunque vuelva a parecer temporal, no se reintenta más.
  assert.equal(decideRetry(third, { error: "ECONNRESET" }, S, NOW)!.state, "gaveUp");
});

test("decideRetry: el tope de coste para los reintentos", () => {
  const capped = decideRetry(undefined, { error: "ECONNRESET", costUsd: 4 }, { ...S, maxCostUsd: 4 }, NOW)!;
  assert.equal(capped.state, "gaveUp");
  assert.equal(capped.costCap, true);
  assert.equal(capped.count, 0);
  const prev: AutoRetryState = { state: "retrying", count: 1, max: 2, kind: "network", history: [{ kind: "network", costUsd: 3 }], totalCostUsd: 3 };
  const next = decideRetry(prev, { error: "ECONNRESET", costUsd: 2 }, { ...S, maxCostUsd: 5 }, NOW)!;
  assert.equal(next.state, "gaveUp");
  assert.equal(next.costCap, true);
  assert.equal(next.totalCostUsd, 5);
});

test("decideRetry: error no temporal → skipped con el motivo", () => {
  const s = decideRetry(undefined, { error: "Not logged in", costUsd: 0.5 }, S, NOW)!;
  assert.equal(s.state, "skipped");
  assert.equal(s.kind, "credentials");
  assert.equal(s.count, 0);
  assert.equal(decideRetry(undefined, { error: "x", cancelled: true }, S, NOW)!.kind, "cancelled");
});

test("decideRetry: el máximo nunca pasa de 3 y el historial queda acotado", () => {
  let st: AutoRetryState | undefined;
  for (let i = 0; i < 6; i++) st = decideRetry(st && { ...st, state: "retrying" }, { error: "ECONNRESET", costUsd: 0.1 }, { ...S, max: 9 }, NOW)!;
  assert.equal(st!.state, "gaveUp");
  assert.equal(st!.count, 3);
  assert.equal(st!.max, 3);
  assert.ok(st!.history.length <= 4);
});

test("retryDue", () => {
  assert.equal(retryDue({ state: "scheduled", nextAt: NOW }, NOW), true);
  assert.equal(retryDue({ state: "scheduled", nextAt: NOW + 1 }, NOW), false);
  assert.equal(retryDue({ state: "retrying" }, NOW), false);
  assert.equal(retryDue(undefined, NOW), false);
});
