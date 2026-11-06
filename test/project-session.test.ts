import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectSessions, type SessionDeps } from "../src/project-session.js";
import { remoteArgs, remoteCommand, type RemoteSession } from "../src/remote.js";

function fake(overrides: Partial<SessionDeps> = {}) {
  const launched: Parameters<SessionDeps["launch"]>[0][] = [];
  let exit: () => void = () => undefined;
  let stopped = 0;
  const deps: Partial<SessionDeps> = {
    claude: () => "/bin/claude",
    platform: "darwin",
    exists: () => true,
    ensurePlugin: async () => null,
    launch: async (opts) => {
      launched.push(opts);
      const exited = new Promise<void>((r) => (exit = r));
      const session: RemoteSession = { url: `https://claude.ai/code/session_${launched.length}`, exited, stop: () => void (stopped++, exit()) };
      return session;
    },
    ...overrides,
  };
  let changes = 0;
  const sessions = new ProjectSessions(() => void changes++, deps);
  return { sessions, launched, exit: () => exit(), stopped: () => stopped, changes: () => changes };
}

test("abre una sesión nueva en la carpeta del proyecto (sin --resume) y la reutiliza si ya está abierta", async () => {
  const f = fake();
  const r = await f.sessions.open("p1", { name: "Web", repoPath: "/repos/web" }, "Haz esto");
  assert.deepEqual(r, { ok: true, url: "https://claude.ai/code/session_1" });
  assert.deepEqual(f.launched, [{ bin: "/bin/claude", cwd: "/repos/web", name: "Web", prompt: "Haz esto" }]);
  assert.deepEqual(f.sessions.list(), [{ projectId: "p1", state: "open", url: "https://claude.ai/code/session_1" }]);
  // Otra petición: la misma sesión, sin lanzar otra ni mandar el prompt nuevo.
  assert.deepEqual(await f.sessions.open("p1", { repoPath: "/repos/web" }, "Otra cosa"), { ok: true, url: "https://claude.ai/code/session_1", reused: true });
  assert.equal(f.launched.length, 1);
  // Al salir de la sesión, desaparece.
  f.exit();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.sessions.list(), []);
  assert.ok(f.changes() >= 3);
});

test("cerrar para la sesión; closeAll las cierra todas", async () => {
  const f = fake();
  await f.sessions.open("p1", { repoPath: "/r" });
  f.sessions.close("p1");
  assert.equal(f.stopped(), 1);
  assert.deepEqual(f.sessions.list(), []);
  await f.sessions.open("p2", { repoPath: "/r" });
  f.sessions.closeAll();
  assert.equal(f.stopped(), 2);
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
    const built = remoteCommand(args, platform);
    assert.ok(!built.cmd.includes("rm -rf") && !built.cmd.includes("Web") && !built.cmd.includes("claude"), built.cmd);
    assert.match(built.cmd, /^cat \| script /);
    assert.equal(built.env.BC_RC_ARG_4, nasty);
    assert.equal(built.env.BC_RC_ARG_0, "/bin/claude");
  }
  assert.equal(remoteCommand(["a", "b"], "darwin").cmd, 'cat | script -q /dev/null "$BC_RC_ARG_0" "$BC_RC_ARG_1"');
  assert.equal(remoteCommand(["a", "b"], "linux").cmd, `cat | script -qfc '"$BC_RC_ARG_0" "$BC_RC_ARG_1"' /dev/null`);
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
