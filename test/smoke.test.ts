import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildErrors, podsInSync } from "../src/smoke.js";

test("buildErrors: saca las líneas con el motivo real, no solo el final del log", () => {
  const out = [
    "› Installing CocoaPods...",
    "✖ Something went wrong running `pod install` in the `ios` directory.",
    "[!] CDN: trunk URL couldn't be downloaded: https://cdn.cocoapods.org/all_pods_versions_1_2_3.txt",
    ...Array.from({ length: 200 }, (_, i) => `› Compiling file${i}.m`),
    "› Executing Backcode » [CP] Check Pods Manifest.lock",
    "❌  error: The sandbox is not in sync with the Podfile.lock. Run 'pod install' or update your CocoaPods installation.",
    "› 1 error(s), and 0 warning(s)",
    'CommandError: Failed to build iOS project. "xcodebuild" exited with error code 65.',
  ].join("\n");
  const text = buildErrors(out);
  assert.ok(text.includes("Something went wrong running `pod install`"));
  assert.ok(text.includes("[!] CDN: trunk URL"));
  assert.ok(text.includes("sandbox is not in sync"));
  assert.ok(text.includes("exited with error code 65"));
  assert.ok(!text.includes("file100.m"));
});

test("buildErrors: sin líneas de error, el final de la salida; con log, su ruta", () => {
  const text = buildErrors("a\nb\n\x1b[31mc\x1b[0m\n", "/tmp/x.log");
  assert.ok(text.startsWith("a\nb\nc"));
  assert.ok(text.includes("/tmp/x.log"));
  assert.ok(!text.includes("\x1b["));
});

test("podsInSync: solo con Podfile.lock y Pods/Manifest.lock iguales (lo que comprueba Xcode)", () => {
  const ios = mkdtempSync(join(tmpdir(), "smoke-ios-"));
  assert.equal(podsInSync(ios), false);
  writeFileSync(join(ios, "Podfile.lock"), "PODS:\n  - A (1.0)\n");
  assert.equal(podsInSync(ios), false);
  mkdirSync(join(ios, "Pods"));
  writeFileSync(join(ios, "Pods", "Manifest.lock"), "PODS:\n  - A (0.9)\n");
  assert.equal(podsInSync(ios), false);
  writeFileSync(join(ios, "Pods", "Manifest.lock"), "PODS:\n  - A (1.0)\n");
  assert.equal(podsInSync(ios), true);
});
