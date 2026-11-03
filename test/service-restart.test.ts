import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { wakeService } from "../src/app-launch.js";
import { kickstartArgs, kickstartSelf } from "../src/service.js";

/** Panel que responde a partir de la consulta número `upAfter` (Infinity: nunca). Apunta qué variante de kickstart se usa. */
function fake(upAfter: number, retry = false) {
  const calls: string[] = [];
  let checks = 0;
  return {
    calls,
    deps: {
      retry,
      alive: async () => ++checks > upAfter,
      kick: async () => void calls.push("kick"),
      restart: async () => void calls.push("restart"),
      sleep: async () => undefined,
    },
  };
}

test("kickstartArgs: -k solo para relanzar", () => {
  assert.deepEqual(kickstartArgs(false, 501), ["kickstart", "gui/501/com.backcode.runner"]);
  assert.deepEqual(kickstartArgs(true, 501), ["kickstart", "-k", "gui/501/com.backcode.runner"]);
});

test("wakeService: con el panel en marcha no toca nada", async () => {
  const f = fake(0);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, []);
});

test("wakeService: primera vez, kickstart sin -k; si arranca durante la espera, no se mata", async () => {
  const f = fake(10);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, ["kick"]);
});

test("wakeService: primera vez, si tras la espera sigue sin responder, kickstart -k", async () => {
  const f = fake(Infinity);
  assert.equal(await wakeService(f.deps), false);
  assert.deepEqual(f.calls, ["kick", "restart"]);
});

test("wakeService: primera vez, responde tras el -k", async () => {
  const f = fake(70);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, ["kick", "restart"]);
});

test("wakeService: «Reintentar» (panel ya visto sin responder) va directo a kickstart -k", async () => {
  const f = fake(1, true);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, ["restart"]);
});

test("wakeService: «Reintentar» con el panel ya respondiendo no lo mata", async () => {
  const f = fake(0, true);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, []);
});

test("kickstartSelf: kickstart -k aparte (detached, sin stdio) y unref; false si no se puede lanzar", { skip: process.platform !== "darwin" }, async () => {
  let seen: { cmd: string; args: string[]; opts: Record<string, unknown> } | undefined;
  let unref = false;
  const ok = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    seen = { cmd, args, opts };
    const child = Object.assign(new EventEmitter(), { unref: () => void (unref = true) });
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  assert.equal(await kickstartSelf(ok as never), true);
  assert.equal(seen?.cmd, "launchctl");
  assert.deepEqual(seen?.args.slice(0, 2), ["kickstart", "-k"]);
  assert.equal(seen?.opts.detached, true);
  assert.equal(seen?.opts.stdio, "ignore");
  assert.equal(unref, true);

  const failing = () => {
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    setImmediate(() => child.emit("error", new Error("ENOENT")));
    return child;
  };
  assert.equal(await kickstartSelf(failing as never), false);
  assert.equal(await kickstartSelf((() => { throw new Error("boom"); }) as never), false);
});

/** Como `fake`, pero con el servicio sin cargar en launchd hasta que se llama a `load`. */
function unloaded(upAfter: number, retry = false) {
  const f = fake(upAfter, retry);
  let isLoaded = false;
  return {
    calls: f.calls,
    deps: {
      ...f.deps,
      loaded: async () => isLoaded,
      load: async () => {
        isLoaded = true;
        f.calls.push("load");
      },
    },
  };
}

test("wakeService: plist sin cargar (tras «Apagar»): primero se carga, sin kickstart suelto", async () => {
  const f = unloaded(5);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, ["load"]);
});

test("wakeService: plist sin cargar y sigue sin responder tras cargarlo: kickstart -k (macOS 27)", async () => {
  const f = unloaded(Infinity);
  assert.equal(await wakeService(f.deps), false);
  assert.deepEqual(f.calls, ["load", "restart"]);
});

test("wakeService: «Reintentar» con el plist sin cargar también lo carga", async () => {
  const f = unloaded(1, true);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, ["load"]);
});

test("wakeService: si no se sabe si está cargado (null), como siempre", async () => {
  const f = fake(10);
  assert.equal(await wakeService({ ...f.deps, loaded: async () => null, load: async () => void f.calls.push("load") }), true);
  assert.deepEqual(f.calls, ["kick"]);
});

test("wakeService: con el panel en marcha ni mira si está cargado", async () => {
  const f = unloaded(0);
  assert.equal(await wakeService(f.deps), true);
  assert.deepEqual(f.calls, []);
});
