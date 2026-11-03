import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkForQuota, QuotaWaits, quotaWaitsOf, resumeDue, type QuotaWaitStore } from "../src/quota-waits.ts";
import { quotaAvailable } from "../src/plan-limit.ts";
import { nextTask } from "../src/scheduler.ts";

const NOW = Date.parse("2026-11-03T10:00:00Z");
const HOUR = 3600_000;
const file = () => join(mkdtempSync(join(tmpdir(), "quota-waits-")), "p-uid.json");
const denied = () => Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });

/** Firestore falso: `rules: "old"` rechaza la marca waitingQuota (y por tanto también la represa con marca). */
function fakeStore(opts: { rules?: "old" | "new"; requeue?: boolean; status?: Record<string, string> } = {}) {
  const status: Record<string, string> = opts.status ?? {};
  const marked = new Set<string>();
  const calls: string[] = [];
  const store: QuotaWaitStore = {
    async markWaiting(id) {
      calls.push(`mark:${id}`);
      if (opts.rules === "old") throw denied();
      status[id] = "waiting";
      marked.add(id);
    },
    async requeue(id) {
      calls.push(`requeue:${id}`);
      if (opts.requeue === false) throw denied();
      status[id] = "execute";
    },
    async plainWaiting(id) {
      calls.push(`plain:${id}`);
      status[id] = "waiting";
    },
    async resumeFromQuota(id) {
      calls.push(`resume:${id}`);
      if (opts.rules === "old") throw denied();
      if (status[id] !== "waiting" || !marked.has(id)) return false;
      status[id] = "execute";
      marked.delete(id);
      return true;
    },
    async postponeQuota(id) {
      calls.push(`postpone:${id}`);
      return status[id] === "waiting" && marked.has(id);
    },
  };
  return { store, status, marked, calls };
}

test("lo normal: en espera con la marca y, al volver la cuota, de vuelta a la cola", async () => {
  const waits = new QuotaWaits();
  const fs = fakeStore();
  assert.equal(await parkForQuota(waits, fs.store, "a", NOW + HOUR, 1), "marked");
  assert.equal(fs.status.a, "waiting");
  assert.equal(waits.blockedUntil(NOW), NOW + HOUR);
  // Antes de su hora no se toca.
  assert.deepEqual((await resumeDue(waits, fs.store, null, NOW)).resumed, []);
  const out = await resumeDue(waits, fs.store, null, NOW + HOUR);
  assert.deepEqual(out.resumed, ["a"]);
  assert.equal(fs.status.a, "execute");
  assert.equal(waits.blockedUntil(NOW + HOUR), 0);
  // Conserva los intentos por si se vuelve a parar.
  assert.equal(waits.get("a")?.tries, 1);
  assert.ok(waits.isResumed("a"));
});

test("marca rechazada (reglas antiguas): vuelve a la cola retenida hasta su hora y luego se suelta, sin perderse", async () => {
  const waits = new QuotaWaits();
  const fs = fakeStore({ rules: "old" });
  assert.equal(await parkForQuota(waits, fs.store, "a", NOW + HOUR, 1), "queued");
  assert.equal(fs.status.a, "execute");
  // En la cola, pero la cola está retenida por el límite: no arranca (motivo «quota»).
  assert.ok(waits.blockedUntil(NOW) > 0);
  assert.deepEqual(nextTask([{ id: "a" }], [], 1, waits.blockedUntil(NOW) > 0), { task: null, reason: "quota" });
  // Llega su hora y la cuota ha vuelto: deja de retenerla sin tocar Firestore (las reglas antiguas no lo dejarían).
  const out = await resumeDue(waits, fs.store, null, NOW + HOUR);
  assert.deepEqual(out.resumed, ["a"]);
  assert.ok(!fs.calls.includes("resume:a"));
  assert.equal(waits.blockedUntil(NOW + HOUR), 0);
  assert.deepEqual(nextTask([{ id: "a" }], [], 1, waits.blockedUntil(NOW + HOUR) > 0), { task: { id: "a" } });
});

