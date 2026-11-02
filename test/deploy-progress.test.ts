import assert from "node:assert/strict";
import { test } from "node:test";
import { deployAll, type ActionResult } from "../src/actions.js";
import type { RunnerConfig } from "../src/config.js";
import { DeployProgress, type DeployLock, isTransientDeployError, retryTransient, withDeployLock } from "../src/deploy-progress.js";
import type { Store } from "../src/store.js";

const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);

test("errores transitorios de Firebase: sí; de compilación o del código: no", () => {
  assert.ok(isTransientDeployError("Error: Failed to list functions for backcode-app"));
  assert.ok(isTransientDeployError("HTTP Error: 503, The service is currently unavailable."));
  assert.ok(isTransientDeployError("HTTP Error: 429, Quota exceeded for quota metric 'Write requests'"));
  assert.ok(isTransientDeployError("Error: An unexpected error has occurred."));
  assert.ok(!isTransientDeployError("src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."));
  assert.ok(!isTransientDeployError("Error: Cannot find module 'firebase-functions'"));
  assert.ok(!isTransientDeployError("SyntaxError: Unexpected token '}'"));
  assert.ok(!isTransientDeployError("Error: functions predeploy error: Command terminated with non-zero exit code 2"));
  assert.ok(!isTransientDeployError(""));
});

test("reintenta como mucho 2 veces, con espera creciente, y avisa en cada reintento", async () => {
  sleeps.length = 0;
  let calls = 0;
  const retries: number[] = [];
  const done = await retryTransient(async () => (calls++, { ok: false, result: { error: "Error: Failed to list functions for p" } }), {
    transient: isTransientDeployError,
    sleep,
    onRetry: (n) => void retries.push(n),
  });
  assert.equal(calls, 3);
  assert.equal(done.attempts, 3);
  assert.equal(done.ok, false);
  assert.deepEqual(sleeps, [20_000, 60_000]);
  assert.deepEqual(retries, [1, 2]);
});

test("un reintento que sale bien para; un error real no se reintenta", async () => {
  sleeps.length = 0;
  let calls = 0;
  const ok = await retryTransient(async () => (++calls === 1 ? { ok: false, result: { error: "HTTP Error: 503, Service Unavailable" } } : { ok: true, result: {} }), { transient: isTransientDeployError, sleep });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 2);
  calls = 0;
  const real = await retryTransient(async () => (calls++, { ok: false, result: { error: "error TS2304: Cannot find name 'x'" } }), { transient: isTransientDeployError, sleep });
  assert.equal(calls, 1);
  assert.equal(real.attempts, 1);
});

/** Candado en memoria compartido por dos «runners». */
function memoryLock() {
  let holder: { action: string; step: string } | null = null;
  const lock = (who: string): DeployLock => ({
    take: async (action, step) => {
      if (holder && holder.action !== action) return { ok: false, step: holder.step };
      holder = { action, step };
      void who;
      return { ok: true };
    },
    release: async (action) => {
      if (holder?.action === action) holder = null;
    },
  });
  return { lock, held: () => holder };
}

test("con el candado ocupado espera (avisando de qué se despliega) y lo suelta al acabar", async () => {
  const m = memoryLock();
  await m.lock("a").take("other", "functions");
  const waits: string[] = [];
  let polls = 0;
  const out = await withDeployLock(m.lock("b"), "mine", "rules", async () => "hecho", {
    sleep: async () => {
      if (++polls === 2) await m.lock("a").release("other");
    },
    onWait: (busy) => void waits.push(busy),
  });
  assert.equal(out, "hecho");
  assert.deepEqual(waits, ["functions"], "avisa una vez por lo que está ocupando el candado");
  assert.equal(m.held(), null, "suelta el candado");
});

test("dos despliegues a la vez: nunca se solapan", async () => {
  const m = memoryLock();
  let running = 0;
  let max = 0;
  const job = (who: string) =>
    withDeployLock(m.lock(who), who, who, async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    }, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))) });
  await Promise.all([job("a"), job("b"), job("c")]);
  assert.equal(max, 1);
});

test("DeployProgress escribe el paso actual y cada paso hecho, en orden", async () => {
  const writes: unknown[] = [];
  let time = 1000;
  const p = new DeployProgress<{ id: string; ok: boolean }>(["deploy:.#rules", "ota:preview"], async (r) => void writes.push(r), () => time);
  await p.start("deploy:.#rules", "functions");
  time = 5000;
  await p.running("deploy:.#rules");
  await p.finish({ id: "deploy:.#rules", ok: true });
  await p.start("ota:preview");
  assert.deepEqual(writes, [
    { order: ["deploy:.#rules", "ota:preview"], steps: [], current: { id: "deploy:.#rules", index: 0, startedAt: 1000, waitingFor: "functions" } },
    { order: ["deploy:.#rules", "ota:preview"], steps: [], current: { id: "deploy:.#rules", index: 0, startedAt: 5000 } },
    { order: ["deploy:.#rules", "ota:preview"], steps: [{ id: "deploy:.#rules", ok: true }] },
    { order: ["deploy:.#rules", "ota:preview"], steps: [{ id: "deploy:.#rules", ok: true }], current: { id: "ota:preview", index: 1, startedAt: 5000 } },
  ]);
});

test("deployAll escribe el progreso en la acción a medida que avanza y para al primer fallo", async () => {
  const written: { steps: { id: string; ok: boolean }[]; current?: { id: string } }[] = [];
  const store = {
    plan: { steps: [{ id: "deploy:.#rules" }, { id: "deploy:functions#functions" }, { id: "ota:preview" }] },
    actionProgress: async (_id: string, r: Record<string, unknown>) => void written.push(JSON.parse(JSON.stringify(r))),
  } as unknown as Store;
  const lock: DeployLock = { take: async () => ({ ok: true }), release: async () => undefined };
  const ran: string[] = [];
  const step = async (id: string): Promise<{ ok: boolean; result: ActionResult }> => {
    ran.push(id);
    // Al empezar cada paso, la app ya lo ve en curso.
    assert.equal(written.at(-1)?.current?.id, id);
    return id.includes("functions") ? { ok: false, result: { error: "boom" } } : { ok: true, result: { sha: "abc" } };
  };
  const done = await deployAll({} as RunnerConfig, store, undefined, ["ota:preview", "deploy:functions#functions", "deploy:.#rules"], "msg", false, "act1", { step, lock, sleep });
  assert.deepEqual(ran, ["deploy:.#rules", "deploy:functions#functions"], "en el orden del plan, y para al fallar");
  assert.equal(done.ok, false);
  assert.deepEqual(done.result.order, ["deploy:.#rules", "deploy:functions#functions", "ota:preview"]);
  assert.deepEqual(done.result.steps?.map((s) => [s.id, s.ok]), [["deploy:.#rules", true], ["deploy:functions#functions", false]]);
  assert.ok(done.result.steps?.every((s) => typeof s.startedAt === "number" && typeof s.durationMs === "number"));
  const last = written.at(-1)!;
  assert.equal(last.current, undefined, "el último progreso ya no tiene paso en curso");
  assert.deepEqual(last.steps.map((s) => s.ok), [true, false]);
  assert.ok(written.some((w) => w.steps.length === 1 && w.current?.id === "deploy:functions#functions"), "se vio el paso 2 en curso con el 1 hecho");
});
