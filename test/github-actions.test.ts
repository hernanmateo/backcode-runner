import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// La pausa se guarda en HOME_DIR: una carpeta temporal para los tests.
process.env.BACKCODE_HOME = mkdtempSync(join(tmpdir(), "ga-"));
const { githubActions, isScopeError, nextReset, parseLegacyBilling, parseUsageBilling, readPause } = await import("../src/github-actions.js");

test("nextReset: el día 1 del mes siguiente (también en diciembre)", () => {
  assert.equal(nextReset(new Date("2026-11-04T10:00:00Z")).toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(nextReset(new Date("2026-12-31T23:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("facturación antigua y nueva de Actions", () => {
  assert.deepEqual(parseLegacyBilling({ total_minutes_used: 2000.4, included_minutes: 2000, total_paid_minutes_used: 0 }), { minutesUsed: 2000, minutesIncluded: 2000 });
  assert.equal(parseLegacyBilling({ message: "x" }), null);
  const usage = {
    usageItems: [
      { product: "actions", sku: "Actions Linux", unitType: "Minutes", quantity: 1500, netAmount: 0 },
      { product: "actions", sku: "Actions macOS 3-core", unitType: "minutes", quantity: 50, netAmount: 0 },
      { product: "actions", sku: "Actions storage", unitType: "GigabyteHours", quantity: 9 },
      { product: "packages", sku: "x", unitType: "minutes", quantity: 99 },
    ],
  };
  assert.deepEqual(parseUsageBilling(usage, "free"), { minutesUsed: 2000, minutesIncluded: 2000 });
  assert.equal(parseUsageBilling(usage, "pro")?.minutesIncluded, 3000);
  assert.equal(parseUsageBilling({}, "free"), null);
});

test("isScopeError: el aviso de gh de que falta el permiso", () => {
  assert.equal(isScopeError({ stderr: 'gh: This API operation needs the "user" scope. To request it, run:  gh auth refresh -h github.com -s user' }), true);
  assert.equal(isScopeError(new Error("ECONNRESET")), false);
});

/** gh falso: un repo con dos workflows y un registro de lo que se llama. */
function fakeGh(opts: { lastRun?: "failure" | "success"; notStarted?: boolean; billing?: object | "scope"; login?: string } = {}) {
  const calls: string[] = [];
  const state: Record<number, string> = { 1: "active", 2: "active" };
  const gh = async (args: string[]): Promise<string> => {
    const a = args.join(" ");
    calls.push(a);
    if (a.startsWith("repo view")) return JSON.stringify({ nameWithOwner: "me/app", owner: { login: "me" }, isInOrganization: false });
    if (a.includes("/actions/workflows/") && a.includes("-X PUT")) {
      const id = Number(/workflows\/(\d+)\//.exec(a)?.[1]);
      state[id] = a.endsWith("/disable") ? "disabled_manually" : "active";
      return "";
    }
    if (a.includes("/actions/workflows")) return JSON.stringify({ workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: state[1] }, { id: 2, name: "Deploy", path: ".github/workflows/deploy.yml", state: state[2] }, { id: 3, name: "Dependabot", path: "dynamic/dependabot", state: "active" }] });
    if (a.includes("settings/billing/actions")) {
      if (opts.billing === "scope" || !opts.billing) throw Object.assign(new Error("x"), { stderr: 'needs the "user" scope' });
      return JSON.stringify(opts.billing);
    }
    if (a.includes("settings/billing/usage")) throw Object.assign(new Error("x"), { stderr: 'needs the "user" scope' });
    if (a === "api user -q .login") return opts.login ?? "me";
    if (a.startsWith("api user")) throw new Error("scope");
    if (a.includes("actions/runs?")) return JSON.stringify({ workflow_runs: opts.lastRun ? [{ id: 9, conclusion: opts.lastRun }] : [] });
    if (a.includes("/runs/9/jobs")) return JSON.stringify({ jobs: [{ id: 77, conclusion: "failure", steps: [] }] });
    if (a.includes("check-runs/77/annotations")) return JSON.stringify(opts.notStarted ? [{ message: "The job was not started because recent account payments have failed or your spending limit needs to be increased." }] : [{ message: "Process completed with exit code 1." }]);
    throw new Error(`inesperado: ${a}`);
  };
  return { gh, calls, state };
}

test("status: minutos agotados porque los jobs no arrancan, sin permiso de facturación", async () => {
  const { gh } = fakeGh({ lastRun: "failure", notStarted: true });
  const s = await githubActions("/r", "p-status", gh).status();
  assert.equal(s.billingError, "scope");
  assert.equal(s.billingScope, "user");
  assert.equal(s.owner, "me");
  assert.equal(s.outOfMinutes?.source, "jobs");
  assert.deepEqual(s.workflows, { active: 2, disabled: 0 });
  assert.equal(s.paused, undefined);
});

test("status: un fallo normal no es «sin minutos»; la facturación agotada sí", async () => {
  assert.equal((await githubActions("/r", "p-fail", fakeGh({ lastRun: "failure", notStarted: false }).gh).status()).outOfMinutes, undefined);
  const s = await githubActions("/r", "p-bill", fakeGh({ lastRun: "success", billing: { total_minutes_used: 2000, included_minutes: 2000 } }).gh).status();
  assert.deepEqual(s.billing, { minutesUsed: 2000, minutesIncluded: 2000 });
  assert.equal(s.outOfMinutes?.source, "billing");
});

test("pause y resume: solo los workflows del repo que estaban activos, y se reactivan solo esos", async () => {
  const { gh, state } = fakeGh();
  state[2] = "disabled_manually"; // ya estaba desactivado a mano: no es de Backcode
  const ga = githubActions("/r", "p-pause", gh);
  const p = await ga.pause(true);
  assert.deepEqual(p.workflows, [{ id: 1, name: "CI" }]);
  assert.equal(state[1], "disabled_manually");
  assert.equal(ga.isPaused(), true);
  assert.equal(readPause("p-pause")?.autoResume, true);
  assert.equal((await ga.status()).paused?.workflows.length, 1);
  assert.equal(await ga.autoResumeIfDue(new Date(Date.now() + 1000)), false);
  assert.equal(await ga.autoResumeIfDue(new Date(p.until)), true);
  assert.equal(state[1], "active");
  assert.equal(state[2], "disabled_manually");
  assert.equal(ga.isPaused(), false);
});

test("pausa sin reactivación automática: hasta que se reactive a mano", async () => {
  const { gh, state } = fakeGh();
  const ga = githubActions("/r", "p-manual", gh);
  const p = await ga.pause(false);
  assert.equal(await ga.autoResumeIfDue(new Date(new Date(p.until).getTime() + 86_400_000)), false);
  assert.deepEqual(await ga.resume(), ["CI", "Deploy"]);
  assert.equal(state[1], "active");
});

test("status: en el runner de un compañero no se lee la facturación ni se pide permiso (notOwner)", async () => {
  const { gh, calls } = fakeGh({ lastRun: "success", login: "compi" });
  const s = await githubActions("/r", "p-mate", gh).status();
  assert.equal(s.billingError, "notOwner");
  assert.equal(calls.some((c) => c.includes("settings/billing")), false);
});
