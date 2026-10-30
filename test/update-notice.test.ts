import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// HOME_DIR se lee al importar: la carpeta de pruebas va antes.
process.env.BACKCODE_HOME = mkdtempSync(join(tmpdir(), "bc-update-home-"));
const { updateReport } = await import("../src/update-notice.ts");
const { PLUGIN_VERSION } = await import("../src/plugin.ts");

test("aviso de versión nueva: runner por detrás y plugin antiguo", () => {
  assert.deepEqual(updateReport("1.0.64", [{ version: "0.0.1" }, { version: PLUGIN_VERSION }], "1.0.63", true), {
    runner: { current: "1.0.63", latest: "1.0.64", auto: true },
    plugin: { installed: "0.0.1", latest: PLUGIN_VERSION },
  });
  assert.deepEqual(updateReport("1.0.64", null, "1.0.63", false), { runner: { current: "1.0.63", latest: "1.0.64", auto: false } });
});

test("aviso de versión nueva: al día, o sin saber la última, no hay nada que avisar", () => {
  assert.equal(updateReport("1.0.63", [{ version: PLUGIN_VERSION }], "1.0.63"), null);
  assert.equal(updateReport(undefined, [], "1.0.63"), null);
  assert.equal(updateReport("1.0.60", null, "1.0.63"), null, "copia por delante de lo publicado");
});
