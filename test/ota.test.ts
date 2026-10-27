import assert from "node:assert/strict";
import { test } from "node:test";
import { otaScriptArgs } from "../src/ota.js";

test("script sin rama: el runner pasa prod (production) o preview una sola vez", () => {
  assert.deepEqual(otaScriptArgs("./scripts/ota-publish.sh", "npm", "production", "hola"), {
    args: ["run", "ota:publish", "--", "prod", "--yes", "-m", "hola"],
  });
  assert.deepEqual(otaScriptArgs("./scripts/ota-publish.sh", "bun", "preview", "hola"), {
    args: ["run", "ota:publish", "preview", "--yes", "-m", "hola"],
  });
});

test("script con la rama ya fijada: no se duplica (prod prod)", () => {
  const r = otaScriptArgs("bash scripts/publish-update.sh prod", "bun", "production", "Backcode");
  assert.deepEqual(r, { args: ["run", "ota:publish", "--yes", "-m", "Backcode"] });
  assert.deepEqual(otaScriptArgs("bash scripts/publish-update.sh production", "bun", "production", "x"), {
    args: ["run", "ota:publish", "--yes", "-m", "x"],
  });
});

test("script con otra rama fijada: no se publica en el canal equivocado", () => {
  assert.deepEqual(otaScriptArgs("bash scripts/publish-update.sh prod", "bun", "preview", "x"), { error: "fixedBranch", fixed: "prod" });
});

test("los valores de flags no cuentan como rama", () => {
  assert.deepEqual(otaScriptArgs("./scripts/ota-publish.sh --env production", "npm", "preview", "x"), {
    args: ["run", "ota:publish", "--", "preview", "--yes", "-m", "x"],
  });
});

test("el mensaje se recorta a 200 caracteres", () => {
  const r = otaScriptArgs("./scripts/ota-publish.sh", "pnpm", "production", "a".repeat(300));
  assert.ok("args" in r && r.args.at(-1)?.length === 200);
});
