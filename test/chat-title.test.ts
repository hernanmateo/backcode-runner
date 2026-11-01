import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ALLOWED_TOOLS, CHAT_TITLE_MAX, canRetitle, conversationTitle } from "../src/chat.js";
import { buildChatSystemAppend } from "../src/prompt.js";

test("conversationTitle: un renglón, sin espacios de más, comillas ni punto final", () => {
  assert.equal(conversationTitle("  Despliegues   y\nversiones.  "), "Despliegues y versiones");
  assert.equal(conversationTitle("«Historial del chat»"), "Historial del chat");
  assert.equal(conversationTitle('"Selector de proyecto"...'), "Selector de proyecto");
});

test("conversationTitle: vacío = null y como mucho CHAT_TITLE_MAX caracteres", () => {
  assert.equal(conversationTitle(""), null);
  assert.equal(conversationTitle("   \n "), null);
  assert.equal(conversationTitle("."), null);
  const long = conversationTitle("palabra ".repeat(30));
  assert.ok(long && long.length <= CHAT_TITLE_MAX);
  assert.equal(long, long.trim());
});

test("canRetitle: un título renombrado a mano no se sobrescribe", () => {
  assert.equal(canRetitle({}), true);
  assert.equal(canRetitle({ titleManual: false }), true);
  assert.equal(canRetitle({ titleManual: true }), false);
});

test("set_conversation_title está permitida y el prompt explica cuándo usarla", () => {
  assert.ok(CHAT_ALLOWED_TOOLS.includes("mcp__backcode__set_conversation_title"));
  const vars = { projectName: "P", projectContext: "", worktree: "/tmp/nope-chat", baseBranch: "main", remote: "origin", language: "Spanish" };
  const auto = buildChatSystemAppend(vars);
  assert.match(auto, /set_conversation_title in your first reply/);
  assert.match(auto, /epic/);
  assert.match(auto, /Don't call it on every message/);
  const manual = buildChatSystemAppend({ ...vars, titleManual: true });
  assert.match(manual, /never call set_conversation_title/);
  assert.doesNotMatch(manual, /in your first reply/);
});
