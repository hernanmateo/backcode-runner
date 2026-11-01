import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { homePath, parseLinkRequest, validBranch } from "../src/machines.js";

test("ramas: válidas y las que git rechazaría", () => {
  for (const b of ["main", "develop", "release/1.2", "feature_x-1"]) assert.ok(validBranch(b), b);
  for (const b of ["", "-x", "a..b", "a//b", "a/", "x.lock", "x.", "con espacio", "a\nb", "/main", 3]) assert.ok(!validBranch(b), String(b));
});

test("rutas de la app: solo dentro de $HOME, sin ocultas ni ~/.backcode", () => {
  assert.equal(homePath("~/Projects/repo"), join(homedir(), "Projects/repo"));
  assert.equal(homePath("Projects/repo/"), join(homedir(), "Projects/repo"));
  assert.equal(homePath(join(homedir(), "code", "x")), join(homedir(), "code", "x"));
  for (const p of ["/etc", "~/.ssh/x", "~/../otro", "~/.backcode/config", "~/a\nb", "", "~", 7]) assert.equal(homePath(p), null, String(p));
});

test("petición de conectar: valida cada campo y nunca acepta una URL", () => {
  const ok = parseLinkRequest({ projectId: "p1", baseBranch: "main", pullRequest: "github", repoUrl: "https://evil.example/x" });
  assert.deepEqual(ok, { projectId: "p1", baseBranch: "main", pullRequest: "github" });
  assert.ok("error" in parseLinkRequest({ projectId: "../x", baseBranch: "main", pullRequest: "github" }));
  assert.ok("error" in parseLinkRequest({ projectId: "p1", baseBranch: "a..b", pullRequest: "github" }));
  assert.ok("error" in parseLinkRequest({ projectId: "p1", baseBranch: "main", pullRequest: "gitlab" }));
  assert.ok("error" in parseLinkRequest({ projectId: "p1", baseBranch: "main", pullRequest: "github", repoPath: "/etc" }));
  assert.ok("error" in parseLinkRequest({ projectId: "p1", baseBranch: "main", pullRequest: "github", repoPath: "~/a", clonePath: "~/b" }));
  const clone = parseLinkRequest({ projectId: "p1", baseBranch: "main", pullRequest: "push-only", clonePath: "~/Projects/repo" });
  assert.deepEqual(clone, { projectId: "p1", baseBranch: "main", pullRequest: "push-only", clonePath: join(homedir(), "Projects/repo") });
});
