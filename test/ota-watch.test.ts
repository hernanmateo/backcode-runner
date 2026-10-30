import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lastCliPublish, markCliPublished } from "../src/ota-watch.js";
import type { Store } from "../src/store.js";

test("OTA desde la terminal: lee el commit por canal y marca desplegadas solo las tareas que entraron", async () => {
  const repo = mkdtempSync(join(tmpdir(), "bc-ota-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "a");
  const a = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "b");
  const b = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "c");
  const c = git("rev-parse", "HEAD");

  mkdirSync(join(repo, "app", ".expo"), { recursive: true });
  writeFileSync(join(repo, "app", ".expo", "eoas-last-publish-main"), `${b}\n`);
  writeFileSync(join(repo, "app", ".expo", "eoas-last-publish-dev"), `${a}\n`);
  writeFileSync(join(repo, "app", ".expo", "eoas-last-publish-rara"), `${c}\n`);
  writeFileSync(join(repo, "app", ".expo", "eoas-last-publish-staging"), "no-es-un-commit");
  const published = lastCliPublish(repo, "app", "main");
  assert.deepEqual(published, { production: b, preview: a });

  const marked: string[] = [];
  const store = {
    mergedNotDeployed: async (channel: string) => (channel === "production" ? [{ id: "t1", sha: a }, { id: "t2", sha: b }, { id: "t3", sha: c }, { id: "manual", sha: "" }] : []),
    markDeployed: async (id: string, channel: string, sha: string) => void marked.push(`${id}:${channel}:${sha.slice(0, 7)}`),
  } as unknown as Store;
  assert.equal(await markCliPublished(store, repo, published), 2);
  assert.deepEqual(marked, [`t1:production:${b.slice(0, 7)}`, `t2:production:${b.slice(0, 7)}`]);
  assert.deepEqual(lastCliPublish(join(repo, "nada"), "app", "main"), {});
});
