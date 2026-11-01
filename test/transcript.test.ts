import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoptTranscript, hasTranscript, isSessionGoneError, retentionDays, transcriptPath } from "../src/remote.js";

/** Con un ~/.claude de pruebas (CLAUDE_CONFIG_DIR). */
function withClaudeDir(fn: (dir: string) => void) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "bc-claude-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

test("la sesión sigue disponible si está en la carpeta del worktree o en otra, sin copiarla", () =>
  withClaudeDir(() => {
    const wt = "/Users/x/.backcode/worktrees/p/f";
    assert.equal(hasTranscript(wt, "s-1"), false);
    const elsewhere = transcriptPath("/Users/x/repo", "s-1");
    mkdirSync(join(elsewhere, ".."), { recursive: true });
    writeFileSync(elsewhere, "{}\n");
    assert.equal(hasTranscript(wt, "s-1"), true);
    assert.equal(existsSync(transcriptPath(wt, "s-1")), false);
    mkdirSync(join(transcriptPath(wt, "s-2"), ".."), { recursive: true });
    writeFileSync(transcriptPath(wt, "s-2"), "{}\n");
    assert.equal(hasTranscript(wt, "s-2"), true);
    assert.equal(hasTranscript(wt, "otra"), false);
  }));

test("los días de retención salen de cleanupPeriodDays (30 si no está o no vale)", () =>
  withClaudeDir((dir) => {
    assert.equal(retentionDays(), 30);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }));
    assert.equal(retentionDays(), 90);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: "mucho" }));
    assert.equal(retentionDays(), 30);
    writeFileSync(join(dir, "settings.json"), "{ roto");
    assert.equal(retentionDays(), 30);
  }));

test("reconoce el error de Claude Code de sesión inexistente", () => {
  assert.equal(isSessionGoneError("exit 1: No conversation found with session ID: abc"), true);
  assert.equal(isSessionGoneError("timeout"), false);
});

test("una sesión empezada en el repo se copia a la carpeta del worktree para retomarla allí", () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "bc-claude-"));
  try {
    const original = transcriptPath("/Users/x/repo", "abc-123");
    mkdirSync(join(original, ".."), { recursive: true });
    writeFileSync(original, '{"type":"user"}\n');
    assert.equal(adoptTranscript("/Users/x/.backcode/worktrees/p/f", "abc-123"), true);
    assert.equal(readFileSync(transcriptPath("/Users/x/.backcode/worktrees/p/f", "abc-123"), "utf8"), '{"type":"user"}\n');
    // Ya está: no se vuelve a copiar (ni se pisa lo que el runner haya añadido).
    writeFileSync(transcriptPath("/Users/x/.backcode/worktrees/p/f", "abc-123"), "más\n");
    assert.equal(adoptTranscript("/Users/x/.backcode/worktrees/p/f", "abc-123"), true);
    assert.equal(readFileSync(transcriptPath("/Users/x/.backcode/worktrees/p/f", "abc-123"), "utf8"), "más\n");
    assert.equal(adoptTranscript("/Users/x/.backcode/worktrees/p/f", "no-existe"), false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
