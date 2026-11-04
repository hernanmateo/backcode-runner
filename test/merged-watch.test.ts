import assert from "node:assert/strict";
import { test } from "node:test";
import { findMergedOutside, prKey } from "../src/merged-watch.js";

test("prKey: la misma PR de GitHub o Bitbucket aunque cambie la forma de la URL", () => {
  assert.equal(prKey("https://github.com/Me/App/pull/358/files"), prKey("https://github.com/me/app/pull/358"));
  assert.equal(prKey("https://bitbucket.org/ws/repo/pull-requests/7/"), "bitbucket.org/ws/repo/7");
  assert.notEqual(prKey("https://github.com/me/app/pull/35"), prKey("https://github.com/me/app/pull/358"));
});

test("findMergedOutside: solo mis tareas con PR que aparecen como mergeados, con su commit", () => {
  const open = [
    { id: "a", prUrl: "https://github.com/me/app/pull/358" },
    { id: "b", prUrl: "https://github.com/me/app/pull/359" },
    { id: "c" },
    { id: "d", prUrl: "push-only" },
  ];
  const merged = [{ url: "https://github.com/me/app/pull/358", sha: "083d864" }, { url: "https://github.com/me/app/pull/300" }];
  assert.deepEqual(findMergedOutside(open, merged), [{ id: "a", prUrl: "https://github.com/me/app/pull/358", sha: "083d864" }]);
  assert.deepEqual(findMergedOutside(open, []), []);
});
