import assert from "node:assert/strict";
import test from "node:test";
import { fixPrompt, hasMarkers } from "../src/conflicts.js";

test("hasMarkers detecta las marcas de conflicto de git", () => {
  assert.equal(hasMarkers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> origin/main\n"), true);
  assert.equal(hasMarkers("a\n=======\n"), true);
  assert.equal(hasMarkers("a\n||||||| base\n"), true);
  assert.equal(hasMarkers("# Título\n\n=== no es una marca\n<<<<<<<< ocho\n"), false);
  assert.equal(hasMarkers("const x = a <<<<<<< b;\n"), false);
});

test("fixPrompt lista los ficheros y pide conservar los dos cambios", () => {
  const p = fixPrompt(["README.md", "docs/PRODUCTO.md"], "origin/main", "Spanish");
  assert.match(p, /- README\.md\n- docs\/PRODUCTO\.md/);
  assert.match(p, /Keep BOTH sides/);
  assert.match(p, /in Spanish/);
});
