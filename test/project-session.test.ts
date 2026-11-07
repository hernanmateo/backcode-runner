import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessions, ProjectSessions, saveSessions, type SavedSession, type SessionDeps } from "../src/project-session.js";
import { keepAlive, launcher, remoteArgs, remoteCommand, SESSION_MARK, type RemoteSession } from "../src/remote.js";

function fake(overrides: Partial<SessionDeps> = {}, disk: SavedSession[] = []) {
  const launched: Parameters<SessionDeps["launch"]>[0][] = [];
  let exit: () => void = () => undefined;
  let stopped = 0;
  const killed: number[] = [];
  const store = { list: disk };
  const deps: Partial<SessionDeps> = {
    claude: () => "/bin/claude",
    platform: "darwin",
    exists: () => true,
    ensurePlugin: async () => null,
    launch: async (opts) => {
      launched.push(opts);
      const exited = new Promise<void>((r) => (exit = r));
      const session: RemoteSession = { url: `https://claude.ai/code/session_${launched.length}`, pid: 1000 + launched.length, exited, stop: () => void (stopped++, exit()) };
      return session;
    },
    load: () => store.list,
    save: (list) => void (store.list = list),
    isSession: () => false,
    alive: () => true,
    kill: (pid) => void killed.push(pid),
    watchMs: 5,
    ...overrides,
  };
  let changes = 0;
  const sessions = new ProjectSessions(() => void changes++, deps);
  return { sessions, launched, store, killed, exit: () => exit(), stopped: () => stopped, changes: () => changes };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("abre una sesión nueva en la carpeta del proyecto (sin --resume) y la reutiliza si ya está abierta", async () => {
  const f = fake();
  const r = await f.sessions.open("p1", { name: "Web", repoPath: "/repos/web" }, "Haz esto");
  assert.deepEqual(r, { ok: true, url: "https://claude.ai/code/session_1" });
  assert.deepEqual(f.launched, [{ bin: "/bin/claude", cwd: "/repos/web", name: "Web", persistent: true, prompt: "Haz esto" }]);
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "open", url: "https://claude.ai/code/session_1" }]);
  // Se guarda para adoptarla tras un reinicio (sin ruta ni prompt).
  assert.deepEqual(f.store.list.map(({ startedAt: _, ...s }) => s), [{ projectId: "p1", pid: 1001, url: "https://claude.ai/code/session_1" }]);
  // Otra petición sin mensaje o con el mismo («Reintentar»): la misma sesión, sin lanzar otra.
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/repos/web" }), { ok: true, url: "https://claude.ai/code/session_1", reused: true });
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/repos/web" }, "Haz esto"), { ok: true, url: "https://claude.ai/code/session_1", reused: true });
  assert.equal(f.launched.length, 1);
  // Al salir Claude de la sesión: cerrada, con el motivo, y fuera del disco.
  f.exit();
  await tick();
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "closed", closedReason: "exited" }]);
  assert.deepEqual(f.store.list, []);
  assert.ok(f.changes() >= 3);
  // Cerrar lo que ya está cerrado borra el aviso.
  f.sessions.close("p1");
  assert.deepEqual(f.sessions.list(), []);
});

test("sesión del proyecto abierta (con enlace) + botón de una tarea con prompt: se sustituye por una nueva con ese prompt y su enlace", async () => {
  const f = fake();
  await f.sessions.open("p1", { name: "Web", repoPath: "/repos/web" });
  const seen: string[] = [];
  const sessions = f.sessions;
  const states = () => seen.push(sessions.list()[0]?.state ?? "-");
  // Lo que se publica en cada cambio durante la sustitución: nunca «cerrada».
  const orig = (sessions as unknown as { onChange: () => void }).onChange;
  (sessions as unknown as { onChange: () => void }).onChange = () => (orig(), states());
  const r = await sessions.open("p1", { name: "Web", repoPath: "/repos/web" }, "Pasos de después de fusionar");
  assert.deepEqual(r, { ok: true, url: "https://claude.ai/code/session_2", replaced: true });
  assert.equal(f.stopped(), 1);
  assert.deepEqual(f.launched[1], { bin: "/bin/claude", cwd: "/repos/web", name: "Web", persistent: true, prompt: "Pasos de después de fusionar" });
  assert.ok(!seen.includes("closed"), seen.join(","));
  assert.deepEqual(sessions.list(), [{ projectId: "p1", state: "open", url: "https://claude.ai/code/session_2" }]);
  assert.deepEqual(f.store.list.map((s) => s.pid), [1002]);
  // El «exited» de la vieja no cierra la nueva.
  await tick();
  assert.equal(sessions.list()[0].state, "open");
});

