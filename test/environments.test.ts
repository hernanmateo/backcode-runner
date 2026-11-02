import assert from "node:assert/strict";
import { test } from "node:test";
import { branchForChannel, branchForTarget, isPromotionPr, previewBranch, promotionPr, protectedBranch, setPreviewBranch, syncMode, taskBase, validPreviewBranch } from "../src/environments.js";
import { bitbucketMergeBody, ghMergeArgs } from "../src/hosts.js";

test("sin rama de preview todo va a la rama base, como siempre", () => {
  setPreviewBranch(undefined);
  assert.equal(previewBranch(), undefined);
  assert.equal(taskBase("main"), "main");
  assert.equal(branchForChannel("main", "preview"), "main");
  assert.equal(branchForChannel("main", "production"), "main");
  assert.equal(branchForTarget("main", "web#deploy:staging", ["web#deploy:staging", "web#deploy"]), "main");
  assert.equal(isPromotionPr({ branch: "develop", base: "main" }, "main"), false);
  assert.equal(protectedBranch("develop", "main"), false);
  assert.equal(protectedBranch("main", "main"), true);
});

test("con rama de preview: tareas y preview salen de ella; production y lo que no se sabe, de la base", () => {
  setPreviewBranch("develop");
  try {
    assert.equal(taskBase("main"), "develop");
    assert.equal(branchForChannel("main", "preview"), "develop");
    assert.equal(branchForChannel("main", "production"), "main");
    const ids = ["web#deploy:staging", "web#deploy", "functions#deploy"];
    assert.equal(branchForTarget("main", "web#deploy:staging", ids), "develop");
    assert.equal(branchForTarget("main", "web#deploy", ids), "main");
    assert.equal(branchForTarget("main", "functions#deploy", ids), "main");
    assert.equal(branchForTarget("main", "api#deploy:prod", ids), "main");
    assert.equal(isPromotionPr({ branch: "develop", base: "main" }, "main"), true);
    assert.equal(isPromotionPr({ branch: "feature/x", base: "main" }, "main"), false);
    assert.equal(protectedBranch("develop", "main"), true);
    assert.equal(protectedBranch("feature/x", "main"), false);
  } finally {
    setPreviewBranch(undefined);
  }
});

test("rama de preview válida: ni la principal ni una de tarea ni nombres raros", () => {
  for (const ok of ["develop", "staging", "release/next", "pre.v2"]) assert.equal(validPreviewBranch(ok, "main"), true, ok);
  for (const bad of ["main", "master", "trunk", "backcode/u/x", "-x", "a..b", "con espacio", "", 3, undefined]) assert.equal(validPreviewBranch(bad, "trunk"), false, String(bad));
});

test("PR de promoción: título con el número de cambios y la lista de tareas", () => {
  const { title, body } = promotionPr([{ id: "f1", title: "Login con Apple" }, { id: "f2", title: "Arreglar\nscroll" }], 5, "develop", "main", "pie");
  assert.match(title, /develop → main \(2 cambios\)/);
  assert.match(body, /- Login con Apple \(`f1`\)/);
  assert.match(body, /- Arreglar scroll \(`f2`\)/);
  assert.match(body, /5 commits/);
  assert.match(body, /merge commit/);
  assert.ok(body.endsWith("pie"));
  const solo = promotionPr([], 1, "develop", "main", "");
  assert.match(solo.title, /\(1 cambio\)/);
  assert.match(solo.body, /ninguna tarea/);
});

test("sincronizar: al día, fast-forward o merge", () => {
  assert.equal(syncMode(0, 3), "uptodate");
  assert.equal(syncMode(1, 0), "fast-forward");
  assert.equal(syncMode(2, 4), "merge");
});

test("merge: squash y borrar la rama por defecto; la promoción con merge commit y sin borrar", () => {
  const url = "https://github.com/o/r/pull/1";
  assert.deepEqual(ghMergeArgs(url), ["pr", "merge", url, "--squash", "--delete-branch"]);
  assert.deepEqual(ghMergeArgs(url, { method: "merge", deleteBranch: false }), ["pr", "merge", url, "--merge"]);
  assert.deepEqual(bitbucketMergeBody(), { merge_strategy: "squash", close_source_branch: true });
  assert.deepEqual(bitbucketMergeBody({ method: "merge", deleteBranch: false }), { merge_strategy: "merge_commit", close_source_branch: false });
});
