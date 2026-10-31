import assert from "node:assert/strict";
import { test } from "node:test";
import { channelOfTarget, includedTasks, MAX_DEPLOYED_TASKS, markBuiltTasks, markDeployedTasks } from "../src/deploy-tasks.js";
import { pendingBuilds } from "../src/pending.js";

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

test("canal de un destino por su nombre: staging → preview, production → production, otros → ninguno", () => {
  assert.equal(channelOfTarget("web#web-staging"), "preview");
  assert.equal(channelOfTarget("#staging"), "preview");
  assert.equal(channelOfTarget("apps/web#preview"), "preview");
  assert.equal(channelOfTarget("web#web-production"), "production");
  assert.equal(channelOfTarget("#prod"), "production");
  assert.equal(channelOfTarget("functions#firebase-functions"), null);
  assert.equal(channelOfTarget("#firebase-rules"), null);
  // La carpeta no cuenta: solo el nombre.
  assert.equal(channelOfTarget("staging#web"), null);
  // Sin palabra, production si en la misma carpeta está su versión de staging.
  const ids = ["#web", "#web-staging", "#rules", "functions#functions"];
  assert.equal(channelOfTarget("#web", ids), "production");
  assert.equal(channelOfTarget("#web-staging", ids), "preview");
  assert.equal(channelOfTarget("#rules", ids), null);
  assert.equal(channelOfTarget("other#web", ids), null);
});

test("deploy correcto: marca desplegadas en el canal las mergeadas que van en el commit y aún no lo estaban", async () => {
  const marked: string[] = [];
  const store = {
    mergedNotDeployed: async (channel: string) => (channel === "preview" ? [...merged, { id: "t5", title: "Sin merge", sha: "" }] : []),
    markDeployed: async (id: string, channel: string, sha: string) => void marked.push(`${id}:${channel}:${sha}`),
  };
  const out = await markDeployedTasks(store, "preview", "c", isAncestor);
  assert.deepEqual(marked, ["t1:preview:c", "t2:preview:c", "t3:preview:c"]);
  assert.deepEqual(out.map((f) => f.id), ["t1", "t2", "t3"]);
  assert.deepEqual(await markDeployedTasks(store, "production", "d", isAncestor), []);
});

test("si no se puede marcar (no es admin) o falla la lectura, el despliegue sigue", async () => {
  const failing = {
    mergedNotDeployed: async () => merged,
    markDeployed: async () => {
      throw new Error("permission-denied");
    },
  };
  assert.equal((await markDeployedTasks(failing, "production", "a", isAncestor)).length, 1);
  const unreadable = { mergedNotDeployed: async () => Promise.reject(new Error("offline")), markDeployed: async () => undefined };
  assert.deepEqual(await markDeployedTasks(unreadable, "production", "d", isAncestor), []);
});

test("build: marca por plataforma las tareas nuevas desde la última build de cada una, sin repetir las ya marcadas", async () => {
  const calls: { id: string; platforms: string[]; actionId: string }[] = [];
  const store = {
    mergedFeatures: async () => [
      { ...merged[0], builds: ["ios", "android"] },
      { ...merged[1], builds: ["ios"] },
      { ...merged[2], builds: [] },
      { ...merged[3], builds: [] },
    ],
    markBuilt: async (id: string, platforms: string[], build: { actionId: string }) => void calls.push({ id, platforms, actionId: build.actionId }),
  };
  const marks = await markBuiltTasks(store, ["ios", "android"], { version: "1.0.17", runtimeVersion: "1.0.17", actionId: "act1" }, "c", { ios: "b" }, isAncestor);
  // iOS: desde b solo entra t3; Android (sin build anterior): t2 y t3 (t1 ya estaba en una de Android); t4 no va en c.
  assert.deepEqual(Object.fromEntries(marks), { t3: ["ios", "android"], t2: ["android"] });
  assert.deepEqual(calls, [
    { id: "t3", platforms: ["ios", "android"], actionId: "act1" },
    { id: "t2", platforms: ["android"], actionId: "act1" },
  ]);
});

test("build repetida: no vuelve a marcar las tareas que ya tienen build de esa plataforma", async () => {
  const calls: string[] = [];
  const store = {
    mergedFeatures: async () => merged.map((f) => ({ ...f, builds: ["ios"] })),
    markBuilt: async (id: string) => void calls.push(id),
  };
  assert.equal((await markBuiltTasks(store, ["ios"], { version: "1.0.17", runtimeVersion: "1", actionId: "a2" }, "d", {}, isAncestor)).size, 0);
  assert.deepEqual(calls, []);
});

test("pendientes de build: por plataforma, las mergeadas desde su última build; sin build, no se sabe cuáles", async () => {
  const builds = await pendingBuilds(merged, "d", new Map([["build:ios", "b"], ["build", "b"]]), isAncestor);
  assert.deepEqual(builds, [
    { platform: "ios", lastSha: "b", count: 2, features: [{ id: "t3", title: "Tres" }, { id: "t4", title: "Cuatro" }] },
    { platform: "android" },
  ]);
});