test("una sesión abierta SIN enlace nunca se reutiliza: con o sin prompt se sustituye por una nueva", async () => {
  let n = 0;
  let stopped = 0;
  const f = fake({
    launch: async () => {
      n++;
      // La primera, sin enlace; las siguientes, con él.
      return { ...(n > 1 ? { url: `https://claude.ai/code/session_new${n}` } : {}), pid: 700 + n, exited: new Promise<void>(() => undefined), stop: () => void stopped++ };
    },
  });
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/r" }, "Haz esto"), { ok: true, linkless: true });
  // Mismo prompt («Reintentar»): sin enlace no sirve, otra.
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/r" }, "Haz esto"), { ok: true, url: "https://claude.ai/code/session_new2", replaced: true });
  assert.equal(stopped, 1);
  // Con enlace y sin prompt: la misma.
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/r" }), { ok: true, url: "https://claude.ai/code/session_new2", reused: true });
  assert.equal(n, 2);
});

test("una sesión adoptada sin enlace (tras reiniciar el runner) se cierra y se sustituye al abrir, también sin prompt", async () => {
  const f = fake({ isSession: () => true }, [{ projectId: "p1", pid: 4242, startedAt: 1 }]);
  f.sessions.adopt();
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/r" }), { ok: true, url: "https://claude.ai/code/session_1", replaced: true });
  assert.deepEqual(f.killed, [4242]);
  // Adoptada con enlace + prompt: también se sustituye (no se sabe con qué mensaje se abrió).
  const g = fake({ isSession: () => true }, [{ projectId: "p1", pid: 4343, url: "https://claude.ai/code/session_old", startedAt: 1 }]);
  g.sessions.adopt();
  assert.deepEqual(await g.sessions.open("p1", { repoPath: "/r" }, "Nuevo"), { ok: true, url: "https://claude.ai/code/session_1", replaced: true });
  assert.deepEqual(g.killed, [4343]);
});

test("si no se podría abrir otra (sin carpeta), la abierta no se toca", async () => {
  let exists = true;
  const f = fake({ exists: () => exists });
  await f.sessions.open("p1", { repoPath: "/r" });
  exists = false;
  const r = await f.sessions.open("p1", { repoPath: "/r" }, "Otra cosa");
  assert.equal(r.ok, false);
  assert.equal(r.code, "noRepo");
  assert.equal(f.stopped(), 0);
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "open", url: "https://claude.ai/code/session_1" }]);
});

test("cerrar desde la app para la sesión (motivo «user»); closeAll, al apagar, las cierra todas («shutdown»)", async () => {
  const f = fake();
  await f.sessions.open("p1", { repoPath: "/r" });
  f.sessions.close("p1");
  assert.equal(f.stopped(), 1);
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "closed", closedReason: "user" }]);
  await tick();
  // El `exited` que llega después no cambia el motivo.
  assert.equal(f.sessions.list()[0].closedReason, "user");
  await f.sessions.open("p2", { repoPath: "/r" });
  f.sessions.closeAll();
  assert.equal(f.stopped(), 2);
  assert.deepEqual(f.sessions.list().find((s) => s.projectId === "p2"), { projectId: "p2", state: "closed", closedReason: "shutdown" });
  assert.deepEqual(f.store.list, []);
});

test("tras un reinicio del runner adopta las sesiones que siguen vivas (con su enlace) y marca las que no", async () => {
  const disk: SavedSession[] = [
    { projectId: "p1", pid: 4242, url: "https://claude.ai/code/session_live", startedAt: 1 },
    { projectId: "p2", pid: 4343, url: "https://claude.ai/code/session_gone", startedAt: 2 },
  ];
  let alive = true;
  const f = fake({ isSession: (pid) => pid === 4242, alive: () => alive }, disk);
  f.sessions.adopt();
  assert.deepEqual(f.sessions.list(), [
    { projectId: "p1", state: "open", url: "https://claude.ai/code/session_live" },
    { projectId: "p2", state: "closed", closedReason: "restart" },
  ]);
  assert.deepEqual(f.store.list.map((s) => s.projectId), ["p1"]);
  // Abrir otra vez la reutiliza, sin lanzar nada.
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/r" }), { ok: true, url: "https://claude.ai/code/session_live", reused: true });
  assert.equal(f.launched.length, 0);
  // Cuando termina (Claude sale), se ve cerrada.
  alive = false;
  await tick(30);
  assert.deepEqual(f.sessions.list()[0], { projectId: "p1", state: "closed", closedReason: "exited" });
  assert.deepEqual(f.store.list, []);
});

test("cerrar una sesión adoptada mata su grupo de procesos", () => {
  const f = fake({ isSession: () => true }, [{ projectId: "p1", pid: 4242, url: "https://claude.ai/code/session_x", startedAt: 1 }]);
  f.sessions.adopt();
  f.sessions.close("p1");
  assert.deepEqual(f.killed, [4242]);
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "closed", closedReason: "user" }]);
});