test("ni marca ni cola: en espera sin marca y, al llegar su hora, se avisa en la tarea (nunca en silencio)", async () => {
  const waits = new QuotaWaits();
  const fs = fakeStore({ rules: "old", requeue: false });
  assert.equal(await parkForQuota(waits, fs.store, "a", NOW + HOUR, 1), "unmarked");
  assert.equal(fs.status.a, "waiting");
  const out = await resumeDue(waits, fs.store, null, NOW + HOUR);
  assert.deepEqual(out.manual, ["a"]);
  assert.equal(waits.has("a"), false);
});

test("la represa rechazada por permisos también se avisa, y un error de red se reintenta", async () => {
  const waits = new QuotaWaits();
  waits.set("a", { until: NOW, tries: 1, mode: "marked" });
  const out = await resumeDue(waits, fakeStore({ rules: "old" }).store, null, NOW);
  assert.deepEqual(out.manual, ["a"]);
  const flaky = new QuotaWaits();
  flaky.set("b", { until: NOW, tries: 1, mode: "marked" });
  const net: QuotaWaitStore = { ...fakeStore().store, resumeFromQuota: async () => Promise.reject(Object.assign(new Error("offline"), { code: "unavailable" })) };
  const again = await resumeDue(flaky, net, null, NOW);
  assert.deepEqual([again.resumed, again.manual, again.gone], [[], [], []]);
  assert.equal(flaky.due(NOW).length, 1);
});

test("reinicio del runner: las esperas (también las que no se pudieron marcar) vuelven del fichero local", async () => {
  const path = file();
  const before = new QuotaWaits(path);
  await parkForQuota(before, fakeStore({ rules: "old" }).store, "queued", NOW + HOUR, 2);
  await parkForQuota(before, fakeStore().store, "marked", NOW + 2 * HOUR, 1);
  const after = new QuotaWaits(path);
  after.load(NOW);
  assert.deepEqual(after.get("queued"), { until: NOW + HOUR, tries: 2, mode: "queued" });
  assert.equal(after.get("marked")?.mode, "marked");
  assert.equal(after.blockedUntil(NOW), NOW + 2 * HOUR);
  // Las de Firestore (marcadas) que no estaban en el fichero también se recuperan al llegar el snapshot.
  after.syncWaiting(new Set(["marked", "other"]), [{ id: "marked", until: NOW + 2 * HOUR, tries: 1 }, { id: "other", until: NOW + 3 * HOUR, tries: 4 }]);
  assert.deepEqual(after.get("other"), { until: NOW + 3 * HOUR, tries: 4, mode: "marked" });
  // Un fichero roto no rompe el arranque.
  const broken = new QuotaWaits(join(tmpdir(), "no-such-dir-quota", "x.json"));
  broken.load(NOW);
  assert.equal(broken.size, 0);
});

test("cuota aún agotada a la hora prevista: se aplaza al reinicio (las marcadas también en Firestore)", async () => {
  const waits = new QuotaWaits();
  const fs = fakeStore();
  await parkForQuota(waits, fs.store, "a", NOW, 1);
  await parkForQuota(waits, fakeStore({ rules: "old" }).store, "b", NOW, 1);
  const out = await resumeDue(waits, fs.store, NOW + HOUR, NOW);
  assert.deepEqual(out.postponed.sort(), ["a", "b"]);
  assert.ok(fs.calls.includes("postpone:a"));
  assert.equal(waits.blockedUntil(NOW), NOW + HOUR + 60_000);
});

