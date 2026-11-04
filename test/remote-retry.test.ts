import assert from "node:assert/strict";
import { test } from "node:test";
import { explainRemoteError, githubIncidents, isTransientRemoteError, withRemoteRetry } from "../src/remote-retry.js";
import { isTransientGhError, mergeWithRetry } from "../src/hosts.js";

const noSleep = async () => undefined;

test("errores pasajeros de hoy: push con 500, commit_refs, merge en curso y 502 de la API", () => {
  for (const msg of [
    "remote: Internal Server Error\n ! [remote rejected] backcode/x -> backcode/x (Internal Server Error)",
    "remote: fatal error in commit_refs\n ! [remote rejected] v1.5.1 -> v1.5.1 (failure)",
    "GraphQL: Merge already in progress (mergePullRequest)",
    "GraphQL: Pull Request is still a draft (mergePullRequest)",
    'API call failed: non-200 OK status code: 502 Bad Gateway body: "<html>"',
  ]) {
    assert.equal(isTransientRemoteError(new Error(msg)), true, msg);
    assert.equal(isTransientGhError({ stderr: msg }), true, msg);
  }
  for (const msg of ["! [rejected] main -> main (non-fast-forward)", "GraphQL: Pull Request is not mergeable", "fatal: Authentication failed"]) {
    assert.equal(isTransientRemoteError(new Error(msg)), false, msg);
  }
});

test("withRemoteRetry: reintenta lo pasajero, no lo demás, y se rinde tras los intentos", async () => {
  let n = 0;
  assert.equal(await withRemoteRetry(async () => (++n < 3 ? Promise.reject(new Error("502 Bad Gateway")) : "ok"), { sleep: noSleep }), "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRemoteRetry(async () => (n++, Promise.reject(new Error("non-fast-forward"))), { sleep: noSleep }));
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(withRemoteRetry(async () => (n++, Promise.reject(new Error("Internal Server Error"))), { sleep: noSleep, delaysMs: [1, 1] }));
  assert.equal(n, 3);
});

test("withRemoteRetry: si la operación sí se hizo pese al error, se da por buena", async () => {
  let n = 0;
  const out = await withRemoteRetry(async () => (n++, Promise.reject(new Error("Merge already in progress"))), { sleep: noSleep, done: async () => "hecho" });
  assert.equal(out, "hecho");
  assert.equal(n, 1);
});

test("mergeWithRetry: «Merge already in progress» se reintenta y vale si el PR ya consta como mergeado", async () => {
  let merges = 0;
  let states = 0;
  await mergeWithRetry(
    async () => {
      merges++;
      throw new Error("GraphQL: Merge already in progress (mergePullRequest)");
    },
    async () => (++states >= 2 ? "MERGED" : "OPEN"),
    [1, 1, 1],
  );
  assert.equal(merges, 2);
});

const fakeFetch = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test("githubIncidents y explainRemoteError: nombran la incidencia abierta de GitHub", async () => {
  const f = fakeFetch({ incidents: [{ name: "Incident with Pull Requests, Git Operations and Issues" }] });
  assert.deepEqual(await githubIncidents(f), ["Incident with Pull Requests, Git Operations and Issues"]);
  assert.deepEqual(await githubIncidents((async () => { throw new Error("offline"); }) as unknown as typeof fetch), []);
  const texts = { transient: "PASAJERO", incident: (n: string) => `INCIDENCIA: ${n}` };
  assert.match(await explainRemoteError("gh: 502 Bad Gateway", texts, f), /^INCIDENCIA: Incident with Pull Requests/);
  assert.match(await explainRemoteError("gh: 502 Bad Gateway", texts, fakeFetch({ incidents: [] })), /^PASAJERO\n\ngh: 502/);
  assert.equal(await explainRemoteError("GraphQL: Pull Request is not mergeable", texts, f), "GraphQL: Pull Request is not mergeable");
});
