import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { CHAT_ALLOWED_TOOLS, chatAllowedTools } from "../src/chat.js";
import { createGuardHook } from "../src/guard.js";
import { chatAppliesTo, checkPermissionRequest, loadPermissionContext, NONE, sessionPermissions, threadGrants } from "../src/permissions.js";
import { buildChatSystemAppend } from "../src/prompt.js";

const store = (perms = { domains: ["api.tcgdex.net"], commands: ["curl" as const], readProjects: ["p2"] }) => ({
  permissions: async () => perms,
  projectName: async (id: string) => `Proyecto ${id}`,
});

test("chat: los permisos personales solo se aplican si quien escribe es quien tiene el runner", () => {
  assert.equal(chatAppliesTo({ uid: "me" }, "me"), true);
  assert.equal(chatAppliesTo({ uid: "me", runnerUid: "me" }, "me"), true);
  // Un compañero que usa mi runner compartido: ni mis permisos ni peticiones.
  assert.equal(chatAppliesTo({ uid: "mate", runnerUid: "me" }, "me"), false);
  assert.equal(chatAppliesTo({ uid: "me", runnerUid: "other" }, "me"), false);
  assert.equal(chatAppliesTo({ uid: "" }, ""), false);
});

test("chat: herramientas permitidas según quién escribe y lo concedido", async () => {
  const repos = new Map([["p2", realpathSync(mkdtempSync(join(tmpdir(), "bc-p2-")))]]);
  const own = await loadPermissionContext({ applies: true, store: store(), grants: NONE, projectId: "p1", scope: "chat", repos });
  const tools = chatAllowedTools(own);
  for (const t of CHAT_ALLOWED_TOOLS) assert.ok(tools.includes(t));
  assert.ok(tools.includes("mcp__backcode__request_permission"));
  assert.ok(tools.includes("WebFetch(domain:api.tcgdex.net)"));
  assert.equal(own.roots[0]?.name, "Proyecto p2");

  const mate = await loadPermissionContext({ applies: false, store: store(), grants: threadGrants([{ author: "user", kind: "grant", grant: { decision: "once", domains: ["x.com"] } }]), projectId: "p1", scope: "chat", repos });
  assert.deepEqual(mate.perms, NONE);
  assert.deepEqual(chatAllowedTools(mate), CHAT_ALLOWED_TOOLS);
  assert.match(mate.prompt, /teammate/);
  const session = sessionPermissions(mate, ["registry.npmjs.org"]);
  assert.ok(session.disallowedTools.includes("WebFetch"));
  assert.deepEqual(session.allowedDomains, ["registry.npmjs.org"]);
});

test("chat: lo concedido en la conversación se suma a los permisos personales (solo del dueño)", async () => {
  const grants = threadGrants([
    { author: "user", kind: "grant", grant: { decision: "once", domains: ["tcgcsv.com"], commands: ["wget"], readProjects: [] } },
    { author: "user", kind: "grant", grant: { decision: "deny", domains: ["evil.com"] } },
  ]);
  const ctx = await loadPermissionContext({ applies: true, store: store({ domains: [], commands: [], readProjects: [] }), grants, projectId: "p1", scope: "chat", repos: new Map() });
  assert.deepEqual(ctx.perms, { domains: ["tcgcsv.com"], commands: ["wget"], readProjects: [] });
  const session = sessionPermissions(ctx, ["registry.npmjs.org"]);
  assert.deepEqual(session.allowedDomains, ["registry.npmjs.org", "tcgcsv.com"]);
  assert.deepEqual(session.guard.allowCommands, ["wget"]);
  assert.ok(!session.disallowedTools.includes("WebFetch"));
});

test("request_permission: valida y devuelve solo lo que falta", () => {
  const ctx = { perms: { domains: ["a.com"], commands: [], readProjects: [] }, otherProjects: ["p2"], available: [{ id: "p2", name: "Dos" }] };
  assert.deepEqual(checkPermissionRequest({ domains: ["a.com", "https://B.com/x"], commands: ["curl"] }, ctx), { need: { domains: ["b.com"], commands: ["curl"], readProjects: [] } });
  assert.ok("error" in checkPermissionRequest({ domains: ["a.com"] }, ctx));
  assert.ok("error" in checkPermissionRequest({ domains: ["not a domain"] }, ctx));
  assert.ok("error" in checkPermissionRequest({ projects: ["p9"] }, ctx));
  assert.ok("error" in checkPermissionRequest({}, ctx));
});

test("chat: aunque se concedan curl/wget, secretos, git que cambia estado, gh, sudo y ssh siguen bloqueados", async () => {
  const wt = mkdtempSync(join(tmpdir(), "bc-chat-"));
  const hook = createGuardHook(wt, () => false, sessionPermissions({ perms: { domains: ["a.com"], commands: ["curl", "wget"], readProjects: [] }, roots: [] }, []).guard);
  const run = async (command: string) => {
    const out = (await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as unknown as HookInput, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision === "deny";
  };
  assert.equal(await run("curl https://a.com/x"), false);
  for (const cmd of ["git push origin main", "gh pr list", "sudo ls", "ssh host", "curl https://a.com && ssh host", "printenv", "cat ~/.npmrc"]) {
    assert.equal(await run(cmd), true, cmd);
  }
});

test("chat: el system prompt explica request_permission y lista lo concedido", () => {
  const text = buildChatSystemAppend({ projectName: "P", projectContext: "", worktree: "/tmp/nowhere", baseBranch: "main", remote: "origin", language: "Spanish", permissions: "- Network: read-only requests to these domains (and only these): a.com." });
  assert.match(text, /request_permission/);
  assert.match(text, /a\.com/);
  assert.match(text, /can never be granted/);
});
