import assert from "node:assert/strict";
import { test } from "node:test";
import { capChangedFiles, changedDeployScriptFiles, deployCapabilitiesWithRun, deployRun, deployScriptsChanged } from "../src/pr-files.ts";
import type { DeployTarget } from "../src/git.ts";

test("capChangedFiles: sin duplicados, configuración del runner primero y con tope", () => {
  const many = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
  const out = capChangedFiles([...many, "backcode.toml", "app/package.json", "", " src/f0.ts "], 200);
  assert.equal(out.length, 200);
  assert.deepEqual(out.slice(0, 2), ["backcode.toml", "app/package.json"]);
  assert.equal(out.filter((f) => f === "src/f0.ts").length, 1);
});

test("deployScriptsChanged: solo cuentan los scripts backcode:deploy:*", () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });
  assert.equal(deployScriptsChanged(pkg({ test: "a", "backcode:deploy:web": "x" }), pkg({ test: "b", "backcode:deploy:web": "x" })), false);
  assert.equal(deployScriptsChanged(pkg({ "backcode:deploy:web": "x" }), pkg({ "backcode:deploy:web": "y" })), true);
  assert.equal(deployScriptsChanged(pkg({}), pkg({ "backcode:deploy:db": "z" })), true);
  assert.equal(deployScriptsChanged(null, pkg({ "backcode:deploy:db": "z" })), true);
  assert.equal(deployScriptsChanged("{roto", pkg({})), false);
});

test("changedDeployScriptFiles: compara base y rama de cada package.json cambiado", async () => {
  const files: Record<string, { base: string | null; head: string | null }> = {
    "package.json": { base: '{"scripts":{"backcode:deploy:a":"1"}}', head: '{"scripts":{"backcode:deploy:a":"2"}}' },
    "app/package.json": { base: '{"scripts":{"lint":"1"}}', head: '{"scripts":{"lint":"2"}}' },
  };
  const out = await changedDeployScriptFiles(["package.json", "app/package.json", "src/x.ts"], async (rev, path) => files[path]?.[rev] ?? null);
  assert.deepEqual(out, ["package.json"]);
});

test("deployRun: script, run de backcode.toml, comando detectado y secretos", () => {
  assert.equal(deployRun({ script: "firebase deploy --only functions" }), "firebase deploy --only functions");
  assert.equal(deployRun({ auto: { cmd: ["sh", "-c", "./scripts/release.sh"], rank: 0, paths: [] } }), "./scripts/release.sh");
  assert.equal(deployRun({ auto: { cmd: ["npx", "--yes", "wrangler", "deploy", "my env"], rank: 0, paths: [] } }), "npx --yes wrangler deploy 'my env'");
  assert.equal(deployRun({ script: "API_KEY=abcdef123456 node deploy.js" }), undefined);
  assert.equal(deployRun({}), undefined);
  assert.equal(deployRun({ script: "x".repeat(800) })?.length, 500);
});

test("deployCapabilitiesWithRun: añade run a cada destino que se puede enseñar", () => {
  const targets: DeployTarget[] = [
    { id: "#web", name: "web", dir: "", pm: "npm", source: "script", script: "npm run build && wrangler deploy" },
    { id: "#runner", name: "runner", dir: "", pm: "npm", source: "config", auto: { cmd: ["sh", "-c", "./scripts/release-runner.sh"], rank: 0, paths: [] } },
    { id: "#leak", name: "leak", dir: "", pm: "npm", source: "script", script: "TOKEN=supersecretvalue123 deploy" },
  ];
  const caps = deployCapabilitiesWithRun(targets);
  assert.equal(caps[0].run, "npm run build && wrangler deploy");
  assert.equal(caps[1].run, "./scripts/release-runner.sh");
  assert.equal(caps[1].config, true);
  assert.equal("run" in caps[2], false);
});
