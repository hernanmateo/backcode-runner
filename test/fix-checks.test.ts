import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_APP_CODE_MARKER, ciAppCodeResult, fixChecksPrompt, fixChecksScope, parseCiAppCode } from "../src/fix-checks.js";
import { protectedMatcher } from "../src/guard.js";

const base = protectedMatcher([]);

test("fixChecks en una tarea normal: guard de siempre, con Bash y sin tocar la CI", () => {
  const s = fixChecksScope(undefined, "github", base);
  assert.equal(s.ciHost, undefined);
  assert.equal(s.isProtected, base);
  assert.equal(s.denyRead, undefined);
  assert.ok(s.allowedTools.includes("Bash"));
  assert.equal(s.isProtected(".github/workflows/ci.yml"), true);
  assert.equal(s.isProtected("src/index.ts"), false);
  const prompt = fixChecksPrompt(["test: fail"], "boom", "English");
  assert.match(prompt, /which you can read but not change/);
});

test("fixChecks en un PR de CI (GitHub): solo los workflows y docs, sin Bash ni leer secretos", () => {
  const s = fixChecksScope("ci", "github", base);
  assert.equal(s.ciHost, "github");
  assert.ok(!s.allowedTools.includes("Bash"));
  assert.ok(s.disallowedTools.includes("Bash"));
  assert.equal(s.isProtected(".github/workflows/ci.yml"), false);
  assert.equal(s.isProtected("README.md"), false);
  assert.equal(s.isProtected("src/index.ts"), true);
  assert.equal(s.isProtected("package.json"), true);
  assert.equal(s.isProtected(".github/actions/setup/action.yml"), true);
  assert.equal(s.isProtected("CLAUDE.md"), true);
  assert.equal(s.denyRead?.(".env"), true);
  assert.equal(s.denyRead?.("src/index.ts"), false);
});

test("fixChecks en un PR de CI (Bitbucket): solo bitbucket-pipelines.yml y docs", () => {
  const s = fixChecksScope("ci", "bitbucket", base);
  assert.equal(s.isProtected("bitbucket-pipelines.yml"), false);
  assert.equal(s.isProtected(".github/workflows/ci.yml"), true);
});

test("el prompt del PR de CI permite arreglar el workflow pero nunca debilitar checks", () => {
  const prompt = fixChecksPrompt(["build: fail"], "npm ERR!", "Català", "github");
  assert.match(prompt, /\.github\/workflows\/\*\.yml/);
  assert.match(prompt, /Never remove, skip, disable or weaken a check/);
  assert.match(prompt, /continue-on-error/);
  assert.match(prompt, /merges it by hand/);
  assert.match(prompt, /npm ERR!/);
  assert.match(prompt, /in Català/);
  assert.doesNotMatch(prompt, /read but not change/);
  assert.match(fixChecksPrompt(["build: fail"], "", "English", "bitbucket"), /`bitbucket-pipelines\.yml`/);
});

test("el prompt del PR de CI pide la línea marcador cuando falla el código de la app", () => {
  const prompt = fixChecksPrompt(["test: fail"], "", "English", "github");
  assert.ok(prompt.includes(CI_APP_CODE_MARKER));
  assert.ok(!fixChecksPrompt(["test: fail"], "", "English").includes(CI_APP_CODE_MARKER));
});

test("parseCiAppCode detecta la línea marcador (también con formato) y la quita de la explicación", () => {
  assert.deepEqual(parseCiAppCode(`El typecheck falla en src/a.ts.\n${CI_APP_CODE_MARKER}`), { appCode: true, explanation: "El typecheck falla en src/a.ts." });
  assert.equal(parseCiAppCode(`Explicació\n\n\`${CI_APP_CODE_MARKER}\``).appCode, true);
  assert.equal(parseCiAppCode(`**${CI_APP_CODE_MARKER}.**`).appCode, true);
  assert.equal(parseCiAppCode("He arreglado el comando de instalación del workflow.").appCode, false);
  assert.equal(parseCiAppCode(`No escribo ${CI_APP_CODE_MARKER} a mitad de frase`).appCode, false);
  assert.equal(parseCiAppCode("").appCode, false);
});

test("ciAppCodeResult: motivo propio con los checks en rojo y la explicación", () => {
  const r = ciAppCodeResult("https://github.com/o/r/pull/1", ["lint: fail", "test: fail"], "ESLint falla en src/a.ts");
  assert.equal(r.blocked, "ciAppCode");
  assert.deepEqual(r.checks, ["lint: fail", "test: fail"]);
  assert.equal(r.log, "ESLint falla en src/a.ts");
  assert.equal(r.url, "https://github.com/o/r/pull/1");
  assert.ok(r.error);
  assert.equal("log" in ciAppCodeResult("https://x", [], ""), false);
});
