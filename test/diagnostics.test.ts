import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, classify, fingerprint, looksSecret, report, sanitize, summarize, type DiagnosticPayload } from "../src/diagnostics.js";

const ctx = { repoPath: "/Users/ana/Projects/pokescan", worktreesDir: "/Users/ana/.backcode/worktrees/P1", remoteUrl: "git@github.com:ana/pokescan.git", home: "/Users/ana" };
const POKESCAN = `wrangler deploy terminó con código 1:
⛅️ wrangler 4.2.0
✘ [ERROR] The directory specified by the "assets.directory" field in your configuration file does not exist:
/Users/ana/.backcode/worktrees/P1/abc123/server/public`;

test("clasifica: excepciones del runner, despliegues elegidos por Backcode y nada del proyecto", () => {
  assert.equal(classify("TypeError: Cannot read properties of undefined (reading 'id')", { thrown: true }), "backcode");
  assert.equal(classify("algo raro sin tipo", { thrown: true }), "backcode");
  // La salida de un comando: del proyecto, salvo que el comando lo eligiera Backcode.
  assert.equal(classify(POKESCAN, { thrown: false, source: "detected" }), "unsure");
  assert.equal(classify(POKESCAN, { thrown: false, source: "config" }), "unsure");
  assert.equal(classify(POKESCAN, { thrown: false, source: "script" }), null);
  assert.equal(classify("npm run build terminó con código 1:\nTypeError: x is not a function", { thrown: false }), null);
  // Mensajes que prepara el propio runner (validaciones): no.
  assert.equal(classify("No hay canal production en eas.json", { thrown: false }), null);
  // Sesión, red, caídas del servidor remoto, cuota, tests, lockfile: nunca.
  const remote500 = "sh -c ./scripts/release-runner.sh terminó con código 1:\nremote: Internal Server Error\nTo <remote>\n ! [remote rejected] HEAD -> main (Internal Server Error)\nerror: falló el empuje de algunas referencias a '<remote>'";
  for (const e of [remote500, "wrangler deploy terminó con código 1:\n✘ [ERROR] 503 Service Unavailable", "firebase deploy terminó con código 1:\nHTTP Error: 502, Bad Gateway","wrangler deploy terminó con código 1:\nYou are not logged in", "Error: getaddrinfo ENOTFOUND api.github.com", "usage limit reached", "npm test terminó con código 1:\n3 failing", "permission denied (publickey)", "firebase deploy terminó con código 1:\nHTTP Error: 403"]) {
    assert.equal(classify(e, { thrown: true, source: "detected" }), null, e);
  }
});

test("limpia rutas personales, worktrees, repo, remoto, correos y sha", () => {
  const out = sanitize(`${POKESCAN}\nen /Users/ana/Projects/pokescan/server y ~/.backcode/worktrees/P1/x/a.ts\nhttps://github.com/ana/pokescan/pull/3 ana@example.com\ncommit 0123456789abcdef0123456789abcdef01234567\n/home/bob/app C:\\Users\\Bob\\app pokescan-web`, ctx)!;
  assert.ok(out);
  assert.doesNotMatch(out, /ana|bob|pokescan|example\.com|0123456789abcdef0123/i);
  assert.match(out, /<worktree>\/server\/public/);
  assert.match(out, /<repo>\/server/);
  assert.match(out, /<remote>/);
  assert.match(out, /<email>/);
  assert.match(out, /<hash>/);
});

test("si algo parece un secreto, no se envía nada", () => {
  const secrets = [
    "ghp_" + "a".repeat(36),
    "sk-ant-" + "b".repeat(30),
    "AKIA" + "C".repeat(16),
    "AIza" + "d".repeat(35),
    "-----BEGIN RSA " + "PRIVATE KEY-----", // por partes: que el propio guard de secretos no salte con el test
    "Authorization: Bearer abcdefghijklmnop1234",
    "CLOUDFLARE_API_TOKEN=abcd1234efgh",
    "password: hunter22",
    "https://user:pa55word@registry.example.com/x",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
    "npm_" + "e".repeat(36),
    "sk_live_" + "f".repeat(24),
    "f".repeat(64),
  ];
  for (const s of secrets) {
    assert.ok(looksSecret(s), s);
    assert.equal(sanitize(`error: ${s}`, ctx), null, s);
    assert.equal(buildReport({ action: "deploy", error: `${POKESCAN}\n${s}`, source: "detected", thrown: false }, ctx), null, s);
  }
  // Lo normal no se toma por secreto.
  for (const s of ["Author: <email>", "commit <hash>", "token expired? no: build 12", "assets.directory does not exist"]) assert.equal(looksSecret(s), false, s);
});

test("la huella no cambia con rutas, números ni hashes; sí con el error", () => {
  const a = fingerprint(["deploy", "detected", "wrangler", "✘ field at /a/b/c.ts:12:3 does not exist (abc1234)"]);
  const b = fingerprint(["deploy", "detected", "wrangler", "✘ field at ~/x/y.ts:99:1 does not exist (fff9999)"]);
  const c = fingerprint(["deploy", "detected", "wrangler", "✘ otra cosa distinta"]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("el informe: cabecera y causa, registro acotado, sin datos del ordenador", () => {
  assert.equal(summarize(POKESCAN).split("\n")[0], "wrangler deploy terminó con código 1:");
  assert.match(summarize(POKESCAN), /assets\.directory/);
  const r = buildReport({ action: "deploy", error: POKESCAN, log: "x\n".repeat(5000), provider: "wrangler", source: "detected", thrown: false }, ctx)!;
  assert.equal(r.kind, "unsure");
  assert.equal(r.source, "detected");
  assert.equal(r.provider, "wrangler");
  assert.ok(r.message.length <= 500 && (r.log ?? "").length <= 3000);
  assert.match(r.platform, /^[a-z0-9_-]{1,32}$/);
  assert.match(r.fingerprint, /^[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(r), /ana|pokescan/i);
  // El mismo fallo en otro ordenador da la misma huella.
  const other = buildReport({ action: "deploy", error: POKESCAN.replaceAll("/Users/ana", "/Users/luis").replace("abc123", "zzz999"), provider: "wrangler", source: "detected", thrown: false }, { ...ctx, repoPath: "/Users/luis/code/pokescan", worktreesDir: "/Users/luis/.backcode/worktrees/P2", home: "/Users/luis" })!;
  assert.equal(other.fingerprint, r.fingerprint);
  // Del proyecto: nada.
  assert.equal(buildReport({ action: "deploy", error: POKESCAN, source: "script", thrown: false }, ctx), null);
});

test("solo con el interruptor, y una vez por huella y hora", async () => {
  const sent: DiagnosticPayload[] = [];
  const store = { shareDiagnostics: false, sendDiagnostic: async (d: DiagnosticPayload) => void sent.push(d) };
  const payload = buildReport({ action: "merge", error: "TypeError: boom", thrown: true }, ctx)!;
  assert.equal(await report(store, payload), false);
  store.shareDiagnostics = true;
  assert.equal(await report(store, payload), true);
  assert.equal(await report(store, payload), false);
  assert.equal(await report(store, null), false);
  assert.equal(sent.length, 1);
  // Si falla al enviar, no lanza.
  const broken = { shareDiagnostics: true, sendDiagnostic: async () => Promise.reject(new Error("permission-denied")) };
  assert.equal(await report(broken, buildReport({ action: "ota", error: "TypeError: otra", thrown: true }, ctx)), false);
});
