import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanModelId, LiveUsage, throttled, usageFromResult, type SdkModelUsage } from "../src/live-usage.ts";

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
  assert.deepEqual(live.snapshot(), { inputTokens: 30, outputTokens: 12, cacheTokens: 103, costUsd: 0, models: { "claude-opus-5-5": { tokens: 145, costUsd: 0 } } });

  const final = usageFromResult({ "claude-opus-5-5": mu(30, 12, 100, 3, 0.25) }, 0.25, 2, zero);
  live.result(final);
  const s = live.snapshot();
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
