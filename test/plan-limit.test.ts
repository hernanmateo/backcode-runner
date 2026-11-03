import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, planLimitFromEvent, planLimitFromText, quotaBlockedUntil, resetFromText, waitUntil } from "../src/plan-limit.ts";
import { nextTask } from "../src/scheduler.ts";

const NOW = Date.parse("2026-11-03T10:00:00Z");

test("reconoce el límite del plan de Claude Code y no otros errores", () => {
  assert.deepEqual(planLimitFromText("Claude AI usage limit reached|1793790000", NOW), { reason: "Claude AI usage limit reached", resetsAt: 1793790000 * 1000 });
  assert.ok(planLimitFromText("You've hit your limit · resets 3pm (Europe/Madrid)", NOW)?.resetsAt);
  assert.ok(planLimitFromText("API Error: 429 rate_limit_error", NOW));
  assert.ok(planLimitFromText("5-hour limit reached ∙ resets 1am", NOW));
  assert.equal(planLimitFromText("error_during_execution: TypeError: x is not a function", NOW), null);
  assert.equal(planLimitFromText("tests failed: 3 failing", NOW), null);
  assert.equal(planLimitFromText("", NOW), null);
});

test("rate_limit_event: solo cuenta el rechazado, con resetsAt en segundos", () => {
  assert.equal(planLimitFromEvent({ status: "allowed_warning", resetsAt: 1 }), null);
  assert.deepEqual(planLimitFromEvent({ status: "rejected", resetsAt: 1793790000, rateLimitType: "five_hour" }), { reason: "rate_limit: five_hour", resetsAt: 1793790000 * 1000 });
  assert.deepEqual(planLimitFromEvent({ status: "rejected" }), { reason: "rate_limit: plan" });
});

test("hora de reinicio del mensaje: la próxima vez que llegue esa hora", () => {
  const at = resetFromText("resets 3pm", NOW)!;
  assert.ok(at > NOW && at - NOW <= 24 * 3600_000);
  assert.equal(new Date(at).getHours(), 15);
  assert.equal(resetFromText("nothing here", NOW), undefined);
});

test("cuota agotada: hasta el reinicio más tardío de las ventanas al 100 %", () => {
  const later = new Date(NOW + 2 * 3600_000).toISOString();
  const week = new Date(NOW + 48 * 3600_000).toISOString();
  assert.equal(quotaBlockedUntil({ plan: "max", fiveHour: { pct: 100, resetsAt: later }, sevenDay: { pct: 40, resetsAt: week } }, NOW), Date.parse(later));
  assert.equal(quotaBlockedUntil({ plan: "max", fiveHour: { pct: 100, resetsAt: later }, sevenDay: { pct: 100, resetsAt: week } }, NOW), Date.parse(week));
  assert.equal(quotaBlockedUntil({ plan: "max", fiveHour: { pct: 80, resetsAt: later }, sevenDay: null }, NOW), null);
  assert.equal(quotaBlockedUntil(null, NOW), null);
});

test("hasta cuándo esperar: reinicio conocido, cuota leída o backoff prudente", () => {
  assert.equal(waitUntil({ reason: "x", resetsAt: NOW + 3600_000 }, null, 0, NOW), NOW + 3600_000 + 60_000);
  const later = new Date(NOW + 2 * 3600_000).toISOString();
  assert.equal(waitUntil({ reason: "x" }, { plan: null, fiveHour: { pct: 100, resetsAt: later }, sevenDay: null }, 0, NOW), Date.parse(later) + 60_000);
  assert.equal(waitUntil({ reason: "x" }, null, 0, NOW), NOW + 15 * 60_000);
  assert.equal(waitUntil({ reason: "x" }, null, 1, NOW), NOW + 30 * 60_000);
  assert.equal(backoffMs(20), 3 * 3600_000);
});

test("con el límite del plan, la cola solo arranca las que se pidió reanudar ya", () => {
  const pending = [{ id: "a" }, { id: "b", resumeNow: true }];
  assert.deepEqual(nextTask(pending, [], 2, true), { task: { id: "b", resumeNow: true } });
  assert.deepEqual(nextTask([{ id: "a" }], [], 2, true), { task: null, reason: "quota" });
  assert.deepEqual(nextTask([{ id: "a" }], [], 2, false), { task: { id: "a" } });
});
