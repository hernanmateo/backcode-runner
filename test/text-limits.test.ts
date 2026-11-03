import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAT_TEXT_MAX, EVENT_TEXT_MAX, splitText } from "../src/text-limits.js";

test("splitText: un texto que cabe queda igual", () => {
  assert.deepEqual(splitText("hola", 10), ["hola"]);
  assert.deepEqual(splitText("", 10), [""]);
  const long = "x".repeat(5000);
  assert.deepEqual(splitText(long, EVENT_TEXT_MAX), [long]);
});

test("splitText: parte por párrafo, luego por línea y luego por palabra, sin perder texto", () => {
  const paras = ["a".repeat(600), "b".repeat(600), "c".repeat(600)].join("\n\n");
  assert.deepEqual(splitText(paras, 1000), ["a".repeat(600), "b".repeat(600), "c".repeat(600)]);

  const words = Array.from({ length: 400 }, (_, i) => `palabra${i}`).join(" ");
  const pieces = splitText(words, 1000);
  assert.ok(pieces.length > 1);
  for (const p of pieces) {
    assert.ok(p.length <= 1000);
    assert.match(p, /^palabra\d+( palabra\d+)*$/, "no corta a media palabra");
  }
  assert.equal(pieces.join(" "), words);
});

test("splitText: sin espacios corta en el límite sin partir un emoji", () => {
  assert.deepEqual(splitText("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  const pieces = splitText("x".repeat(9) + "😀" + "y", 10);
  assert.deepEqual(pieces, ["x".repeat(9), "😀y"]);
});

test("los límites coinciden con firestore.rules", () => {
  const path = fileURLToPath(new URL("../../firestore.rules", import.meta.url));
  if (!existsSync(path)) return; // paquete publicado sin las reglas del repo
  const rules = readFileSync(path, "utf8");
  const events = /match \/events\/\{eid\}[\s\S]*?text\.size\(\) <= (\d+)/.exec(rules);
  assert.equal(Number(events?.[1]), EVENT_TEXT_MAX);
  assert.match(rules, new RegExp(`m\\(\\)\\.author == 'claude' && str\\(m\\(\\)\\.text, ${CHAT_TEXT_MAX}\\) && m\\(\\)\\.kind in \\['say'`));
});
