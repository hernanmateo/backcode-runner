import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diagnose, failedExit, logExcerpt, parseDisabled, parseLaunchctlPrint, parseLsof, type DiagnoseDeps } from "../src/app-diagnose.js";
import { appLine, bringUpPanel } from "../src/app-launch.js";

const PRINT_RUNNING = `gui/501/com.backcode.runner = {
\tactive count = 1
\tpath = /Users/me/Library/LaunchAgents/com.backcode.runner.plist
\tstate = running
\tprogram = /Users/me/.backcode/bin/backcode
\tpid = 4321
\tlast exit code = (never exited)
\tendpoints = {
\t\tstate = active
\t}
}`;

const PRINT_CRASHED = `gui/501/com.backcode.runner = {
\tstate = not running
\tlast exit code = 1
}`;

const PRINT_WAITING = `gui/501/com.backcode.runner = {
\tstate = spawn scheduled
\tlast exit code = (never exited)
}`;

/** Ordenador falso: lo que dirían launchctl, lsof y el registro. */
function deps(over: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  return {
    service: true,
    launchctlPrint: async () => PRINT_RUNNING,
    printDisabled: async () => "disabled services = {\n\t\"com.apple.foo\" => enabled\n}",
    portOwner: async () => null,
    readLog: () => "",
    port: 47474,
    ...over,
  };
}

test("parseLaunchctlPrint: solo el primer nivel", () => {
  assert.deepEqual(parseLaunchctlPrint(PRINT_RUNNING), { state: "running", pid: 4321, lastExitCode: "(never exited)" });
  assert.deepEqual(parseLaunchctlPrint(PRINT_CRASHED), { state: "not running", lastExitCode: "1" });
});

test("parseDisabled: desactivado (Ítems de inicio) y activado", () => {
  assert.equal(parseDisabled('\t"com.backcode.runner" => disabled'), true);
  assert.equal(parseDisabled('\t"com.backcode.runner" => true'), true);
  assert.equal(parseDisabled('\t"com.backcode.runner" => enabled'), false);
  assert.equal(parseDisabled('\t"com.other" => disabled'), false);
});

test("parseLsof: pid y orden", () => {
  assert.deepEqual(parseLsof("p999\ncpython3\nf5\n"), { pid: 999, command: "python3" });
  assert.equal(parseLsof(""), null);
});

test("failedExit", () => {
  assert.equal(failedExit("1"), true);
  assert.equal(failedExit("-9"), true);
  assert.equal(failedExit("0"), false);
  assert.equal(failedExit("(never exited)"), false);
  assert.equal(failedExit(undefined), false);
});