test("vuelve la cuota (lectura real o una tarea que trabaja): la cola se suelta aunque falten horas", async () => {
  const waits = new QuotaWaits();
  waits.set("a", { until: NOW + 5 * HOUR, tries: 1, mode: "marked" });
  waits.set("b", { until: NOW + 2 * HOUR, tries: 1, mode: "queued" });
  assert.ok(waits.blockedUntil(NOW) > 0);
  const later = new Date(NOW + 2 * HOUR).toISOString();
  assert.equal(quotaAvailable({ plan: "max", fiveHour: { pct: 30, resetsAt: later }, sevenDay: { pct: 60, resetsAt: later } }, NOW), true);
  assert.equal(quotaAvailable({ plan: "max", fiveHour: { pct: 100, resetsAt: later }, sevenDay: { pct: 60, resetsAt: later } }, NOW), false);
  assert.equal(quotaAvailable({ plan: null, fiveHour: null, sevenDay: { pct: null, resetsAt: null } }, NOW), null);
  assert.equal(quotaAvailable(null, NOW), null);
  assert.equal(waits.release(NOW), true);
  assert.equal(waits.blockedUntil(NOW), 0);
  assert.equal(waits.due(NOW).length, 2);
  const out = await resumeDue(waits, fakeStore({ status: { a: "waiting" } }).store, null, NOW);
  // a no tenía marca en este Firestore falso: ya no espera (gone); b sale de la retención.
  assert.deepEqual(out.resumed, ["b"]);
  assert.equal(waits.release(NOW), false);
});

test("represa o cancelación a mano: la espera deja de retener la cola", () => {
  const waits = new QuotaWaits();
  waits.set("a", { until: NOW + HOUR, tries: 1, mode: "marked" });
  waits.set("b", { until: NOW + 2 * HOUR, tries: 1, mode: "marked" });
  waits.set("q", { until: NOW + 3 * HOUR, tries: 1, mode: "queued" });
  // «Reprèn ara» de a (sale de 'waiting' con la marca y la reclama el runner).
  assert.deepEqual(nextTask([{ id: "a", resumeNow: true }, { id: "x" }], [], 2, true), { task: { id: "a", resumeNow: true } });
  waits.markResumed("a");
  // Cancelan b (vuelve al backlog: ya no está en 'waiting') y liberan q (ya no está en la cola).
  assert.deepEqual(waits.syncWaiting(new Set(), []), ["b"]);
  assert.deepEqual(waits.syncQueued(new Set(["x"])), ["q"]);
  assert.equal(waits.blockedUntil(NOW), 0);
  // La reanudada conserva los intentos.
  assert.equal(waits.get("a")?.tries, 1);
});

test("runner compartido: las tareas de compañeros con mi runner se reanudan; las mías con el runner de otro, no", () => {
  const me = "me";
  const executes = (f: { assignee?: string; runnerUid?: string }) => (f.runnerUid ?? f.assignee) === me;
  const until = { toMillis: () => NOW + HOUR };
  const docs = [
    // De un compañero, aceptada con mi runner: llega por la consulta runnerUid.
    { id: "mate", data: { assignee: "mate", runnerUid: me, waitingQuota: { until, tries: 2 } } },
    // Mía, pero la ejecuta el runner de otro (con su cuota): llega por la consulta assignee y no es mía.
    { id: "mineOther", data: { assignee: me, runnerUid: "other", waitingQuota: { until, tries: 1 } } },
    // Mía y con mi runner, en espera por otra cosa (una pregunta): sin marca.
    { id: "question", data: { assignee: me } },
    // Repetida (las dos consultas): una sola vez.
    { id: "mate", data: { assignee: "mate", runnerUid: me, waitingQuota: { until, tries: 2 } } },
  ];
  const [waiting, marked] = quotaWaitsOf(docs, executes);
  assert.deepEqual([...waiting].sort(), ["mate", "question"]);
  assert.deepEqual(marked, [{ id: "mate", until: NOW + HOUR, tries: 2 }]);
  // Solo la del compañero retiene mi cola; la que espera la cuota de otro runner no.
  const waits = new QuotaWaits();
  waits.syncWaiting(waiting, marked);
  assert.equal(waits.blockedUntil(NOW), NOW + HOUR);
  assert.equal(waits.has("mineOther"), false);
  // Y la del compañero, reanudada, vuelve a la cola compartida y arranca (marca quitada: el runner la reanudó).
  waits.markResumed("mate");
  const queue = [{ id: "mate" }].map((p) => (waits.isResumed(p.id) ? { ...p, resumeNow: true } : p));
  assert.deepEqual(nextTask(queue, [], 1, waits.blockedUntil(NOW) > 0), { task: { id: "mate", resumeNow: true } });
});
