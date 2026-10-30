import assert from "node:assert/strict";
import { test } from "node:test";
import { includedTasks, MAX_DEPLOYED_TASKS } from "../src/deploy-tasks.js";

// Historia lineal a → b → c → d: un commit es antecesor de otro si va antes (o es el mismo).
const ORDER = ["a", "b", "c", "d"];
const isAncestor = async (ancestor: string, commit: string) => ORDER.includes(ancestor) && ORDER.indexOf(ancestor) <= ORDER.indexOf(commit);
const merged = [
  { id: "t1", title: "Uno", sha: "a" },
  { id: "t2", title: "Dos", sha: "b" },
  { id: "t3", title: "Tres", sha: "c" },
  { id: "t4", title: "Cuatro", sha: "d" },
];

test("sin despliegue anterior: todas las mergeadas que van en el commit", async () => {
  assert.deepEqual(await includedTasks(merged, "c", undefined, isAncestor), [
    { id: "t1", title: "Uno" },
    { id: "t2", title: "Dos" },
    { id: "t3", title: "Tres" },
  ]);
});

test("con despliegue anterior: solo las nuevas desde él", async () => {
  assert.deepEqual(await includedTasks(merged, "d", "b", isAncestor), [
    { id: "t3", title: "Tres" },
    { id: "t4", title: "Cuatro" },
  ]);
  assert.deepEqual(await includedTasks(merged, "b", "b", isAncestor), []);
});

test("sin commit de merge, commit desconocido o git que falla: no entra", async () => {
  const failing = async (ancestor: string) => {
    if (ancestor === "x") throw new Error("bad object");
    return true;
  };
  assert.deepEqual(await includedTasks([{ id: "t0", title: "Cero", sha: "" }, { id: "tx", title: "Equis", sha: "x" }, ...merged.slice(0, 1)], "d", undefined, failing), [{ id: "t1", title: "Uno" }]);
});

test("títulos recortados y como mucho MAX_DEPLOYED_TASKS", async () => {
  const many = Array.from({ length: MAX_DEPLOYED_TASKS + 5 }, (_, i) => ({ id: `t${i}`, title: "x".repeat(200), sha: "a" }));
  const out = await includedTasks(many, "d", undefined, isAncestor);
  assert.equal(out.length, MAX_DEPLOYED_TASKS);
  assert.equal(out[0].title.length, 120);
});
