import assert from "node:assert/strict";
import { test } from "node:test";
import { newer } from "../src/autoupdate.js";
import { parseConfig } from "../src/setup.js";

const APP_CONFIG = `# Backcode runner · proyecto "Mi App"
# Generado desde la app. Contiene tu runner key: no lo compartas.
BACKCODE_PROJECT_ID=abc123
BACKCODE_REPO_PATH=~/Projects/mi-app
BACKCODE_DESDE_EL_FUTURO=1
# fin
BACKCODE_MODEL=ignorado-tras-la-marca`;

test("configuración de la app: nombre del proyecto, variables conocidas y desconocidas, se para en # fin", () => {
  const r = parseConfig(APP_CONFIG);
  assert.ok(!("error" in r));
  assert.equal(r.values.get("BACKCODE_PROJECT_NAME"), "Mi App");
  assert.equal(r.values.get("BACKCODE_PROJECT_ID"), "abc123");
  assert.equal(r.values.get("BACKCODE_REPO_PATH"), "~/Projects/mi-app");
  assert.equal(r.values.has("BACKCODE_MODEL"), false);
  assert.deepEqual(r.ignored, ["BACKCODE_DESDE_EL_FUTURO"]);
});

test("solo acepta variables BACKCODE_* y exige el proyecto", () => {
  assert.ok("error" in parseConfig("BACKCODE_PROJECT_ID=x\nNODE_OPTIONS=--require /tmp/x.js"));
  assert.ok("error" in parseConfig("PATH=/tmp"));
  assert.ok("error" in parseConfig("BACKCODE_REPO_PATH=/tmp/x"));
});

test("versiones: compara número a número", () => {
  assert.equal(newer("1.10.0", "1.9.3"), true);
  assert.equal(newer("1.0.1", "1.0.0"), true);
  assert.equal(newer("1.0.0", "1.0.0"), false);
  assert.equal(newer("0.9.9", "1.0.0"), false);
});

test("lee .env como process.loadEnvFile: comentarios, comillas y valores vacíos", async () => {
  const { parseEnv } = await import("../src/config.js");
  assert.deepEqual(parseEnv('# hola\nA=1\nB="dos # no es comentario"\nC=tres # sí\nexport D=\'cuatro\'\nE=\n'), [["A", "1"], ["B", "dos # no es comentario"], ["C", "tres"], ["D", "cuatro"], ["E", ""]]);
});
