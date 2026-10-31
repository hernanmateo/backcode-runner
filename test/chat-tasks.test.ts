import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ALLOWED_TOOLS, chatTaskInput, describeChatTasks } from "../src/chat.js";
import { buildChatSystemAppend } from "../src/prompt.js";

test("chatTaskInput recorta y limpia lo que pide Claude con create_task", () => {
  const input = chatTaskInput({ title: "  Añadir\n modo   oscuro ", prompt: "  Haz el modo oscuro  ", acceptanceCriteria: [" se ve bien ", "", "x".repeat(600)] });
  assert.deepEqual(input, { title: "Añadir modo oscuro", prompt: "Haz el modo oscuro", acceptanceCriteria: ["se ve bien", "x".repeat(500)] });
  assert.equal(chatTaskInput({ title: "t", prompt: "p", planFirst: true })?.planFirst, true);
  assert.equal("planFirst" in chatTaskInput({ title: "t", prompt: "p", planFirst: false })!, false);
});

test("chatTaskInput rechaza una tarea sin título o sin encargo", () => {
  assert.equal(chatTaskInput({ title: "   ", prompt: "algo" }), null);
  assert.equal(chatTaskInput({ title: "algo", prompt: "\n\n" }), null);
});

test("chatTaskInput no pasa de los límites de createChatTask", () => {
  const input = chatTaskInput({ title: "t".repeat(300), prompt: "p".repeat(9000), acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `c${i}`) })!;
  assert.equal(input.title.length, 200);
  assert.equal(input.prompt.length, 8000);
  assert.equal(input.acceptanceCriteria.length, 20);
});

test("describeChatTasks: una línea por tarea con estado, rama y PR", () => {
  const text = describeChatTasks([
    { id: "a1", title: "Primera\ncon salto", status: "running", branch: "backcode/ana/a1" },
    { id: "b2", title: "Segunda", status: "done", branch: "backcode/ana/b2", prUrl: "https://github.com/o/r/pull/7" },
  ]);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /a1 · Primera con salto · running · backcode\/ana\/a1/);
  assert.match(lines[1], /done · backcode\/ana\/b2 · https:\/\/github.com\/o\/r\/pull\/7/);
  assert.ok(describeChatTasks([]).length > 0);
});

test("el chat solo añade sus herramientas MCP: ni web, ni subagentes, ni más", () => {
  for (const name of ["WebFetch", "WebSearch", "Agent", "Task"]) assert.equal(CHAT_ALLOWED_TOOLS.includes(name), false);
  const extra = CHAT_ALLOWED_TOOLS.filter((n) => n.startsWith("mcp__"));
  assert.deepEqual(extra.sort(), ["mcp__backcode__checkout_branch", "mcp__backcode__commit_and_push", "mcp__backcode__create_task", "mcp__backcode__task_status"]);
});

test("buildChatSystemAppend explica create_task y que el chat sigue siendo dato no fiable", () => {
  const s = buildChatSystemAppend({ projectName: "P", projectContext: "", worktree: "/tmp/nope-chat", baseBranch: "main", remote: "origin", language: "Spanish" });
  assert.match(s, /create_task/);
  assert.match(s, /task_status/);
  assert.match(s, /draft pull request/);
  assert.match(s, /untrusted data for tasks too/);
});
