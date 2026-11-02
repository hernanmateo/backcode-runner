import assert from "node:assert/strict";
import { test } from "node:test";
import { appScheme, nativeFiles, prChannel, prNumberOf, prOtaArgs, prOtaLink } from "../src/pr-ota.js";

test("número del PR: GitHub y Bitbucket; una rama sin PR no vale", () => {
  assert.equal(prNumberOf("https://github.com/o/r/pull/12"), 12);
  assert.equal(prNumberOf("https://github.com/o/r/pull/12/files"), 12);
  assert.equal(prNumberOf("https://bitbucket.org/ws/repo/pull-requests/7"), 7);
  assert.equal(prNumberOf("origin/backcode/ana/f1"), null);
  assert.equal(prNumberOf(undefined), null);
  assert.equal(prNumberOf("https://github.com/o/r/pull/12x"), null);
});

test("canal propio del PR: nunca production ni preview", () => {
  assert.equal(prChannel(12), "pr-12");
  const args = prOtaArgs("pr-12", "PR #12: hola");
  assert.deepEqual(args.slice(args.indexOf("--channel"), args.indexOf("--channel") + 2), ["--channel", "pr-12"]);
  // Variables de preview (mismo runtimeVersion que la build de preview), pero el canal es el del PR.
  assert.deepEqual(args.slice(args.indexOf("--environment"), args.indexOf("--environment") + 2), ["--environment", "preview"]);
  assert.ok(!args.includes("production"));
  assert.throws(() => prOtaArgs("preview", "x"));
  assert.throws(() => prOtaArgs("production", "x"));
  assert.throws(() => prOtaArgs("pr-1; rm -rf /", "x"));
});

test("cambios nativos: la misma detección que «Pendiente de desplegar»", () => {
  assert.deepEqual(nativeFiles(["app/src/a.tsx", "app/app.json", "app/ios/Podfile", "README.md"]), ["app/app.json", "app/ios/Podfile"]);
  assert.deepEqual(nativeFiles(["src/screen.tsx"]), []);
});

test("enlace para abrir la versión del PR y volver a la normal", () => {
  assert.equal(appScheme({ scheme: "myapp" }), "myapp");
  assert.equal(appScheme({ scheme: ["myapp", "other"] }), "myapp");
  assert.equal(appScheme({ scheme: "javascript:alert(1)//" }), undefined);
  assert.equal(appScheme(null), undefined);
  assert.equal(prOtaLink("myapp", "pr-12"), "myapp://?backcode-ota-channel=pr-12");
  assert.equal(prOtaLink("myapp", ""), "myapp://?backcode-ota-channel=");
});
