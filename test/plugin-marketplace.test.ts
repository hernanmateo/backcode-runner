import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// HOME_DIR se lee al importar: la carpeta de pruebas va antes.
process.env.BACKCODE_HOME = mkdtempSync(join(tmpdir(), "bc-market-home-"));
const { MARKETPLACE_REPO, PLUGIN_VERSION, classifyMarketplace, installOrUpdatePlugin, migrateStaleMarketplace, parseKnownMarketplaces, parseMarketplaceList } = await import("../src/plugin.js");

// Un `claude` de mentira: guarda los marketplaces y las instalaciones en un JSON y apunta cada llamada en un log.
type Market = { name: string; source: string; repo?: string; path?: string };
type State = { markets: Market[]; installs: { id: string; version: string; scope: string; projectPath?: string }[]; failUpdate?: boolean; noJson?: boolean };
const FAKE = `
const fs = require("node:fs");
const file = process.env.FAKE_CLAUDE_STATE;
const st = JSON.parse(fs.readFileSync(file, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(file + ".log", a.join(" ") + "\\n");
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const fail = (m) => { process.stderr.write(m); process.exit(1); };
const k = a.slice(0, 3).join(" ");
const scopeOf = () => a[a.indexOf("--scope") + 1];
if (k === "plugin marketplace list") { if (st.noJson) fail("unknown option --json"); console.log(JSON.stringify(st.markets)); }
else if (k === "plugin marketplace update") { if (st.failUpdate || !st.markets.some((m) => m.name === a[3])) fail("update failed"); }
else if (k === "plugin marketplace remove") {
  if (!st.markets.some((m) => m.name === a[3])) fail("not found");
  st.markets = st.markets.filter((m) => m.name !== a[3]);
  st.installs = st.installs.filter((i) => !i.id.endsWith("@" + a[3]));
  save();
}
else if (k === "plugin marketplace add") {
  if (st.markets.some((m) => m.name === "backcode")) fail("Marketplace 'backcode' is already installed");
  st.markets.push({ name: "backcode", source: "github", repo: a[3] });
  save();
}
else if (a[0] === "plugin" && a[1] === "list") console.log(JSON.stringify(st.installs));
else if (a[0] === "plugin" && a[1] === "install") { st.installs.push({ id: a[2], version: process.env.FAKE_LATEST, scope: scopeOf(), ...(scopeOf() === "user" ? {} : { projectPath: fs.realpathSync(process.cwd()) }) }); save(); }
else if (a[0] === "plugin" && a[1] === "update") { for (const i of st.installs) if (i.scope === scopeOf()) i.version = process.env.FAKE_LATEST; save(); }
else fail("unknown " + a.join(" "));
`;

