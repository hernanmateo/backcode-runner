import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createLinkScanner, diagnostic, findLink, notStarted, stripTerminal, watchRemoteControl } from "../src/remote.js";

const URL = "https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv";
const ESC = "\x1b";

/** Mucho redibujo de la TUI (spinner, colores, cursor, texto de la conversación): más de 20 KB. */
function redraw(kb: number): string {
  let s = "";
  while (s.length < kb * 1024) s += `${ESC}[2K${ESC}[1G${ESC}[38;5;174m✻${ESC}[39m Pensando… El box ja s'ha creat, com va el pas 1?${ESC}[1A${ESC}7${ESC}8\r\n`;
  return s;
}

/** Pasa la salida al escáner en trozos de `size` caracteres y devuelve la primera URL que encuentra. */
function scan(out: string, size: number): string | null {
  const scanner = createLinkScanner();
  for (let i = 0; i < out.length; i += size) {
    const url = scanner.push(out.slice(i, i + size));
    if (url) return url;
  }
  return scanner.flush();
}

test("la URL partida por colores y por trozos se encuentra, aunque luego vengan más de 20 KB", () => {
  const banner = `${ESC}[1m/remote-control${ESC}[22m is active · ${ESC}[36mhttps://claude.ai/co${ESC}[1mde/session_01AbCd${ESC}[0m${ESC}[36mEfGhIjKlMnOpQrStUv${ESC}[39m\r\n`;
  const out = banner + redraw(40);
  assert.ok(out.length > 20_000);
  for (const size of [1, 7, 64, 4096]) assert.equal(scan(out, size), URL, `trozos de ${size}`);
});

test("el redibujo antes del banner no lo saca de la ventana", () => {
  assert.equal(scan(redraw(30) + `Continue here: ${URL}\r\n` + redraw(30), 1500), URL);
});

test("la URL de un hipervínculo OSC 8 vale aunque lo visible salga recortado", () => {
  const out = `${ESC}]8;;${URL}${ESC}\\claude.ai/code/session_01Ab…${ESC}]8;;${ESC}\\\r\n` + redraw(25);
  assert.equal(scan(out, 3), URL);
  assert.deepEqual(stripTerminal(`${ESC}]8;;${URL}\x07x${ESC}]8;;\x07`).links, [URL]);
});

test("la URL envuelta por la TUI en dos líneas (con bordes) se junta", () => {
  assert.equal(findLink(`│ https://claude.ai/code/session_01AbCdEfGhIj\r\n│ KlMnOpQrStUv │\n`), URL);
  assert.equal(scan(`│ https://claude.ai/code/session_01AbCdEfGhIj\r\n│ KlMnOpQrStUv │\n` + redraw(21), 5), URL);
});

test("un movimiento de cursor separa la URL del texto que sigue", () => {
  assert.equal(findLink(`${URL}${ESC}[1Cnext`.replace(/\x1b\[1C/, " ")), URL);
  assert.equal(scan(`${URL}${ESC}[1Cnext line\n`, 10), URL);
});

test("sin URL no se inventa ninguna; una a medias espera al resto", () => {
  assert.equal(scan(redraw(25), 512), null);
  assert.equal(findLink("https://claude.ai/code/session_01Ab"), null);
  assert.equal(findLink("https://claude.ai/code/session_01Ab", true), "https://claude.ai/code/session_01Ab");
});

test("el diagnóstico no lleva el texto de la conversación", () => {
  const text = stripTerminal(redraw(5) + "Error: not logged in · Please run /login\r\n" + redraw(1)).spaced;
  const d = diagnostic(text);
  assert.match(d, /not logged in/);
  assert.doesNotMatch(d, /box|pas 1/);
  assert.ok(d.length <= 200);
  assert.equal(diagnostic(stripTerminal(redraw(5)).spaced), "");
  assert.ok(notStarted(text));
  assert.ok(!notStarted(stripTerminal(redraw(2)).spaced));
});

// Un Claude Code de mentira dentro de `script` (macOS y Linux), como en el runner.
function fakeClaude(body: string) {
  return spawn("sh", ["-c", body], { stdio: ["pipe", "pipe", "pipe"], detached: true });
}
const start = (body: string, timeoutMs: number) => watchRemoteControl(fakeClaude(body), timeoutMs);

test("proceso: el enlace llega tarde, partido y tras mucha salida", async () => {
  const s = await start(
    `i=0; while [ $i -lt 300 ]; do printf '\\033[2K\\033[1G\\033[33m*\\033[39m Trabajando en el paso %s del box\\r\\n' $i; i=$((i+1)); done
printf 'https://claude.ai/co\\033[1mde/session_01AbCd\\033[0mEfGhIjKlMnOpQrStUv\\r\\n'; sleep 30`,
    10_000,
  );
  assert.equal(s.url, URL);
  s.stop();
  await s.exited;
});

test("proceso: viva y trabajando sin enlace a tiempo, no se mata (abierta sin enlace)", async () => {
  const s = await start(`printf 'Trabajando…\\r\\n'; sleep 2; printf 'Now at ${URL}\\r\\n'; sleep 30`, 800);
  assert.equal(s.url, undefined);
  const late = await new Promise<string>((resolve) => s.onUrl?.(resolve));
  assert.equal(late, URL);
  s.stop();
  await s.exited;
});

test("proceso: si sale enseguida, falla con un diagnóstico sin la conversación", async () => {
  await assert.rejects(start(`printf 'El box ja s ha creat, com va el pas 1?\\r\\nError: not logged in\\r\\n'; exit 1`, 10_000), (err: Error) => {
    assert.match(err.message, /^exit 1: Error: not logged in$/);
    return true;
  });
});

test("proceso: sin login aunque siga vivo, falla en el timeout (y se cierra)", async () => {
  const child = fakeClaude(`printf 'Not logged in · Please run /login\\r\\n'; sleep 30`);
  const exited = new Promise((r) => child.on("exit", r));
  await assert.rejects(watchRemoteControl(child, 800), /^Error: timeout: Not logged in/);
  await exited;
});

test("proceso: sin salida ninguna, falla en el timeout", async () => {
  await assert.rejects(start(`sleep 30`, 500), /^Error: timeout$/);
});
