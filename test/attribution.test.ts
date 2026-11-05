import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_SETTINGS } from "../src/preflight.js";

test("sin atribución de Claude en commits ni PRs", () => {
  assert.deepEqual(CLAUDE_SETTINGS.attribution, { commit: "", pr: "" });
  assert.equal(CLAUDE_SETTINGS.includeCoAuthoredBy, false);
});

test("cada query() del Agent SDK pasa CLAUDE_SETTINGS", () => {
  const dir = join(import.meta.dirname, "..", "src");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    const calls = src.match(/\bquery\(\{/g)?.length ?? 0;
    const settings = src.match(/settings: CLAUDE_SETTINGS/g)?.length ?? 0;
    assert.equal(settings, calls, `${f}: ${calls} query() y ${settings} con CLAUDE_SETTINGS`);
  }
});
