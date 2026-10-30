import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// HOME_DIR se lee al importar: la carpeta de pruebas va antes.
process.env.BACKCODE_HOME = mkdtempSync(join(tmpdir(), "bc-plugin-home-"));
const { PLUGIN_VERSION, olderThan, parsePluginList, parseRepoEnabled, pluginUpdateNotice, repoPlugin, runningPluginVersion } = await import("../src/plugin.js");

test("la versión del plugin que conoce el runner es la de plugins/backcode", () => {
  const manifest = JSON.parse(readFileSync(new URL("../plugins/backcode/.claude-plugin/plugin.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(PLUGIN_VERSION, manifest.version);
});

test("olderThan compara x.y.z por números y no se fía de lo que no entiende", () => {
  assert.equal(olderThan("1.1.0", "1.1.4"), true);
  assert.equal(olderThan("1.1.4", "1.1.4"), false);
  assert.equal(olderThan("1.2.0", "1.1.9"), false);
  assert.equal(olderThan("1.1.10", "1.1.9"), false);
  assert.equal(olderThan("1.1", "1.1.1"), true);
  assert.equal(olderThan("dev", "1.1.4"), false);
});

test("parsePluginList: solo backcode@backcode, una entrada por alcance", () => {
  const json = JSON.stringify([
    { id: "backcode@backcode", version: "1.1.0", scope: "project", projectPath: "/r" },
    { id: "backcode@backcode", version: "1.1.3", scope: "user", enabled: false },
    { id: "otro@x", version: "9.9.9", scope: "user" },
  ]);
  assert.deepEqual(parsePluginList(json), [
    { version: "1.1.0", scope: "project", enabled: true, projectPath: "/r" },
    { version: "1.1.3", scope: "user", enabled: false },
  ]);
  assert.deepEqual(parsePluginList("no es json"), []);
});

test("aviso en Claude Code: solo si el plugin es más antiguo, y como mucho uno al día", () => {
  const root = mkdtempSync(join(tmpdir(), "bc-plugin-root-"));
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  assert.equal(runningPluginVersion(root), "1.0.0");
  assert.equal(runningPluginVersion(join(root, "nada")), null);

  assert.equal(pluginUpdateNotice(PLUGIN_VERSION, "2026-10-30"), null);
  assert.equal(pluginUpdateNotice(null, "2026-10-30"), null);
  const notice = pluginUpdateNotice("1.0.0", "2026-10-30");
  assert.ok(notice?.includes("1.0.0") && notice.includes(PLUGIN_VERSION) && notice.includes("claude plugin update backcode@backcode"));
  assert.equal(pluginUpdateNotice("1.0.0", "2026-10-30"), null);
  assert.ok(pluginUpdateNotice("1.0.0", "2026-10-31"));
});

test("en cada repo: activado para el equipo, solo para ti o no activo", () => {
  assert.equal(parseRepoEnabled(JSON.stringify([{ id: "backcode@backcode", projectEnabled: true }])), true);
  assert.equal(parseRepoEnabled(JSON.stringify([{ id: "backcode@backcode", projectEnabled: false }, { id: "otro@x", projectEnabled: true }])), false);
  assert.equal(parseRepoEnabled("x"), false);
  const user = [{ version: "1.1.5", scope: "user", enabled: true }];
  assert.equal(repoPlugin(user, "/a", true), "repo");
  assert.equal(repoPlugin(user, "/a", false), "user");
  assert.equal(repoPlugin([{ version: "1.1.5", scope: "user", enabled: false }], "/a", false), "off");
  assert.equal(repoPlugin([{ version: "1.1.5", scope: "project", enabled: true, projectPath: "/a" }], "/a", false), "user");
  assert.equal(repoPlugin([{ version: "1.1.5", scope: "project", enabled: true, projectPath: "/b" }], "/a", false), "off");
  assert.equal(repoPlugin([], "/a", false), "off");
});
