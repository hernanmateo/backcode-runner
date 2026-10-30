import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rulesPublished } from "../src/rules-check.js";
import type { DeployTarget } from "../src/git.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

test("reglas publicadas: coinciden, no coinciden o no se puede saber (índices cambiados, sin token)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "bc-rules-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "firebase.json"), JSON.stringify({ firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" }, storage: { rules: "storage.rules" } }));
  writeFileSync(join(repo, ".firebaserc"), JSON.stringify({ projects: { default: "demo-app" } }));
  writeFileSync(join(repo, "firestore.rules"), "rules A\n");
  writeFileSync(join(repo, "firestore.indexes.json"), "{}");
  writeFileSync(join(repo, "storage.rules"), "storage A\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const first = git(repo, "rev-parse", "HEAD");

  const published: Record<string, string> = { "cloud.firestore": "rules A", "firebase.storage/demo-app.appspot.com": "storage A\r\n" };
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, headers: init?.headers ?? {} });
    const path = url.replace("https://firebaserules.googleapis.com/v1/", "");
    const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
    if (path.startsWith("projects/demo-app/releases?")) return json({ releases: Object.keys(published).map((r) => ({ name: `projects/demo-app/releases/${r}` })) });
    const release = /^projects\/demo-app\/releases\/(.+)$/.exec(path)?.[1];
    if (release) return json({ rulesetName: `projects/demo-app/rulesets/${release.replace(/\W/g, "")}` });
    const rs = Object.keys(published).find((r) => path === `projects/demo-app/rulesets/${r.replace(/\W/g, "")}`);
    return rs ? json({ source: { files: [{ name: "x.rules", content: published[rs] }] } }) : ({ ok: false, json: async () => ({}) } as Response);
  }) as typeof fetch;

  const target: DeployTarget = { id: "#firebase-rules", name: "firebase-rules", dir: "", pm: "npm", provider: "firebase", source: "detected", auto: { cmd: ["npx", "firebase-tools", "deploy", "--only", "firestore,storage"], rank: 0, paths: ["firestore.rules", "firestore.indexes.json", "storage.rules"], install: true } };
  const token = async () => "tok-123";
  assert.equal(await rulesPublished({ repoPath: repo, base: first, target, lastSha: first, token }), true);
  assert.ok(seen.every((s) => s.headers.authorization === "Bearer tok-123" && s.headers["x-goog-user-project"] === "demo-app" && !s.url.includes("tok-123")));

  // Reglas nuevas en la rama principal que no se han publicado: no.
  writeFileSync(join(repo, "storage.rules"), "storage B\n");
  git(repo, "commit", "-qam", "storage B");
  const second = git(repo, "rev-parse", "HEAD");
  assert.equal(await rulesPublished({ repoPath: repo, base: second, target, lastSha: first, token }), false);
  published["firebase.storage/demo-app.appspot.com"] = "storage B";
  assert.equal(await rulesPublished({ repoPath: repo, base: second, target, lastSha: first, token }), true);

  // Los índices no se pueden comprobar: si han cambiado desde el último despliegue (o no hay ninguno), no se sabe.
  writeFileSync(join(repo, "firestore.indexes.json"), '{"indexes":[]}');
  git(repo, "commit", "-qam", "índices");
  const third = git(repo, "rev-parse", "HEAD");
  assert.equal(await rulesPublished({ repoPath: repo, base: third, target, lastSha: second, token }), null);
  assert.equal(await rulesPublished({ repoPath: repo, base: second, target, token }), null);
  // Solo Storage: no le afectan los índices.
  const storageOnly: DeployTarget = { ...target, auto: { ...target.auto!, cmd: ["npx", "firebase-tools", "deploy", "--only", "storage"] } };
  assert.equal(await rulesPublished({ repoPath: repo, base: third, target: storageOnly, token }), true);

  // Sin token (sin gcloud) o un destino que no es de reglas: ni se pregunta.
  const calls = seen.length;
  assert.equal(await rulesPublished({ repoPath: repo, base: second, target, lastSha: first, token: async () => null }), null);
  assert.equal(await rulesPublished({ repoPath: repo, base: second, target: { ...target, name: "firebase-functions", auto: { ...target.auto!, cmd: ["npx", "firebase-tools", "deploy", "--only", "functions"] } }, token }), null);
  assert.equal(seen.length, calls);
});
