import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerConfig } from "../src/config.js";
import type { PrHost } from "../src/hosts.js";
import { prNumberOfSubject, prNumberOfUrl, revertBody, revertBranch, revertCheck, revertPrompt, revertPr, revertTitle } from "../src/revert.js";
import type { RevertInfo, RevertState, Store } from "../src/store.js";

test("prNumberOfSubject reconoce los squash y merges de GitHub y Bitbucket", () => {
  assert.equal(prNumberOfSubject("Añade exportar (#12)"), 12);
  assert.equal(prNumberOfSubject("Merge pull request #34 from o/rama"), 34);
  assert.equal(prNumberOfSubject("Merged in rama (pull request #5)"), 5);
  assert.equal(prNumberOfSubject("Arregla #12 en el login"), undefined);
});

test("prNumberOfUrl, rama, título y cuerpo del PR de revert", () => {
  assert.equal(prNumberOfUrl("https://github.com/o/r/pull/9"), 9);
  assert.equal(prNumberOfUrl("https://bitbucket.org/o/r/pull-requests/3"), 3);
  assert.equal(prNumberOfUrl(undefined), undefined);
  assert.equal(revertBranch("f1", false), "backcode/revert/f1");
  assert.equal(revertBranch("f1", true, 36), "backcode/revert/f1-10");
  assert.equal(revertTitle("Exportar CSV"), "Revert: Exportar CSV");
  const body = revertBody({ title: "Exportar CSV", prUrl: "https://github.com/o/r/pull/9", deployed: true }, "a".repeat(40), "Catalan");
  assert.match(body, /Reverteix #9/);
  assert.match(body, /desapareixerà de producció/);
  assert.doesNotMatch(revertBody({ title: "x", deployed: false }, "b".repeat(40), "Catalan"), /producció/);
});

test("revertPrompt pide deshacer solo el commit y conservar lo posterior", () => {
  const p = revertPrompt(["a.ts"], "abc123", "origin/main", "Catalan");
  assert.match(p, /- a\.ts/);
  assert.match(p, /Keep every later change/);
  assert.match(p, /in Catalan/);
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "revert-"));
  const remote = join(dir, "remote.git");
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, repo]);
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  sh(repo, "config", "commit.gpgsign", "false");
  const commit = (file: string, text: string, msg: string) => {
    writeFileSync(join(repo, file), text);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", msg);
    return sh(repo, "rev-parse", "HEAD");
  };
  commit("a.txt", "uno\n", "inicio");
  const sha = commit("b.txt", "feature\n", "Añade b (#7)");
  commit("b.txt", "feature\nposterior\n", "Amplía b (#8)");
  commit("c.txt", "otro\n", "Toca c (#9)");
  sh(repo, "push", "-q", "origin", "main");
  const cfg = { repoPath: repo, worktreesDir: join(dir, "wt"), remote: "origin", baseBranch: "main", model: "sonnet", maxBudgetUsd: 1 } as unknown as RunnerConfig;
  return { dir, remote, repo, sha, cfg };
}

function fakeStore(info: RevertInfo) {
  const writes: Partial<RevertState>[] = [];
  const store = {
    revertInfo: async () => info,
    mergedFeatures: async () => [],
    startRevert: async () => {
      if (info.revert && info.revert.state !== "failed") return false;
      info.revert = { state: "running", by: "u" };
      return true;
    },
    setRevert: async (_id: string, next: Partial<RevertState>) => {
      writes.push(next);
      info.revert = { ...info.revert!, ...next };
    },
    event: async () => undefined,
  } as unknown as Store;
  return { store, writes };
}

test("revertCheck avisa de los PRs posteriores que tocan los mismos ficheros", async () => {
  const { dir, sha, cfg } = setup();
  try {
    const { store } = fakeStore({ title: "Añade b", status: "done", sha, merged: true, deployed: false });
    const out = await revertCheck(cfg, store, {} as PrHost, "f1");
    assert.equal(out.ok, true);
    assert.deepEqual(out.result.later?.map((l) => l.number), [8]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revertPr abre un PR de revert en una rama nueva sin tocar main", async () => {
  const { dir, remote, cfg, repo } = setup();
  try {
    // Un commit independiente para revertir sin conflictos.
    writeFileSync(join(repo, "d.txt"), "d\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "Añade d (#10)");
    const dSha = sh(repo, "rev-parse", "HEAD");
    sh(repo, "push", "-q", "origin", "main");
    const mainBefore = sh(remote, "rev-parse", "main");
    const opened: { branch: string; title: string; base: string }[] = [];
    const host = { openOrUpdatePr: async (o: { branch: string; title: string; base: string }) => (opened.push(o), "https://github.com/o/r/pull/11") } as unknown as PrHost;
    const { store, writes } = fakeStore({ title: "Añade d", status: "done", sha: dSha, merged: true, deployed: false, prUrl: "https://github.com/o/r/pull/10" });
    const out = await revertPr(cfg, store, host, {}, new AbortController().signal, "f1", "a1");
    assert.equal(out.ok, true, String(out.result.error));
    assert.deepEqual(opened, [{ ...opened[0], branch: "backcode/revert/f1", title: "Revert: Añade d", base: "main" }]);
    assert.equal(sh(remote, "rev-parse", "main"), mainBefore);
    assert.equal(sh(remote, "ls-tree", "--name-only", "backcode/revert/f1").split("\n").includes("d.txt"), false);
    assert.equal(writes.at(-1)?.state, "open");
    assert.equal(writes.at(-1)?.prUrl, "https://github.com/o/r/pull/11");
    // Ya hay uno abierto: no se puede crear otro.
    const again = await revertPr(cfg, store, host, {}, new AbortController().signal, "f1", "a2");
    assert.equal(again.ok, false);
    assert.equal(opened.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
