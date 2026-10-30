import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDeployConfig } from "../src/deploy-config.js";
import { findDeployTargets } from "../src/git.js";

test("backcode.toml: comando con o sin shell, carpeta, tipo (orden) y rutas", () => {
  const { deploys, errors } = readDeployConfig(
    "",
    "backcode.toml",
    `# despliegues sin Node
[deploy.db]
run = "python manage.py migrate"  # va primero
kind = "migration"
dir = "api"

[deploy.api]
run = ["make", "deploy"]
dir = "api/"
paths = ["api/", 'common/']
`,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(deploys, [
    { name: "db", dir: "api", cmd: ["sh", "-c", "python manage.py migrate"], rank: 0, paths: ["api"] },
    { name: "api", dir: "api", cmd: ["make", "deploy"], rank: 2, paths: ["api", "common"] },
  ]);
});

test("backcode.toml en una subcarpeta y backcode.json: rutas relativas a su carpeta", () => {
  const sub = readDeployConfig("services/web", "services/web/backcode.toml", '[deploy.web]\nrun = "./deploy.sh"\n');
  assert.deepEqual(sub.deploys[0], { name: "web", dir: "services/web", cmd: ["sh", "-c", "./deploy.sh"], rank: 2, paths: ["services/web"] });
  const json = readDeployConfig("", "backcode.json", '{ "deploy": { "worker": { "run": "cargo run --bin deploy", "kind": "functions" } } }');
  assert.deepEqual(json.deploys.map((d) => [d.name, d.rank]), [["worker", 1]]);
});

test("backcode.toml mal escrito: dice qué línea o qué despliegue falla, y no se cuela nada fuera del repo", () => {
  const { deploys, errors } = readDeployConfig(
    "",
    "backcode.toml",
    `[deploy.ok]
run = "make"
[deploy.Mal_Nombre]
run = "x"
[deploy.sinrun]
dir = "a"
[deploy.fuera]
run = "x"
dir = "../otro"
[deploy.tipo]
run = "x"
kind = "magia"
esto no es toml
`,
  );
  assert.deepEqual(deploys.map((d) => d.name), ["ok"]);
  assert.equal(errors.length, 5);
  assert.ok(errors.some((e) => e.startsWith("línea 13")));
  assert.ok(errors.some((e) => e.includes("Mal_Nombre")));
  assert.ok(errors.some((e) => e.includes("fuera")));
});

test("en el repo: backcode.toml gana a un backcode:deploy del mismo nombre y carpeta, y no instala dependencias de JS", async () => {
  const repo = mkdtempSync(join(tmpdir(), "bc-toml-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "api"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "backcode:deploy:api": "npm run deploy", "backcode:deploy:web": "npm run web" } }));
  writeFileSync(join(repo, "backcode.toml"), '[deploy.api]\nrun = "make deploy"\n');
  writeFileSync(join(repo, "api", "main.py"), "");
  git("add", ".");
  git("commit", "-qm", "init");
  const targets = await findDeployTargets(repo, "HEAD");
  const api = targets.find((d) => d.name === "api");
  assert.equal(targets.filter((d) => d.name === "api").length, 1);
  assert.equal(api?.source, "config");
  assert.deepEqual(api?.auto?.cmd, ["sh", "-c", "make deploy"]);
  assert.equal(api?.auto?.install, false);
  assert.equal(targets.find((d) => d.name === "web")?.source, "script");
});