function fakeClaude(state: State) {
  const dir = mkdtempSync(join(tmpdir(), "bc-fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!${process.execPath}\n${FAKE}`);
  chmodSync(bin, 0o755);
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify(state));
  writeFileSync(`${file}.log`, "");
  process.env.FAKE_CLAUDE_STATE = file;
  process.env.FAKE_LATEST = PLUGIN_VERSION;
  return {
    bin,
    known: join(dir, "known_marketplaces.json"),
    calls: () => readFileSync(`${file}.log`, "utf8").trim().split("\n").filter((l) => l && !l.startsWith("plugin list") && !l.startsWith("plugin marketplace list")),
    state: () => JSON.parse(readFileSync(file, "utf8")) as State,
  };
}

const OTHER: Market = { name: "otro", source: "github", repo: "acme/otro" };
const user = (version: string) => ({ id: "backcode@backcode", version, scope: "user" });

test("clasifica la fuente del marketplace backcode", () => {
  assert.deepEqual(classifyMarketplace(undefined), { state: "missing" });
  assert.equal(classifyMarketplace({ source: "github", repo: MARKETPLACE_REPO }).state, "current");
  assert.equal(classifyMarketplace({ source: "github", repo: "HernanMateo/Backcode-Dist" }).state, "current");
  assert.equal(classifyMarketplace({ source: "git", url: "https://github.com/hernanmateo/backcode-dist.git" }).state, "current");
  assert.deepEqual(classifyMarketplace({ source: "github", repo: "hernanmateo/backcode-runner" }), { state: "stale", source: "hernanmateo/backcode-runner" });
  assert.equal(classifyMarketplace({ source: "git", url: "git@github.com:hernanmateo/backcode-runner.git" }).state, "stale");
  assert.equal(classifyMarketplace({ source: "directory", path: "/dev/backcode" }).state, "local");
  assert.equal(classifyMarketplace({ source: "file", path: "/dev/marketplace.json" }).state, "local");
  // Solo la entrada backcode; lo que no se entiende, null.
  assert.equal(parseMarketplaceList(JSON.stringify([OTHER, { name: "backcode", source: "github", repo: "hernanmateo/backcode-runner" }]))?.state, "stale");
  assert.equal(parseMarketplaceList(JSON.stringify([OTHER]))?.state, "missing");
  assert.equal(parseMarketplaceList("x"), null);
  assert.equal(parseKnownMarketplaces(JSON.stringify({ backcode: { source: { source: "github", repo: "hernanmateo/backcode-runner" } }, otro: {} }))?.state, "stale");
  assert.equal(parseKnownMarketplaces(JSON.stringify({ otro: {} }))?.state, "missing");
  assert.equal(parseKnownMarketplaces("[]"), null);
});

test("marketplace en el repo antiguo → remove + add + install con el mismo alcance; los demás no se tocan", async () => {
  const project = mkdtempSync(join(tmpdir(), "bc-proj-"));
  const fake = fakeClaude({
    markets: [OTHER, { name: "backcode", source: "github", repo: "hernanmateo/backcode-runner" }],
    installs: [user("1.1.0"), { id: "backcode@backcode", version: "1.1.0", scope: "project", projectPath: project }, { id: "x@otro", version: "1.0.0", scope: "user" }],
  });
  const r = await installOrUpdatePlugin(fake.bin, fake.known);
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(fake.calls(), [
    "plugin marketplace remove backcode",
    `plugin marketplace add ${MARKETPLACE_REPO}`,
    "plugin install backcode@backcode --scope user",
    "plugin install backcode@backcode --scope project",
  ]);
  const st = fake.state();
  assert.deepEqual(st.markets, [OTHER, { name: "backcode", source: "github", repo: MARKETPLACE_REPO }]);
  assert.deepEqual(st.installs.map((i) => `${i.id} ${i.scope} ${i.version}`).sort(), [`backcode@backcode project ${PLUGIN_VERSION}`, `backcode@backcode user ${PLUGIN_VERSION}`, "x@otro user 1.0.0"]);

  // Idempotente: la segunda vez ya está en backcode-dist y al día → solo update.
  writeFileSync(`${process.env.FAKE_CLAUDE_STATE}.log`, "");
  assert.equal((await installOrUpdatePlugin(fake.bin, fake.known)).ok, true);
  assert.deepEqual(fake.calls(), ["plugin marketplace update backcode"]);
});

test("ya en backcode-dist → solo update (y update del plugin si es antiguo)", async () => {
  const fake = fakeClaude({ markets: [{ name: "backcode", source: "github", repo: MARKETPLACE_REPO }], installs: [user("1.0.0")] });
  assert.equal((await installOrUpdatePlugin(fake.bin, fake.known)).ok, true);
  assert.deepEqual(fake.calls(), ["plugin marketplace update backcode", "plugin update backcode@backcode --scope user"]);
  assert.equal(await migrateStaleMarketplace(fake.bin), false);
});

test("sin marketplace → add + install", async () => {
  const fake = fakeClaude({ markets: [OTHER], installs: [] });
  assert.equal((await installOrUpdatePlugin(fake.bin, fake.known)).ok, true);
  assert.deepEqual(fake.calls(), [`plugin marketplace add ${MARKETPLACE_REPO}`, "plugin install backcode@backcode --scope user"]);
  assert.deepEqual(fake.state().markets.map((m) => m.name), ["otro", "backcode"]);
});

test("marketplace local (para desarrollar) → no se quita ni se cambia, aunque falle el update", async () => {
  const local: Market = { name: "backcode", source: "directory", path: "/dev/backcode-runner" };
  const fake = fakeClaude({ markets: [local], installs: [user(PLUGIN_VERSION)], failUpdate: true });
  assert.equal((await installOrUpdatePlugin(fake.bin, fake.known)).ok, false);
  assert.deepEqual(fake.calls(), ["plugin marketplace update backcode"]);
  assert.deepEqual(fake.state().markets, [local]);
  assert.equal(await migrateStaleMarketplace(fake.bin), false);
});

test("en backcode-dist pero el update falla → remove + add en vez de solo add", async () => {
  const fake = fakeClaude({ markets: [{ name: "backcode", source: "github", repo: MARKETPLACE_REPO }], installs: [user(PLUGIN_VERSION)], failUpdate: true });
  assert.equal((await installOrUpdatePlugin(fake.bin, fake.known)).ok, true);
  assert.deepEqual(fake.calls(), ["plugin marketplace update backcode", "plugin marketplace remove backcode", `plugin marketplace add ${MARKETPLACE_REPO}`, "plugin install backcode@backcode --scope user"]);
});

test("Claude Code sin `marketplace list --json`: lee known_marketplaces.json; y la migración automática", async () => {
  const fake = fakeClaude({ markets: [{ name: "backcode", source: "github", repo: "hernanmateo/backcode-runner" }], installs: [user("1.1.0")], noJson: true });
  writeFileSync(fake.known, JSON.stringify({ backcode: { source: { source: "github", repo: "hernanmateo/backcode-runner" } } }));
  assert.equal((await installOrUpdatePlugin(fake.bin, fake.known)).ok, true);
  assert.deepEqual(fake.calls(), ["plugin marketplace remove backcode", `plugin marketplace add ${MARKETPLACE_REPO}`, "plugin install backcode@backcode --scope user"]);

  const auto = fakeClaude({ markets: [{ name: "backcode", source: "github", repo: "hernanmateo/backcode-runner" }], installs: [user("1.1.0")] });
  assert.equal(await migrateStaleMarketplace(auto.bin), true);
  assert.equal(auto.state().markets[0].repo, MARKETPLACE_REPO);
  assert.equal(await migrateStaleMarketplace(auto.bin), false);
});
