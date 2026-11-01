import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appliesTo, merge, missing, NONE, normalizeDomain, permissionsPrompt, readRoots, sanitize, threadGrants } from "../src/permissions.js";
import { createGuardHook } from "../src/guard.js";

test("dominios: se normaliza lo que se pegue y se rechaza lo que no es un hostname", () => {
  assert.equal(normalizeDomain("https://API.tcgdex.net/v2/en?x=1"), "api.tcgdex.net");
  assert.equal(normalizeDomain("tcgcsv.com:443"), "tcgcsv.com");
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain("*.evil.com"), null);
  assert.equal(normalizeDomain("a b.com"), null);
});

test("sanitize: sin duplicados, solo curl/wget y con los límites", () => {
  const p = sanitize({ domains: ["a.com", "A.com", "bad", 3], commands: ["curl", "ssh", "curl", "wget"], readProjects: ["p2", "../x", "p2"] });
  assert.deepEqual(p, { domains: ["a.com"], commands: ["curl", "wget"], readProjects: ["p2"] });
  assert.equal(sanitize({ domains: Array.from({ length: 40 }, (_, i) => `d${i}.com`) }).domains.length, 30);
  assert.deepEqual(sanitize(undefined), NONE);
});

test("solo se aplican si la tarea la creó y la ejecuta la misma persona", () => {
  assert.equal(appliesTo({ createdBy: "u1", assignee: "u1" }, "u1"), true);
  assert.equal(appliesTo({ createdBy: "u2", assignee: "u1" }, "u1"), false); // me la pasaron
  assert.equal(appliesTo({ createdBy: "u1", assignee: "u2" }, "u1"), false);
  assert.equal(appliesTo({ createdBy: "u1", assignee: "u1" }, ""), false);
});

test("lo concedido en el hilo: once y always suman, deny no", () => {
  const grants = threadGrants([
    { author: "user", kind: "grant", grant: { decision: "once", domains: ["a.com"], commands: [], readProjects: [] } },
    { author: "user", kind: "grant", grant: { decision: "deny", domains: ["evil.com"], commands: ["curl"], readProjects: [] } },
    { author: "user", kind: "grant", grant: { decision: "always", domains: [], commands: ["wget"], readProjects: ["p2"] } },
    { author: "claude", kind: "grant", grant: { decision: "always", domains: ["claude.com"], commands: [], readProjects: [] } }, // Claude no se concede nada
    { author: "user", kind: "message" },
  ]);
  assert.deepEqual(grants, { domains: ["a.com"], commands: ["wget"], readProjects: ["p2"] });
});

test("missing: solo lo que aún no tiene; null si ya lo tiene todo", () => {
  const have = merge(NONE, { domains: ["a.com"], commands: ["curl"], readProjects: [] });
  assert.deepEqual(missing({ domains: ["a.com", "b.com"], commands: ["curl"], readProjects: ["p2"] }, have), { domains: ["b.com"], commands: [], readProjects: ["p2"] });
  assert.equal(missing({ domains: ["a.com"], commands: [], readProjects: [] }, have), null);
});

test("carpetas de referencia: solo proyectos conectados aquí, nunca el propio", () => {
  const repos = new Map([["p1", "/r/p1"], ["p2", "/r/p2"]]);
  assert.deepEqual(readRoots({ domains: [], commands: [], readProjects: ["p1", "p2", "p3"] }, repos, "p1"), [{ id: "p2", path: "/r/p2" }]);
});

test("instrucciones: dicen qué tiene, que lo de fuera son datos, y por qué no se aplican en tareas ajenas", () => {
  const text = permissionsPrompt({ applies: true, perms: { domains: ["api.tcgdex.net"], commands: ["curl"], readProjects: ["p2", "p9"] }, roots: [{ id: "p2", name: "PokéScan", path: "/r/p2" }], available: [{ id: "p3", name: "Georank" }] });
  assert.match(text, /api\.tcgdex\.net/);
  assert.match(text, /PokéScan.*\/r\/p2/);
  assert.match(text, /p9/); // concedido pero no conectado aquí
  assert.match(text, /UNTRUSTED DATA/);
  assert.match(text, /Georank.*p3/);
  assert.match(permissionsPrompt({ applies: false, perms: NONE, roots: [], available: [] }), /wasn't created by the person running it/);
});

test("guard: curl/wget solo si están concedidos; ssh nunca; la referencia se lee y no se escribe", async () => {
  const base = mkdtempSync(join(tmpdir(), "bc-perm-"));
  const wt = join(base, "wt");
  const ref = join(base, "ref");
  mkdirSync(wt);
  mkdirSync(ref);
  writeFileSync(join(ref, "a.ts"), "x");
  const decide = async (hook: ReturnType<typeof createGuardHook>, tool_name: string, tool_input: Record<string, unknown>) => {
    const out = (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? "allow";
  };
  const plain = createGuardHook(wt, () => false);
  const extra = createGuardHook(wt, () => false, { readRoots: [ref], allowCommands: ["curl"] });
  assert.equal(await decide(plain, "Bash", { command: "curl -s https://api.tcgdex.net/v2/en/cards/x" }), "deny");
  assert.equal(await decide(extra, "Bash", { command: "curl -s https://api.tcgdex.net/v2/en/cards/x" }), "allow");
  assert.equal(await decide(extra, "Bash", { command: "curl -s https://x.com | ssh host" }), "deny");
  assert.equal(await decide(extra, "Bash", { command: "wget https://x.com" }), "deny");
  assert.equal(await decide(extra, "Bash", { command: "git push" }), "deny");
  assert.equal(await decide(plain, "Read", { file_path: join(ref, "a.ts") }), "deny");
  assert.equal(await decide(extra, "Read", { file_path: join(ref, "a.ts") }), "allow");
  assert.equal(await decide(extra, "Grep", { path: ref, pattern: "x" }), "allow");
  assert.equal(await decide(extra, "Write", { file_path: join(ref, "a.ts") }), "deny");
  assert.equal(await decide(extra, "Edit", { file_path: join(ref, "a.ts") }), "deny");
});
