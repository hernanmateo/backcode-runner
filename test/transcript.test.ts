import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoptTranscript, transcriptPath } from "../src/remote.js";

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
