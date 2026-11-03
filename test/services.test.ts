import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceRows, settleChecks, versionIn, type ServiceNeeds, type ServiceProbe } from "../src/services.js";
import { PLUGIN_VERSION } from "../src/plugin.js";

const none: ServiceNeeds = { github: false, bitbucket: false, expo: false, firebase: false, wrangler: false, supabase: false };
const probe: ServiceProbe = {
  platform: "darwin",
  runner: { version: "1.4.0", latest: "1.5.0" },
  macApp: null,
  claude: { version: "2.1.3 (Claude Code)", loggedIn: true, latest: "2.1.3" },
  plugin: { version: PLUGIN_VERSION, enabled: true },
  git: "git version 2.44.0",
  node: "v22.3.0",
  gh: { version: "2.50.0", loggedIn: false },
  bitbucket: false,
  eas: null,
  firebase: { version: "13.1.0", latest: "13.2.0" },
  wrangler: null,
  supabase: null,
  xcode: "Xcode 16.2\nBuild version 16C5032a",
  android: null,
};

test("versionIn: solo el número de versión", () => {
  assert.equal(versionIn("git version 2.44.0 (Apple Git-145)"), "2.44.0");
  assert.equal(versionIn("v22.3.0"), "22.3.0");
  assert.equal(versionIn("token=abc"), null);
  assert.equal(versionIn(null), null);
});

test("serviceRows: estado y versión, solo lo que piden los proyectos", () => {
  const base = serviceRows(probe, none);
  assert.deepEqual(base.map((r) => r.id), ["runner", "claude", "plugin", "remoteControl", "git", "node"]);
  assert.deepEqual(base[0], { id: "runner", state: "outdated", version: "1.4.0", latest: "1.5.0" });
  assert.equal(base[1].state, "ok");
  assert.equal(base[1].version, "2.1.3");

  const all = serviceRows(probe, { github: true, bitbucket: true, expo: true, firebase: true, wrangler: true, supabase: false });
  const by = Object.fromEntries(all.map((r) => [r.id, r]));
  assert.equal(by.gh.state, "noSession");
  assert.equal(by.bitbucket.state, "noSession");
  assert.equal(by.eas.state, "missing");
  assert.equal(by.firebase.state, "outdated");
  assert.equal(by.wrangler.state, "missing");
  assert.equal(by.xcode.version, "16.2");
  assert.equal(by.android.state, "missing");
  assert.equal(by.supabase, undefined);

  const off = serviceRows({ ...probe, claude: null, plugin: { version: "0.1.0", enabled: false }, platform: "win32" }, none);
  const o = Object.fromEntries(off.map((r) => [r.id, r]));
  assert.equal(o.claude.state, "missing");
  assert.equal(o.plugin.state, "off");
  assert.equal(o.remoteControl.state, "off");
  // Nada de texto libre: solo ids, estados y números de versión.
  for (const r of all) assert.deepEqual(Object.keys(r).sort(), ["id", "latest", "state", "version"]);
});

test("serviceRows: plugin antiguo → outdated (la app ofrece actualizarlo)", () => {
  const rows = serviceRows({ ...probe, plugin: { version: "1.0.0", enabled: true } }, none);
  assert.deepEqual(rows.find((r) => r.id === "plugin"), { id: "plugin", state: "outdated", version: "1.0.0", latest: PLUGIN_VERSION });
});

test("serviceRows: lo que no se pudo comprobar sale como unknown, no como «no instalado»", () => {
  const rows = serviceRows({ ...probe, plugin: null, git: null, macApp: null, unknown: ["plugin", "git", "macApp"] }, none);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.plugin.state, "unknown");
  assert.equal(by.git.state, "unknown");
  assert.equal(by.macApp.state, "unknown");
  assert.equal(by.node.state, "ok");
});

test("settleChecks: una comprobación colgada y otra que falla no bloquean las demás", async () => {
  const logs: string[] = [];
  const started = Date.now();
  const { values, failed } = await settleChecks(
    {
      plugins: () => Promise.resolve([{ version: "1.0.0" }]),
      hangs: () => new Promise<string>(() => {}),
      throws: (): Promise<string> => Promise.reject(new Error("boom")),
      throwsSync: (): string => {
        throw new Error("sync boom");
      },
      skipped: null,
    },
    50,
    (m) => logs.push(m),
  );
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(values.plugins, [{ version: "1.0.0" }]);
  assert.equal(values.hangs, null);
  assert.equal(values.throws, null);
  assert.equal(values.throwsSync, null);
  assert.equal(values.skipped, null);
  assert.deepEqual(failed.sort(), ["hangs", "throws", "throwsSync"]);
  assert.ok(logs.some((l) => l.includes("«hangs»") && l.includes("no response")));
  assert.ok(logs.some((l) => l.includes("«throws»") && l.includes("boom")));
});