test("viva pero sin enlace a tiempo: abierta sin enlace (no fallida); el enlace que llega luego se publica y se guarda", async () => {
  let giveUrl: (url: string) => void = () => undefined;
  let stopped = 0;
  const f = fake({
    launch: async () => ({ pid: 777, exited: new Promise<void>(() => undefined), stop: () => void stopped++, onUrl: (cb) => void (giveUrl = cb) }),
  });
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/r" }, "Pasos de después de fusionar"), { ok: true, linkless: true });
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "open" }]);
  assert.deepEqual(f.store.list.map(({ startedAt: _, ...s }) => s), [{ projectId: "p1", pid: 777 }]);
  assert.equal(stopped, 0);
  giveUrl("https://claude.ai/code/session_late");
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "open", url: "https://claude.ai/code/session_late" }]);
  assert.equal(f.store.list[0].url, "https://claude.ai/code/session_late");
  // Se puede cerrar desde Backcode.
  f.sessions.close("p1");
  assert.equal(stopped, 1);
});

test("una sesión guardada sin enlace se adopta igual tras un reinicio", () => {
  const f = fake({ isSession: () => true }, [{ projectId: "p1", pid: 4242, startedAt: 1 }]);
  f.sessions.adopt();
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "open" }]);
});

test("el fichero de sesiones: solo entradas con buena forma y permisos 600", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-sessions-"));
  const file = join(dir, "sessions.json");
  writeFileSync(file, JSON.stringify([
    { projectId: "p1", pid: 4242, url: "https://claude.ai/code/session_ok", startedAt: 1, prompt: "secreto" },
    { projectId: "../x", pid: 1, url: "https://claude.ai/code/session_ok" },
    { projectId: "p2", pid: 1, url: "https://claude.ai/code/session_ok" },
    { projectId: "p3", pid: 99, url: "https://evil.example/session" },
    { projectId: "p4", pid: 98, startedAt: 3 },
  ]));
  assert.deepEqual(loadSessions(file), [
    { projectId: "p1", pid: 4242, url: "https://claude.ai/code/session_ok", startedAt: 1 },
    { projectId: "p4", pid: 98, startedAt: 3 },
  ]);
  saveSessions(loadSessions(file), file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadSessions(join(dir, "nope.json")).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("fallos con código: sin claude, sin carpeta, plugin y fallo al lanzar", async () => {
  assert.equal((await fake({ claude: () => null }).sessions.open("p1", { repoPath: "/r" })).code, "unavailable");
  assert.equal((await fake({ platform: "win32" }).sessions.open("p1", { repoPath: "/r" })).code, "unavailable");
  assert.equal((await fake().sessions.open("p1", {})).code, "noRepo");
  assert.equal((await fake({ exists: () => false }).sessions.open("p1", { repoPath: "/r" })).code, "noRepo");
  const plugin = fake({ ensurePlugin: async () => "no marketplace" });
  const r = await plugin.sessions.open("p1", { repoPath: "/r" });
  assert.equal(r.code, "plugin");
  assert.equal(plugin.launched.length, 0);
  assert.deepEqual(plugin.sessions.list().map((s) => [s.state, s.code]), [["failed", "plugin"]]);
  assert.equal((await fake({ launch: async () => Promise.reject(new Error("timeout: ...")) }).sessions.open("p1", { repoPath: "/r" })).code, "timeout");
  assert.equal((await fake({ launch: async () => Promise.reject(new Error("exit 1")) }).sessions.open("p1", { repoPath: "/r" })).code, "failed");
});

test("el plugin se asegura antes de lanzar, en la carpeta del proyecto", async () => {
  const seen: string[] = [];
  const f = fake({ ensurePlugin: async (_c, dir) => (seen.push(dir), null) });
  await f.sessions.open("p1", { repoPath: "/repos/web" });
  assert.deepEqual(seen, ["/repos/web"]);
  assert.equal(f.launched.length, 1);
});

test("orden de Remote Control: el prompt va como argumento tras «--» y nunca dentro de la orden del shell", () => {
  const nasty = "\"; rm -rf ~ $(id) `id` '";
  const args = remoteArgs({ bin: "/bin/claude", name: "Web", prompt: nasty });
  assert.deepEqual(args, ["/bin/claude", "--remote-control", "Web", "--", nasty]);
  assert.deepEqual(remoteArgs({ bin: "claude", name: "T", sessionId: "s1" }), ["claude", "--resume", "s1", "--remote-control", "T"]);
  for (const platform of ["darwin", "linux"] as const) {
    for (const persistent of [false, true]) {
      const built = remoteCommand(args, platform, persistent);
      assert.ok(!built.cmd.includes("rm -rf") && !built.cmd.includes("Web") && !built.cmd.includes("claude"), built.cmd);
      assert.match(built.cmd, persistent ? /^\{ cat; exec sleep 2147483647; \} \| script / : /^cat \| script /);
      assert.equal(built.env.BC_RC_ARG_4, nasty);
      assert.equal(built.env.BC_RC_ARG_0, "/bin/claude");
    }
  }
  // Terminal simulado ancho y fijo (la URL de la sesión sale entera en una línea).
  assert.equal(remoteCommand(["a", "b"], "darwin").cmd, `cat | script -q /dev/null sh -c 'stty cols 500 rows 60 2>/dev/null; exec "$@"' sh "$BC_RC_ARG_0" "$BC_RC_ARG_1"`);
  assert.equal(remoteCommand(["a", "b"], "linux").cmd, `cat | script -qfc 'stty cols 500 rows 60 2>/dev/null; exec "$BC_RC_ARG_0" "$BC_RC_ARG_1"' /dev/null`);
  assert.equal(
    remoteCommand(["a", "b"], "darwin", true).cmd,
    `{ cat; exec sleep 2147483647; } | script -q /dev/null sh -c 'stty cols 500 rows 60 2>/dev/null; exec "$@"' sh "$BC_RC_ARG_0" "$BC_RC_ARG_1" 2>&1 | { cat; cat >/dev/null; kill 0; }`,
  );
});

test("bajo systemd, la sesión directa va en su propio scope (orden fija); si no, sh -c", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-bin-"));
  writeFileSync(join(dir, "systemd-run"), "");
  const env = { PATH: dir, INVOCATION_ID: "x" };
  assert.deepEqual(launcher("CMD", true, "linux", env), ["systemd-run", ["--user", "--scope", "--collect", "--quiet", "sh", "-c", "CMD"]]);
  assert.deepEqual(launcher("CMD", false, "linux", env), ["sh", ["-c", "CMD"]]);
  assert.deepEqual(launcher("CMD", true, "linux", { PATH: dir }), ["sh", ["-c", "CMD"]]);
  assert.deepEqual(launcher("CMD", true, "darwin", env), ["sh", ["-c", "CMD"]]);
  rmSync(dir, { recursive: true, force: true });
});

test("la sesión sobrevive a que muera el proceso que la lanzó, y al terminar se cierra su grupo entero", async () => {
  // `script` necesita un terminal (no siempre hay en los tests): en su lugar, un shell que lee una línea y sigue escribiendo.
  const dir = mkdtempSync(join(tmpdir(), "bc-keep-"));
  const out = join(dir, "out.txt");
  const inner = 'sh -c "$BC_RC_ARG_0"';
  const body = 'read x; echo "got:$x" >> "$BC_OUT"; i=0; while [ $i -lt 8 ]; do echo tick; i=$((i+1)); sleep 0.2; done; echo DONE >> "$BC_OUT"';
  // El padre lanza la sesión aparte, le manda una línea y sale enseguida (como un reinicio del runner).
  const parent = `
    const { spawn } = require("node:child_process");
    const c = spawn("sh", ["-c", process.env.BC_CMD], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    c.stdout.on("data", () => undefined);
    c.stdin.write("hola\\n");
    console.log(c.pid);
    setTimeout(() => process.exit(0), 300);`;
  const p = spawn(process.execPath, ["-e", parent], { env: { ...process.env, BC_CMD: keepAlive(inner), BC_RC_ARG_0: body, BC_OUT: out }, stdio: ["ignore", "pipe", "inherit"] });
  let pid = "";
  p.stdout.on("data", (d: Buffer) => (pid += d.toString()));
  await new Promise((r) => p.on("exit", r));
  await tick(2500);
  assert.equal(readFileSync(out, "utf8"), "got:hola\nDONE\n");
  // Al terminar, `kill 0` cierra el grupo (también el `sleep` que mantenía la entrada abierta).
  assert.throws(() => process.kill(-Number(pid.trim()), 0));
  assert.ok(keepAlive(inner).includes(SESSION_MARK));
  rmSync(dir, { recursive: true, force: true });
});

test("mientras se abre publica la fase: preparando (plugin) y arrancando (Claude Code, hasta el enlace)", async () => {
  const seen: (string | undefined)[] = [];
  let f: ReturnType<typeof fake>;
  f = fake({
    ensurePlugin: async () => (seen.push(f.sessions.list()[0]?.phase), null),
    launch: async () => {
      seen.push(f.sessions.list()[0]?.phase);
      return { url: "https://claude.ai/code/session_x", exited: new Promise<void>(() => undefined), stop: () => undefined };
    },
  });
  await f.sessions.open("p1", { repoPath: "/repos/web" });
  assert.deepEqual(seen, ["preparing", "starting"]);
  assert.equal(f.sessions.list()[0]?.phase, undefined);
});
