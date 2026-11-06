import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Sin proyectos conectados (startRemoteControl no se conecta a nada en los tests).
process.env.BACKCODE_HOME ??= mkdtempSync(join(tmpdir(), "bc-control-"));
const { controlState, isControlRequest, parseControlRequest, runControlRequest, startRemoteControl } = await import("../src/remote-control.js");
import type { ControlTarget } from "../src/remote-control.js";
import type { ProjectRunner, Supervisor } from "../src/supervisor.js";

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

test("sesiones directas: reiniciar o actualizar no las cierra; apagar del todo sí (y publica antes de salir)", async () => {
  const { target } = fakeTarget();
  const order: string[] = [];
  const sessions = {
    open: async () => ({ ok: true }),
    close: () => undefined,
    list: () => [],
    closeAll: (reason?: string) => void order.push(`closeAll ${reason}`),
  };
  const hooks = { sessions, shutdown: () => void order.push("shutdown"), flush: async () => void order.push("flush"), restartAll: () => void order.push("restartAll"), updatePlugin: async () => null };
  await (await runControlRequest(target, hooks, { type: "restartAll" })).after?.();
  await (await runControlRequest(target, hooks, { type: "updateNow" })).after?.();
  target.checkUpdateNow = async () => true;
  await (await runControlRequest(target, hooks, { type: "updateNow" })).after?.();
  await runControlRequest(target, hooks, { type: "updateService", service: "runner" });
  assert.deepEqual(order, ["restartAll"]);
  await (await runControlRequest(target, hooks, { type: "shutdown" })).after?.();
  assert.deepEqual(order, ["restartAll", "closeAll shutdown", "flush", "shutdown"]);
});

test("el supervisor no cierra las sesiones directas al salir (reinicio, actualización): las adopta al volver", () => {
  const before = process.listenerCount("exit");
  let adopted = 0;
  let closed = 0;
  const { target } = fakeTarget();
  startRemoteControl(target as unknown as Supervisor, {
    shutdown: () => undefined,
    sessions: { open: async () => ({ ok: true }), close: () => undefined, list: () => [], closeAll: () => void closed++, adopt: () => void adopted++ },
  }, () => undefined);
  assert.equal(process.listenerCount("exit"), before);
  process.emit("exit", 0);
  assert.equal(closed, 0);
  assert.equal(adopted, 1);
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

test("sesión directa: tipos cerrados, proyecto conectado y prompt validado (solo en openProjectSession)", () => {
  assert.deepEqual(parseControlRequest({ type: "openProjectSession", projectId: "p1", status: "pending" }, connected), { type: "openProjectSession", projectId: "p1" });
  assert.deepEqual(parseControlRequest({ type: "closeProjectSession", projectId: "p1" }, connected), { type: "closeProjectSession", projectId: "p1" });
  assert.deepEqual(parseControlRequest({ type: "openProjectSession", projectId: "p1", prompt: "  Despliega las reglas\n\tpaso a paso  " }, connected), {
    type: "openProjectSession",
    projectId: "p1",
    prompt: "Despliega las reglas\n\tpaso a paso",
  });
  // Un prompt que parece una orden de shell es solo texto: se acepta (va como argumento, nunca dentro de la orden).
  assert.equal((parseControlRequest({ type: "openProjectSession", projectId: "p1", prompt: '"; rm -rf ~' }, connected) as { prompt: string }).prompt, '"; rm -rf ~');
  assert.ok("error" in parseControlRequest({ type: "openProjectSession" }, connected));
  assert.ok("error" in parseControlRequest({ type: "openProjectSession", projectId: "../x" }, connected));
  assert.ok("error" in parseControlRequest({ type: "openProjectSession", projectId: "otro" }, connected));
  assert.ok("error" in parseControlRequest({ type: "openProjectSession", projectId: "p1", service: "claude" }, connected));
  for (const prompt of ["", "   ", 3, null, ["x"], "x".repeat(4001), "hola\x00", "hola\x1b[2J", "a\rb"]) {
    assert.ok("error" in parseControlRequest({ type: "openProjectSession", projectId: "p1", prompt }, connected), JSON.stringify(prompt));
  }
  assert.ok(!("error" in parseControlRequest({ type: "openProjectSession", projectId: "p1", prompt: "x".repeat(4000) }, connected)));
  // Los demás tipos no llevan prompt.
  assert.ok("error" in parseControlRequest({ type: "closeProjectSession", projectId: "p1", prompt: "x" }, connected));
  assert.ok("error" in parseControlRequest({ type: "stopProject", projectId: "p1", prompt: "x" }, connected));
  assert.ok("error" in parseControlRequest({ type: "shutdown", prompt: "x" }, connected));
});

test("sesión directa: abre con la carpeta del proyecto, devuelve el enlace y cierra", async () => {
  const { target } = fakeTarget();
  target.projects.get("p1")!.repoPath = "/repos/web";
  const opened: unknown[] = [];
  const closed: string[] = [];
  const sessions = {
    open: async (id: string, project: { name?: string; repoPath?: string }, prompt?: string) => (
      opened.push([id, project, prompt]), id === "p1" ? { ok: true, url: "https://claude.ai/code/session_abc" } : { ok: false, code: "noRepo" as const, error: "x" }
    ),
    close: (id: string) => void closed.push(id),
    list: () => [],
    closeAll: () => undefined,
  };
  const hooks = { shutdown: () => undefined, sessions };
  assert.deepEqual(await runControlRequest(target, hooks, { type: "openProjectSession", projectId: "p1", prompt: "hola" }), { status: "done", result: { url: "https://claude.ai/code/session_abc" } });
  assert.deepEqual(opened, [["p1", { name: "Web", repoPath: "/repos/web" }, "hola"]]);
  assert.deepEqual(await runControlRequest(target, hooks, { type: "openProjectSession", projectId: "p2" }), { status: "failed", result: { code: "noRepo", error: "x" } });
  assert.equal((await runControlRequest(target, hooks, { type: "openProjectSession", projectId: "nope" })).status, "failed");
  assert.equal((await runControlRequest(target, hooks, { type: "closeProjectSession", projectId: "p1" })).status, "done");
  assert.deepEqual(closed, ["p1"]);
  // El estado publicado lleva las sesiones (sin rutas ni prompts).
  assert.deepEqual(controlState(target, [{ projectId: "p1", state: "open", url: "https://claude.ai/code/session_abc" }, { projectId: "../x", state: "opening" }]).sessions, [
    { projectId: "p1", state: "open", url: "https://claude.ai/code/session_abc" },
  ]);
});
