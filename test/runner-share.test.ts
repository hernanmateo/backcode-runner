import assert from "node:assert/strict";
import test from "node:test";
import { isShareOpen } from "../src/runner-share.js";

const NOW = 1_000_000_000_000;
const ts = (ms: number) => ({ toMillis: () => ms });

test("isShareOpen: flag por ámbito, caducidad y el enabled de antes", () => {
  assert.equal(isShareOpen(null, "chat", NOW), false);
  assert.equal(isShareOpen({ chat: true }, "chat", NOW), true);
  assert.equal(isShareOpen({ chat: true }, "ideas", NOW), false);
  assert.equal(isShareOpen({ ideas: true, ideasUntil: ts(NOW + 1) }, "ideas", NOW), true);
  assert.equal(isShareOpen({ ideas: true, ideasUntil: ts(NOW) }, "ideas", NOW), false);
  assert.equal(isShareOpen({ chat: true, chatUntil: null }, "chat", NOW), true);
  assert.equal(isShareOpen({ enabled: true }, "ideas", NOW), true);
  assert.equal(isShareOpen({ enabled: false, chat: false }, "chat", NOW), false);
});
