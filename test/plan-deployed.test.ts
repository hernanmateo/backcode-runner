// «Pendiente de desplegar»: un apunte del registro posterior con un commit anterior no tapa el último despliegue de la app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { RunnerConfig } from "../src/config.js";
import type { DeployTarget } from "../src/git.js";
import { computePlan } from "../src/pending.js";
import type { Store } from "../src/store.js";

test("plan: el despliegue recién hecho desde la app cuenta aunque después se apunte un commit anterior", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-plan-"));
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
  const old = commit({ "web/package.json": '{"version":"1.0.0"}', "web/a.ts": "1" }, "old");
  const head = commit({ "web/a.ts": "2", "web/b.ts": "3" }, "new");
  const cfg = { repoPath: repo, remote: "origin", baseBranch: "main" } as RunnerConfig;
  const target = { id: "web#web", name: "web", dir: "web", pm: "npm" } as unknown as DeployTarget;
  const store = (v: { sha: string; at: number; action?: { sha: string; at: number } }) =>
    ({ lastDeploysTimed: async () => new Map([["deploy:web#web", v]]), mergedFeatures: async () => [] }) as unknown as Store;

  // El apunte (commit viejo, apuntado después) no gana al despliegue de la app (commit nuevo): al día.
  const fixed = await computePlan(cfg, store({ sha: old, at: 2, action: { sha: head, at: 1 } }), [target], null, head);
  assert.equal(fixed.steps[0].status, "upToDate");
  assert.equal(fixed.steps[0].lastSha, head);

  // Sin despliegue de la app más nuevo: el apunte manda y quedan archivos pendientes.
  const pending = await computePlan(cfg, store({ sha: old, at: 2 }), [target], null, head);
  assert.equal(pending.steps[0].status, "pending");
  assert.equal(pending.steps[0].changes, 2);

  // Un despliegue de la app a un commit anterior (p. ej. un rollback) que el apunte supera: manda el apunte.
  const rollback = await computePlan(cfg, store({ sha: head, at: 2, action: { sha: old, at: 1 } }), [target], null, head);
  assert.equal(rollback.steps[0].status, "upToDate");
});
