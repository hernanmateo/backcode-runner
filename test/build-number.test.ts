import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNumberHint } from "../src/actions.js";

test("buildNumberHint: App Store Connect rechaza un build number repetido", () => {
  const es = "The provided entity includes an attribute with a value that has already been used (-19232)\nLa versión del paquete debe ser posterior a la versión cargada anteriormente: “14”.";
  assert.match(buildNumberHint("ios", es, "app"), /eas build:version:set -p ios.*app/);
  assert.match(buildNumberHint("ios", "The bundle version must be higher than the previously uploaded version: ‘14’.", "."), /-p ios/);
});

test("buildNumberHint: Google Play rechaza un versionCode repetido", () => {
  assert.match(buildNumberHint("android", "Google Api Error: Invalid request - Version code 5 has already been used.", "app"), /eas build:version:set -p android/);
});

test("buildNumberHint: sin aviso para otros fallos o la otra plataforma", () => {
  assert.equal(buildNumberHint("ios", "File ./fastlane/AuthKey.p8 doesn't exist.", "app"), "");
  assert.equal(buildNumberHint("android", "(-19232) already been used", "app"), "");
});
