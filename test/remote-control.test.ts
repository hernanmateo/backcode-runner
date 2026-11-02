import assert from "node:assert/strict";
import { test } from "node:test";
import { controlState, isControlRequest, parseControlRequest, runControlRequest, type ControlTarget } from "../src/remote-control.js";
import type { ProjectRunner } from "../src/supervisor.js";

const connected = ["p1", "web-app"];

test("petición de control: tipos fijos, ids con la regex y proyecto conectado en este ordenador", () => {
  assert.deepEqual(parseControlRequest({ type: "stopProject", projectId: "p1", status: "pending" }, connected), { type: "stopProject", projectId: "p1" });
  assert.deepEqual(parseControlRequest({ type: "restartAll" }, connected), { type: "restartAll" });
  for (const type of ["updateNow", "pauseAll", "resumeAll", "shutdown"]) assert.deepEqual(parseControlRequest({ type }, connected), { type });
  // Comandos libres o tipos desconocidos: nunca.
  for (const type of ["exec", "rm -rf ~", "", 3, null]) assert.ok("error" in parseControlRequest({ type, projectId: "p1" }, connected), String(type));
  assert.ok("error" in parseControlRequest({ type: "startProject" }, connected));
  assert.ok("error" in parseControlRequest({ type: "startProject", projectId: "../x" }, connected));
  assert.ok("error" in parseControlRequest({ type: "startProject", projectId: "otro" }, connected));
  // Las generales no llevan proyecto.
  assert.ok("error" in parseControlRequest({ type: "shutdown", projectId: "p1" }, connected));
});

test("las de «Conectar en <host>» (sin type) no son de control", () => {
  assert.equal(isControlRequest({ projectId: "p1", baseBranch: "main", pullRequest: "github" }), false);
  assert.equal(isControlRequest({ type: "pauseAll" }), true);
});

function fakeTarget() {
  const calls: string[] = [];
  let off = false;
  const projects = new Map<string, ProjectRunner>([
    ["p1", { id: "p1", file: "/x/p1.env", name: "Web", state: "running", logs: [], retries: 0, child: {} as ProjectRunner["child"] }],
    ["p2", { id: "p2", file: "/x/p2.env", state: "stopped", logs: [], retries: 0 }],
  ]);
  const target: ControlTarget = {
    projects,
    get off() {
      return off;
    },
    scan: () => undefined,
    start: (id) => (calls.push(`start ${id}`), projects.has(id)),
    stop: async (id) => void calls.push(`stop ${id}`),
    restart: async (id) => (calls.push(`restart ${id}`), projects.has(id)),
    setPower: async (on) => void (calls.push(`power ${on}`), (off = !on)),
    restartAllWhenIdle: () => void calls.push("restartAllWhenIdle"),
    checkUpdateNow: async () => (calls.push("update"), false),
  };
  return { target, calls };
}

test("cada tipo hace lo suyo; lo que corta el proceso va después del resultado", async () => {
  const { target, calls } = fakeTarget();
  let shut = 0;
  const hooks = { shutdown: () => void shut++, updatePlugin: async () => (calls.push("plugin"), null) };

  assert.equal((await runControlRequest(target, hooks, { type: "stopProject", projectId: "p1" })).status, "done");
  assert.equal((await runControlRequest(target, hooks, { type: "startProject", projectId: "p2" })).status, "done");
  assert.equal((await runControlRequest(target, hooks, { type: "restartProject", projectId: "p1" })).status, "done");
  assert.deepEqual(calls.splice(0), ["stop p1", "start p2", "restart p1"]);

  const restart = await runControlRequest(target, hooks, { type: "restartAll" });
  assert.deepEqual(calls, []);
  await restart.after?.();
  assert.deepEqual(calls.splice(0), ["restartAllWhenIdle"]);

  const update = await runControlRequest(target, hooks, { type: "updateNow" });
  assert.deepEqual(update.result, { updated: false });
  await update.after?.();
  assert.deepEqual(calls.splice(0), ["update", "plugin", "restartAllWhenIdle"]);

  await runControlRequest(target, hooks, { type: "pauseAll" });
  assert.equal(controlState(target).paused, true);
  assert.deepEqual(controlState(target).projects, [
    { id: "p1", name: "Web", state: "running" },
    { id: "p2", name: null, state: "paused" },
  ]);
  await runControlRequest(target, hooks, { type: "resumeAll" });
  assert.deepEqual(calls.splice(0), ["power false", "power true"]);

  const off = await runControlRequest(target, hooks, { type: "shutdown" });
  assert.equal(shut, 0);
  await off.after?.();
  assert.equal(shut, 1);
});

test("actualizar ahora: con versión nueva no repite los reinicios y avisa si el plugin falla", async () => {
  const { target, calls } = fakeTarget();
  target.checkUpdateNow = async () => (calls.push("update"), true);
  const r = await runControlRequest(target, { shutdown: () => undefined, updatePlugin: async () => "boom" }, { type: "updateNow" });
  assert.equal(r.status, "done");
  assert.equal(r.result.updated, true);
  assert.match(r.result.pluginError ?? "", /boom/);
  assert.equal(r.after, undefined);
});

test("actualizar un servicio: solo los de la lista cerrada, nunca comandos", async () => {
  for (const service of ["runner", "macApp", "plugin", "claude", "eas"]) assert.deepEqual(parseControlRequest({ type: "updateService", service }, connected), { type: "updateService", service });
  for (const service of ["git", "gh", "xcode", "npm install -g x", "", null, 3, undefined]) assert.ok("error" in parseControlRequest({ type: "updateService", service }, connected), String(service));
  assert.ok("error" in parseControlRequest({ type: "updateService", service: "plugin", projectId: "p1" }, connected));
  assert.ok("error" in parseControlRequest({ type: "updateNow", service: "plugin" }, connected));

  const { target, calls } = fakeTarget();
  const tools: string[] = [];
  const hooks = { shutdown: () => undefined, updatePlugin: async () => (calls.push("plugin"), null), updateTool: async (s: "claude" | "eas") => (tools.push(s), s === "eas" ? "EACCES" : null) };
  assert.deepEqual((await runControlRequest(target, hooks, { type: "updateService", service: "runner" })).result, { updated: false });
  assert.deepEqual((await runControlRequest(target, hooks, { type: "updateService", service: "plugin" })).result, { updated: true });
  assert.deepEqual(calls, ["update", "plugin"]);
  assert.equal((await runControlRequest(target, hooks, { type: "updateService", service: "claude" })).status, "done");
  const eas = await runControlRequest(target, hooks, { type: "updateService", service: "eas" });
  assert.equal(eas.status, "failed");
  assert.match(eas.result.error ?? "", /EACCES/);
  assert.deepEqual(tools, ["claude", "eas"]);
});
