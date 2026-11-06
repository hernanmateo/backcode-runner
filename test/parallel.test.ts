import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatClash, clampLimit, effectiveProjectLimit, nextTask, pathsOverlap } from "../src/scheduler.ts";
import { countSlots, takeSlot } from "../src/slots.ts";
import { brakeReason, descendantsRss, metricsDoc, parseDarwinPressure, parseFreePct, parseMeminfo, recommend } from "../src/monitor.ts";

const GB = 1024 ** 3;

test("por defecto, una tarea por proyecto y sin tope en el ordenador (como antes)", () => {
  assert.equal(effectiveProjectLimit(null, null), 1);
  assert.equal(effectiveProjectLimit(3, null), 3);
  assert.equal(effectiveProjectLimit(3, 2), 2, "nunca más que el total del ordenador");
  assert.equal(clampLimit("3", 8, null), null);
  assert.equal(clampLimit(0, 8, null), null);
  assert.equal(clampLimit(20, 8, null), 8);
  assert.equal(clampLimit(2.5, 8, 1), 1);
});

test("nextTask respeta el límite del proyecto y no junta dos tareas de la misma conversación", () => {
  const pending = [{ id: "a", chatId: "c1" }, { id: "b", chatId: "c1" }, { id: "c" }];
  assert.deepEqual(nextTask(pending, [], 1), { task: { id: "a", chatId: "c1" } });
  assert.deepEqual(nextTask(pending, [{ id: "x" }], 1), { task: null, reason: "project" });
  assert.deepEqual(nextTask(pending, [{ id: "a", chatId: "c1" }], 3), { task: { id: "c" } });
  assert.deepEqual(nextTask([{ id: "b", chatId: "c1" }], [{ id: "a", chatId: "c1" }], 3), { task: null, reason: "chat" });
  assert.deepEqual(nextTask([], [], 3), { task: null, reason: null });
});

test("tareas de la misma conversación en paralelo si declaran rutas que no se solapan", () => {
  const app = { id: "a", chatId: "c1", touches: ["app/src/components"] };
  const fns = { id: "b", chatId: "c1", touches: ["./functions/src/"] };
  assert.deepEqual(nextTask([fns], [app], 3), { task: fns });
  // Se solapan (una dentro de otra), o una no dice qué toca: espera.
  assert.deepEqual(nextTask([{ id: "b", chatId: "c1", touches: ["app/src/components/kanban.tsx"] }], [app], 3), { task: null, reason: "chat" });
  assert.deepEqual(nextTask([{ id: "b", chatId: "c1" }], [app], 3), { task: null, reason: "chat" });
  assert.deepEqual(nextTask([fns], [{ id: "a", chatId: "c1" }], 3), { task: null, reason: "chat" });
  // after: espera a la otra aunque no se solapen, en marcha o aún en cola delante.
  assert.deepEqual(nextTask([{ ...fns, after: ["a"] }], [app], 3), { task: null, reason: "chat" });
  const later = { id: "c", chatId: "c1", touches: ["docs"], after: ["b"] };
  assert.deepEqual(nextTask([fns, later], [], 3), { task: fns });
  assert.deepEqual(nextTask([later, fns], [], 3), { task: fns });
  // De otra conversación nunca choca por esto.
  assert.equal(chatClash({ id: "x", chatId: "c2" }, app), false);
});

test("solapamiento de rutas: carpetas, «./», comodines y raíz", () => {
  assert.ok(pathsOverlap("app/src", "app/src/lib/x.ts"));
  assert.ok(pathsOverlap("./app/", "app"));
  assert.ok(!pathsOverlap("app/src", "app/srcs"));
  assert.ok(pathsOverlap("app/src/*.tsx", "app/src/a.tsx"));
  assert.ok(pathsOverlap("app/src/foo*.ts", "app/src/bar.ts"), "comodín: toda su carpeta, por prudencia");
  assert.ok(pathsOverlap("**/*.ts", "functions"), "comodín en la raíz: todo");
  assert.ok(pathsOverlap(".", "functions"));
});

test("huecos del ordenador compartidos entre proyectos, con limpieza de procesos muertos", () => {
  const dir = mkdtempSync(join(tmpdir(), "slots-"));
  const r1 = takeSlot(dir, "p1", "f1", 2);
  const r2 = takeSlot(dir, "p2", "f2", 2);
  assert.ok(r1 && r2);
  assert.equal(takeSlot(dir, "p1", "f3", 2), null, "lleno con 2");
  assert.ok(takeSlot(dir, "p1", "f4", null), "sin tope siempre entra");
  r1!();
  assert.equal(countSlots(dir), 2);
  // Un hueco de un proceso que ya no existe no cuenta y se borra.
  writeFileSync(join(dir, "p9__dead.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.equal(countSlots(dir), 2);
  assert.ok(!readdirSync(dir).includes("p9__dead.json"));
});

test("presión de memoria y disco libre", () => {
  assert.equal(parseDarwinPressure("1\n"), "normal");
  assert.equal(parseDarwinPressure("2"), "warn");
  assert.equal(parseDarwinPressure("4"), "critical");
  assert.equal(parseFreePct("System-wide memory free percentage: 45%"), 45);
  assert.equal(parseFreePct("?"), null);
  assert.deepEqual(parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 80 kB\n"), { freePct: 8, pressure: "warn" });
  assert.equal(brakeReason({ pressure: "warn", diskFree: 100 * GB }), "memory");
  assert.equal(brakeReason({ pressure: "normal", diskFree: 2 * GB }), "disk");
  assert.equal(brakeReason({ pressure: "normal", diskFree: 100 * GB }), null);
});

test("RAM de las sesiones: solo descendientes de los runners", () => {
  const ps = ["100 1 50000", "200 100 1000", "300 200 2000", "400 1 9999", "500 400 7777"].join("\n");
  assert.equal(descendantsRss(ps, [100]), 3000 * 1024);
});

test("recomendación según núcleos, RAM y disco", () => {
  assert.deepEqual(recommend({ cores: 10, ramTotal: 16 * GB, sessionRam: 2 * GB, diskFree: 200 * GB }), { recommended: 5, limitedBy: "cpu" });
  assert.deepEqual(recommend({ cores: 16, ramTotal: 8 * GB, sessionRam: 2 * GB, diskFree: 200 * GB }), { recommended: 2, limitedBy: "ram" });
  assert.deepEqual(recommend({ cores: 16, ramTotal: 64 * GB, sessionRam: 1 * GB, diskFree: 12 * GB }), { recommended: 2, limitedBy: "disk" });
  assert.equal(recommend({ cores: 1, ramTotal: 4 * GB, sessionRam: null, diskFree: 1 * GB }).recommended, 1, "como mínimo 1");
  const d = metricsDoc({ cpuLoad: 2.345, cores: 8, ramTotal: 16 * GB, pressure: "normal", memFreePct: 40, sessionRam: null, diskFree: 50 * GB, worktreesSize: null, running: 1, recommended: 3, limitedBy: "ram" });
  assert.deepEqual(Object.keys(d).sort(), ["cores", "cpuLoad", "diskFree", "limitedBy", "memFreePct", "pressure", "ramTotal", "recommended", "running", "sessionRam", "worktreesSize"]);
});