test("logExcerpt: líneas de error, sin secretos ni el token del panel", () => {
  const log = [
    "Panel: http://127.0.0.1:47474/#t=abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "starting",
    "Error: listen EADDRINUSE: address already in use 127.0.0.1:47474",
    // Token falso montado en el test (que el escáner de secretos no lo confunda con uno de verdad).
    `fail: GITHUB_TOKEN=${["gh", "p_"].join("")}${"a1".repeat(18)}`,
    "ok",
  ].join("\n");
  const out = logExcerpt(log);
  assert.equal(out.length, 2);
  assert.match(out[0], /EADDRINUSE/);
  assert.match(out[1], /hidden/);
  assert.ok(!out.join("\n").includes("ghp_"));
  // Sin errores: las últimas líneas, con el token tapado.
  const plain = logExcerpt("Panel: http://127.0.0.1:47474/#t=abcdefghijklmnopqrstuvwxyz0123456789ABCD\nready");
  assert.ok(!plain.join("\n").includes("abcdefghij"));
  assert.match(plain[0], /#t=<token>/);
});

test("diagnose: puerto ocupado por otro programa, con su PID", async () => {
  const d = await diagnose(deps({ portOwner: async () => ({ pid: 777, command: "python3" }) }));
  assert.equal(d.kind, "port-busy");
  assert.match(d.message, /47474.*python3 \(PID 777\)/);
  assert.match(d.hint, /kill 777/);
});

test("diagnose: puerto en manos del propio servicio colgado", async () => {
  const d = await diagnose(deps({ portOwner: async () => ({ pid: 4321, command: "backcode" }) }));
  assert.equal(d.kind, "port-busy");
  assert.match(d.message, /older or stuck Backcode/);
});

test("diagnose: bloqueado en Ítems de inicio", async () => {
  const d = await diagnose(deps({ printDisabled: async () => '\t"com.backcode.runner" => disabled' }));
  assert.equal(d.kind, "blocked");
  assert.equal(d.loginItems, true);
  assert.match(d.hint, /Login Items/);
});

test("diagnose: servicio no cargado en launchd", async () => {
  const d = await diagnose(deps({ launchctlPrint: async () => null }));
  assert.equal(d.kind, "not-loaded");
  assert.equal(d.loginItems, true);
});

test("diagnose: en espera (no arranca)", async () => {
  const d = await diagnose(deps({ launchctlPrint: async () => PRINT_WAITING }));
  assert.equal(d.kind, "not-running");
  assert.match(d.message, /spawn scheduled/);
});

test("diagnose: se cae al arrancar, con el extracto del registro", async () => {
  const d = await diagnose(deps({ launchctlPrint: async () => PRINT_CRASHED, readLog: () => "boot\nError: Cannot find module x\n" }));
  assert.equal(d.kind, "crashed");
  assert.match(d.message, /exit code 1/);
  assert.deepEqual(d.log, ["Error: Cannot find module x"]);
});

test("diagnose: en marcha pero sin panel", async () => {
  const d = await diagnose(deps());
  assert.equal(d.kind, "unknown");
  assert.match(d.message, /PID 4321/);
});

test("diagnose: sin servicio no consulta launchd", async () => {
  let asked = false;
  const d = await diagnose(deps({ service: false, launchctlPrint: async () => ((asked = true), null) }));
  assert.equal(d.kind, "no-panel");
  assert.equal(asked, false);
});

test("diagnose: si un comando falla, no rompe el diagnóstico", async () => {
  const d = await diagnose(
    deps({
      portOwner: async () => Promise.reject(new Error("lsof")),
      readLog: () => {
        throw new Error("EACCES");
      },
    }),
  );
  assert.equal(d.kind, "unknown");
});

/** Dependencias falsas de bringUpPanel: el panel responde a partir de la consulta `upAfter`. */
function panel(mode: "no-service" | "install" | "wake", upAfter: number, over: { installFails?: boolean; retry?: boolean } = {}) {
  const calls: string[] = [];
  const steps: string[] = [];
  let checks = 0;
  return {
    calls,
    steps,
    deps: {
      mode,
      retry: !!over.retry,
      alive: async () => ++checks > upAfter,
      serve: () => void calls.push("serve"),
      install: async () => {
        calls.push("install");
        if (over.installFails) throw new Error("Bootstrap failed: 5: Input/output error");
      },
      kick: async () => void calls.push("kick"),
      restart: async () => void calls.push("restart"),
      sleep: async () => undefined,
      step: (s: string) => void steps.push(s),
      url: () => "http://127.0.0.1:47474/#t=x",
      diagnose: async () => ({ kind: "not-loaded" as const, message: "not loaded", hint: "retry" }),
    },
  };
}

test("bringUpPanel: el panel responde, devuelve la dirección", async () => {
  const p = panel("wake", 3);
  assert.deepEqual(await bringUpPanel(p.deps), { url: "http://127.0.0.1:47474/#t=x" });
  assert.deepEqual(p.calls, ["kick"]);
  assert.ok(p.steps.includes("Starting the service…"));
  assert.ok(p.steps.includes("Waiting for the panel…"));
});

test("bringUpPanel: nunca responde, devuelve el diagnóstico y no la dirección", async () => {
  const p = panel("wake", Infinity);
  const r = await bringUpPanel(p.deps);
  assert.ok(!("url" in r));
  assert.equal("diagnosis" in r && r.diagnosis.kind, "not-loaded");
  assert.deepEqual(p.calls, ["kick", "restart"]);
  assert.ok(p.steps.includes("Restarting the service…"));
});

test("bringUpPanel: si launchctl no carga el servicio, diagnóstico sin esperar", async () => {
  const p = panel("install", 0, { installFails: true });
  const r = await bringUpPanel(p.deps);
  assert.ok("diagnosis" in r);
  assert.deepEqual(p.calls, ["install"]);
});

test("bringUpPanel: sin servicio lanza el panel suelto solo si no está", async () => {
  const off = panel("no-service", 2);
  assert.ok("url" in (await bringUpPanel(off.deps)));
  assert.deepEqual(off.calls, ["serve"]);
  const on = panel("no-service", 0);
  assert.ok("url" in (await bringUpPanel(on.deps)));
  assert.deepEqual(on.calls, []);
});

test("appLine: progreso, dirección y error en una línea", () => {
  assert.equal(appLine.step("Waiting for the panel…"), "status: Waiting for the panel…");
  assert.equal(appLine.result({ url: "http://x" }), "http://x");
  const line = appLine.result({ diagnosis: { kind: "blocked", message: "m\nx", hint: "h", loginItems: true } });
  assert.ok(line.startsWith("error: ") && !line.includes("\n"));
  assert.equal(JSON.parse(line.slice(7)).kind, "blocked");
});
