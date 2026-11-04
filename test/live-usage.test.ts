import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanModelId, LiveUsage, throttled, usageFromResult, type SdkModelUsage } from "../src/live-usage.ts";
import { estimateCost } from "../src/prices.ts";

const mu = (input: number, output: number, cacheRead: number, cacheCreate: number, cost: number): SdkModelUsage => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreate, costUSD: cost });
const zero = { costUsd: 0, turns: 0, input: 0, output: 0, cache: 0 };

test("usageFromResult suma modelos y fases anteriores", () => {
  const u = usageFromResult({ "claude-opus-5-5": mu(100, 50, 1000, 200, 0.5), "claude-haiku-5-5": mu(10, 5, 0, 0, 0.01) }, 0.51, 3, { costUsd: 1, turns: 2, input: 1, output: 2, cache: 3 });
  assert.equal(u.costUsd, 1.51);
  assert.equal(u.turns, 5);
  assert.deepEqual(u.tokens, { input: 111, output: 57, cache: 1203 });
  assert.deepEqual(u.models["claude-opus-5-5"], { costUsd: 0.5, tokens: 1350, cache: 1200 });
});

test("LiveUsage: tokens entre turnos y total exacto al llegar el result", () => {
  const live = new LiveUsage();
  // El SDK repite el mismo mensaje de la API en cada bloque: no se cuenta dos veces.
  live.assistant("msg_1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 });
  live.assistant("msg_1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 });
  live.assistant("msg_2", "claude-opus-5-5", { input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 3 });
  // Coste estimado con la tabla (Opus: 5 input, 25 output, 0,5 lectura y 6,25 escritura de caché por MTok).
  const est = (10 * 5 + 5 * 25 + 100 * 0.5 + 20 * 5 + 7 * 25 + 3 * 6.25) / 1e6;
  const cost = Math.round(est * 1e6) / 1e6;
  assert.deepEqual(live.snapshot(), { inputTokens: 30, outputTokens: 12, cacheTokens: 103, costUsd: cost, costEstimated: true, models: { "claude-opus-5-5": { tokens: 145, costUsd: cost, estimated: true } } });

  const final = usageFromResult({ "claude-opus-5-5": mu(30, 12, 100, 3, 0.25) }, 0.25, 2, zero);
  live.result(final);
  const s = live.snapshot();
  // El exacto sustituye la estimación.
  assert.equal(s.costEstimated, undefined);
  assert.equal(s.costUnknown, undefined);
  // Cuadra con lo que se escribe en result.
  assert.equal(s.costUsd, final.costUsd);
  assert.equal(s.inputTokens + s.outputTokens + s.cacheTokens, final.tokens.input + final.tokens.output + final.tokens.cache);
  assert.deepEqual(s.models, { "claude-opus-5-5": { tokens: 145, costUsd: 0.25 } });
});

test("LiveUsage: la fase siguiente parte de lo gastado", () => {
  const live = new LiveUsage();
  const first = usageFromResult({ "claude-opus-5-5": mu(10, 10, 0, 0, 0.1) }, 0.1, 1, zero);
  live.result(first);
  const spent = { costUsd: first.costUsd, turns: first.turns, input: first.tokens.input, output: first.tokens.output, cache: first.tokens.cache };
  live.endPhase(spent);
  assert.equal(live.snapshot().costUsd, 0.1);
  live.assistant("m", "claude-sonnet-5-5", { input_tokens: 5, output_tokens: 1 });
  const s = live.snapshot();
  assert.equal(s.inputTokens, 15);
  assert.deepEqual(Object.keys(s.models ?? {}).sort(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
  live.result(usageFromResult({ "claude-sonnet-5-5": mu(5, 1, 0, 0, 0.02) }, 0.02, 1, spent));
  assert.equal(live.snapshot().costUsd, 0.12);
});

test("LiveUsage: un modelo sin precio no se inventa (coste desconocido) y no tapa lo exacto ni lo estimado", () => {
  const live = new LiveUsage();
  live.result(usageFromResult({ "claude-opus-5-5": mu(10, 10, 0, 0, 0.1) }, 0.1, 1, zero));
  live.assistant("a", "modelo-raro-1", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  let s = live.snapshot();
  assert.equal(s.costUsd, 0.1);
  assert.equal(s.costUnknown, true);
  assert.equal(s.costEstimated, undefined);
  assert.deepEqual(s.models?.["modelo-raro-1"], { tokens: 2_000_000, costUsd: 0, unknown: true });
  assert.deepEqual(s.models?.["claude-opus-5-5"], { tokens: 20, costUsd: 0.1 });

  // Exacto + pendiente conocido + pendiente desconocido.
  live.assistant("b", "claude-haiku-5-5", { input_tokens: 1_000_000 });
  s = live.snapshot();
  assert.equal(s.costUsd, 1.1);
  assert.equal(s.costEstimated, true);
  assert.equal(s.costUnknown, true);

  // Al llegar el result, todo es exacto.
  live.result(usageFromResult({ "claude-opus-5-5": mu(10, 10, 0, 0, 0.1), "modelo-raro-1": mu(1e6, 1e6, 0, 0, 3), "claude-haiku-5-5": mu(1e6, 0, 0, 0, 1) }, 4.1, 2, zero));
  s = live.snapshot();
  assert.equal(s.costUsd, 4.1);
  assert.equal(s.costUnknown, undefined);
  assert.equal(s.costEstimated, undefined);
  assert.deepEqual(s.models?.["modelo-raro-1"], { tokens: 2_000_000, costUsd: 3 });
});

test("estimateCost: precios por familia, versiones antiguas y contexto largo", () => {
  const t = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
  const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  close(estimateCost("claude-opus-5-5", t(1e6, 1e6)), 30);
  close(estimateCost("claude-opus-4-1-20250805", t(1e6, 1e6)), 90);
  close(estimateCost("claude-sonnet-5-5", t(0, 0, 1e6, 1e6)), 0.3 + 3.75);
  close(estimateCost("claude-haiku-5-5", t(1e6, 1e6)), 6);
  close(estimateCost("claude-3-5-haiku-20241022", t(1e6)), 0.8);
  // [1m]: igual hasta 200k; por encima, recargo en Sonnet.
  close(estimateCost("claude-sonnet-5-5[1m]", t(100_000, 1000)), (100_000 * 3 + 1000 * 15) / 1e6);
  close(estimateCost("claude-sonnet-5-5[1m]", t(300_000, 1000)), (300_000 * 6 + 1000 * 22.5) / 1e6);
  close(estimateCost("claude-opus-5-5[1m]", t(300_000)), 1.5);
  assert.equal(estimateCost("modelo-raro", t(1)), undefined);
  assert.equal(estimateCost(undefined, t(1)), undefined);
});

test("cleanModelId acepta ids de modelo y rechaza lo demás", () => {
  assert.equal(cleanModelId("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(cleanModelId("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  assert.equal(cleanModelId("bad model"), undefined);
  assert.equal(cleanModelId("x".repeat(200)), undefined);
  assert.equal(cleanModelId(42), undefined);
});

test("throttled: como mucho una escritura por intervalo, salvo forzada", async () => {
  let clock = 0;
  let writes = 0;
  const w = throttled(async () => void writes++, 1000, () => clock);
  w.touch();
  await w.stop();
  assert.equal(writes, 1);
  clock = 500;
  w.touch();
  w.touch();
  await w.stop(); // cancela la pendiente
  assert.equal(writes, 1);
  w.touch(true);
  await w.stop();
  assert.equal(writes, 2);
  clock = 2000;
  w.touch();
  await w.stop();
  assert.equal(writes, 3);
});
