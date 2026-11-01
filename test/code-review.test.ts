import assert from "node:assert/strict";
import { test } from "node:test";
import { majorOf, parseFindings, reviewComment, reviewFixPrompt, reviewLevel, reviewPrompt } from "../src/code-review.js";

test("reviewLevel: solo low/medium/high activan el review", () => {
  assert.equal(reviewLevel("medium"), "medium");
  assert.equal(reviewLevel("off"), null);
  assert.equal(reviewLevel(undefined), null);
  assert.equal(reviewLevel("max"), null);
});

test("reviewPrompt: /code-review con el nivel y la rama, contra la base", () => {
  const p = reviewPrompt("high", "backcode/ana/abc", "origin/main");
  assert.ok(p.startsWith("/code-review high backcode/ana/abc"));
  assert.match(p, /git diff origin\/main\.\.\.HEAD/);
});

test("parseFindings: el último bloque JSON, normalizado", () => {
  const text = 'Revisado.\n```json\n{"findings":[{"severity":"major","file":"src/a.ts","line":"12","summary":"Falta  validar\\n la entrada"},{"severity":"rara","summary":"x"},{"severity":"minor","summary":""}]}\n```';
  assert.deepEqual(parseFindings(text), [
    { severity: "major", file: "src/a.ts", line: 12, summary: "Falta validar la entrada" },
    { severity: "major", summary: "x" },
  ]);
  assert.deepEqual(parseFindings('```json\n{"findings":[]}\n```'), []);
});

test("parseFindings: sin JSON usa ReportFindings; sin nada, null", () => {
  const reported = [
    { file: "a.ts", line: 3, summary: "Bug", category: "correctness" },
    { file: "b.ts", summary: "Simplificar", category: "simplification" },
  ];
  assert.deepEqual(majorOf(parseFindings("hecho", reported)!).map((f) => f.file), ["a.ts"]);
  assert.equal(parseFindings("sin bloque"), null);
  assert.equal(parseFindings("```json\nno es json\n```"), null);
});

test("reviewFixPrompt y reviewComment: listan los hallazgos", () => {
  const findings = [
    { severity: "major" as const, file: "a.ts", line: 3, summary: "Bug" },
    { severity: "minor" as const, summary: "Nombre" },
  ];
  assert.match(reviewFixPrompt(findings), /- \[major\] `a\.ts:3` Bug/);
  assert.match(reviewFixPrompt(findings), /Don't call open_pull_request/);
  const labels = { title: "T", approved: "OK", blocking: "BLOQUEA", minor: "MENORES" };
  const blocked = reviewComment({ state: "findings", level: "low", passes: 2, findings, costUsd: 0 }, labels);
  assert.match(blocked, /^### T \(\/code-review low\)\nBLOQUEA/);
  assert.match(blocked, /MENORES\n\n- \[minor\] Nombre/);
  assert.match(reviewComment({ state: "approved", level: "low", passes: 1, findings: [findings[1]], costUsd: 0 }, labels), /\nOK\n/);
});
