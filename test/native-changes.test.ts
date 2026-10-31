import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { RunnerConfig } from "../src/config.js";
import type { ExpoApp } from "../src/git.js";
import { isNativeDependency, nativeDependencyChanges, nativeFilesByPlatform } from "../src/native-changes.js";
import { computePlan } from "../src/pending.js";
import type { Store } from "../src/store.js";

test("dependencias nativas: Expo, sus módulos y las de React Native; no las de JS puro", () => {
  for (const n of ["expo", "expo-camera", "react-native", "react-native-reanimated", "@react-native-async-storage/async-storage", "@shopify/react-native-skia", "lottie-react-native"]) assert.ok(isNativeDependency(n), n);
  for (const n of ["react", "zod", "firebase", "@expo/vector-icons", "date-fns", "native-base-theme"]) assert.ok(!isNativeDependency(n), n);
});

test("package.json: solo cuentan las dependencias nativas añadidas, quitadas o con otra versión", () => {
  const before = JSON.stringify({ dependencies: { expo: "~55.0.0", "expo-camera": "1.0.0", zod: "4.0.0" }, scripts: { a: "x" } });
  assert.deepEqual(nativeDependencyChanges(before, JSON.stringify({ dependencies: { expo: "~55.0.0", "expo-camera": "1.0.0", zod: "4.1.0" }, scripts: { a: "y" } })), []);
  assert.deepEqual(nativeDependencyChanges(before, JSON.stringify({ dependencies: { expo: "~56.0.0", zod: "4.0.0", "react-native-mmkv": "3.0.0" } })), ["expo", "expo-camera", "react-native-mmkv"]);
  assert.deepEqual(nativeDependencyChanges("", "no json"), []);
});

test("ficheros nativos por plataforma: ios/ y android/ por separado, config y plugins para las dos", () => {
  const files = ["app/ios/Podfile", "app/android/build.gradle", "app/app.json", "app/plugins/with-x.js", "app/src/screen.tsx", "functions/src/index.ts", "app/package.json"];
  assert.deepEqual(nativeFilesByPlatform(files, "app"), {
    ios: ["app/ios/Podfile", "app/app.json", "app/plugins/with-x.js"],
    android: ["app/android/build.gradle", "app/app.json", "app/plugins/with-x.js"],
  });
  assert.deepEqual(nativeFilesByPlatform(["app/package.json"], "app", true), { ios: ["app/package.json"], android: ["app/package.json"] });
});

test("solo JS (o fuera de la app): ninguna build pendiente", () => {
  assert.deepEqual(nativeFilesByPlatform(["app/src/a.tsx", "app/package.json", "landing/app.json", "app/node_modules/x/ios/a.m"], "app"), { ios: [], android: [] });
  // App en la raíz del repo.
  assert.deepEqual(nativeFilesByPlatform(["app.config.ts", "src/a.tsx"], ""), { ios: ["app.config.ts"], android: ["app.config.ts"] });
});

test("plan: build pendiente por plataforma con cambios nativos desde su última build; con solo JS, ninguna", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-build-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("remote", "add", "origin", remote);
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(repo, dirname(f)), { recursive: true });
      writeFileSync(join(repo, f), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    git("push", "-q", "origin", "main");
    return git("rev-parse", "HEAD");
  };
  const built = commit({ "app/app.json": '{"expo":{}}', "app/package.json": JSON.stringify({ dependencies: { expo: "55" } }), "app/src/a.tsx": "1" }, "base");
  const app: ExpoApp = { appDir: "app", channels: [], ota: null, pm: "npm", buildProfiles: ["production"] };
  const cfg = { repoPath: repo, remote: "origin", baseBranch: "main" } as RunnerConfig;
  const store = (last: Record<string, string>) => ({ lastDeploys: async () => new Map(Object.entries(last)), mergedFeatures: async () => [] }) as unknown as Store;
  const both = { "build:ios": built, "build:android": built };

  commit({ "app/src/a.tsx": "2", "app/package.json": JSON.stringify({ dependencies: { expo: "55", zod: "4" } }) }, "solo JS");
  assert.equal((await computePlan(cfg, store(both), [], app)).builds, undefined);

  commit({ "app/ios/Podfile": "x" }, "nativo iOS");
  assert.deepEqual((await computePlan(cfg, store(both), [], app)).builds?.map((b) => [b.platform, b.files]), [["ios", ["app/ios/Podfile"]]]);

  commit({ "app/package.json": JSON.stringify({ dependencies: { expo: "56", zod: "4" } }) }, "SDK nuevo");
  assert.deepEqual((await computePlan(cfg, store(both), [], app)).builds?.map((b) => [b.platform, b.changes]), [["ios", 2], ["android", 1]]);
  // Sin build registrada no se sabe: no sale.
  assert.equal((await computePlan(cfg, store({}), [], app)).builds, undefined);
});
