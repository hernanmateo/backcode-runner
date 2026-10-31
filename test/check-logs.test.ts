import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanFailedLog } from "../src/check-logs.js";

const raw = [
  "Tests\tRun npm test\t2026-10-31T00:27:00.1234567Z \x1b[31m✖ rules › desplegarlo todo\x1b[0m",
  "Tests\tRun npm test\t2026-10-31T00:27:00.2Z ",
  "Tests\tRun npm test\t2026-10-31T00:27:01.0Z # fail 2",
  "Lint\tRun npm run lint\t2026-10-31T00:27:02.0Z src/a.ts:3:1 error 'x' is unused",
].join("\n");

test("cleanFailedLog: una cabecera por job, sin fechas, colores ni líneas vacías", () => {
  assert.equal(cleanFailedLog(raw), "## Tests\n✖ rules › desplegarlo todo\n# fail 2\n## Lint\nsrc/a.ts:3:1 error 'x' is unused");
});

test("cleanFailedLog: se queda con el final (donde está el error)", () => {
  // Texto distinto en cada línea (las que solo cambian en números cuentan como repetidas).
  const word = (i: number) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));
  const long = Array.from({ length: 200 }, (_, i) => `Tests\tstep\t2026-10-31T00:00:00Z línea ${word(i)}`).join("\n");
  const out = cleanFailedLog(long, 100);
  assert.ok(out.length <= 100);
  assert.ok(out.startsWith("…\n"));
  assert.ok(out.endsWith(`línea ${word(199)}`));
});

test("cleanFailedLog: quita las líneas que parecen secretos", () => {
  const out = cleanFailedLog("Tests\tstep\t2026-10-31T00:00:00Z token ghp_" + "a".repeat(36) + "\nTests\tstep\t2026-10-31T00:00:00Z ok");
  assert.equal(out, "## Tests\nok");
});

test("cleanFailedLog: sin el ruido de node --test ni líneas repetidas, y con los colores en texto de gh", () => {
  const tap = ["ok 1 - pasa", "  ---", "  duration_ms: 12.3", "  type: 'test'", "  ...", "not ok 2 - falla", "PERMISSION_DENIED", "PERMISSION_DENIED", "^[[31mError:^[[39m salió con 1"];
  assert.equal(cleanFailedLog(tap.map((l) => `Tests\tstep\t2026-10-31T00:00:00Z ${l}`).join("\n")), "## Tests\nnot ok 2 - falla\nPERMISSION_DENIED\nError: salió con 1");
});
