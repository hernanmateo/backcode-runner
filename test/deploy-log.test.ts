import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// HOME_DIR se lee al importar: la carpeta de pruebas va antes.
process.env.BACKCODE_HOME = mkdtempSync(join(tmpdir(), "bc-deploylog-home-"));
const { deployedOk, firebaseRulesParts, flushDeployQueue, matchDeploy, noteHookDeploy, queueDeploy } = await import("../src/deploy-log.js");
const { findDeployTargets } = await import("../src/git.js");
type Target = Awaited<ReturnType<typeof findDeployTargets>>[number];

const top = "/r";
const targets: Target[] = [
  { id: "tests#rules", name: "rules", dir: "tests", pm: "npm", source: "script", provider: "firebase", env: { provider: "firebase", project: "demo-prod", only: "firestore,storage" } },
  { id: "tests#functions", name: "functions", dir: "tests", pm: "npm", source: "script", provider: "firebase", env: { provider: "firebase", project: "demo-prod", only: "functions" } },
  { id: "api#api-db", name: "api-db", dir: "api", pm: "npm", provider: "wrangler", source: "detected", auto: { cmd: ["npm", "run", "db:migrate"], rank: 0, paths: ["api/migrations"], install: true } },
  { id: "api#api", name: "api", dir: "api", pm: "npm", provider: "wrangler", source: "detected", auto: { cmd: ["npx", "--yes", "wrangler", "deploy"], rank: 2, paths: ["api"], install: true } },
  { id: "#supabase-db", name: "supabase-db", dir: "", pm: "npm", provider: "supabase", source: "detected", auto: { cmd: ["npx", "--yes", "supabase", "db", "push", "--linked", "--yes"], rank: 0, paths: ["supabase/migrations"], install: true } },
  { id: "#supabase-functions", name: "supabase-functions", dir: "", pm: "npm", provider: "supabase", source: "detected", auto: { cmd: ["npx", "--yes", "supabase", "functions", "deploy", "--yes"], rank: 1, paths: ["supabase/functions"], install: true } },
  { id: "web#web", name: "web", dir: "web", pm: "pnpm", source: "script" },
];
const names = (command: string, cwd = top) => matchDeploy(command, cwd, top, targets).map((t) => t.name).sort();

test("matchDeploy: scripts del proyecto, en su carpeta y sin argumentos de más", () => {
  assert.deepEqual(names("npm --prefix tests run backcode:deploy:rules"), ["rules"]);
  assert.deepEqual(names("cd tests && npm run backcode:deploy:functions"), ["functions"]);
  assert.deepEqual(names("npm run backcode:deploy:rules", "/r/tests"), ["rules"]);
  assert.deepEqual(names("cd api && npm run db:migrate"), ["api-db"]);
  assert.deepEqual(names("pnpm -C web backcode:deploy:web"), ["web"]);
  // Otra carpeta, otro script o con argumentos (otro entorno, otro canal…): nada.
  assert.deepEqual(names("npm run backcode:deploy:rules"), []);
  assert.deepEqual(names("cd api && npm run db:migrate -- --env staging"), []);
  assert.deepEqual(names("npm run build", "/r/web"), []);
});

test("matchDeploy: firebase deploy, según el --only y el proyecto del destino", () => {
  assert.deepEqual(names("firebase deploy --only firestore,storage"), ["rules"]);
  assert.deepEqual(names("npx --yes firebase-tools deploy --only storage,firestore --project demo-prod --non-interactive"), ["rules"]);
  assert.deepEqual(names("firebase deploy --only functions"), ["functions"]);
  assert.deepEqual(names("firebase deploy"), ["functions", "rules"]);
  // Parcial (solo Firestore, solo sus reglas, una función) u otro proyecto: no deja el destino al día.
  assert.deepEqual(names("firebase deploy --only firestore"), []);
  assert.deepEqual(names("firebase deploy --only firestore:rules,storage"), []);
  assert.deepEqual(names("firebase deploy --only functions:api"), []);
  assert.deepEqual(names("firebase deploy --only firestore,storage -P demo-staging"), []);
  assert.deepEqual(names("firebase deploy --only functions --dry-run"), []);
  assert.deepEqual(names("firebase emulators:start"), []);
});

test("matchDeploy: wrangler y supabase, en la carpeta de cada uno", () => {
  assert.deepEqual(names("cd api && npx wrangler deploy"), ["api"]);
  assert.deepEqual(names("wrangler deploy", "/r/api"), ["api"]);
  assert.deepEqual(names("CLOUDFLARE_ACCOUNT_ID=x wrangler d1 migrations apply main-db --remote", "/r/api"), ["api-db"]);
  assert.deepEqual(names("wrangler d1 migrations apply main-db", "/r/api"), []); // en local
  assert.deepEqual(names("wrangler deploy --env staging", "/r/api"), []);
  assert.deepEqual(names("wrangler deploy"), []); // en la raíz no hay Worker
  assert.deepEqual(names("supabase db push"), ["supabase-db"]);
  assert.deepEqual(names("supabase db push --dry-run"), []);
  assert.deepEqual(names("supabase functions deploy"), ["supabase-functions"]);
  assert.deepEqual(names("supabase functions deploy hello"), []); // solo una función
  assert.deepEqual(names("npm run build && supabase db push && supabase functions deploy"), ["supabase-db", "supabase-functions"]);
  assert.deepEqual(names("cd ../otro && wrangler deploy", "/r/api"), []);
  assert.deepEqual(names("cd $HOME/x && supabase db push"), []);
});

test("deployedOk: la marca de éxito de cada herramienta; sin plataforma conocida, nunca", () => {
  const byName = (n: string) => targets.find((t) => t.name === n)!;
  assert.equal(deployedOk(byName("rules"), "✔  Deploy complete!\n"), true);
  assert.equal(deployedOk(byName("rules"), "Error: HTTP Error: 403"), false);
  assert.equal(deployedOk(byName("api"), "Uploaded api (2.1 sec)\nDeployed api triggers (0.3 sec)\nCurrent Version ID: 1234"), true);
  assert.equal(deployedOk(byName("api"), "✘ [ERROR] A request to the Cloudflare API failed"), false);
  assert.equal(deployedOk(byName("api-db"), "No migrations to apply!"), true);
  assert.equal(deployedOk(byName("supabase-db"), "Finished supabase db push."), true);
  assert.equal(deployedOk(byName("supabase-functions"), "Deployed Functions on project abc: hello"), true);
  assert.equal(deployedOk(byName("supabase-functions"), "Finished supabase db push."), false);
  assert.equal(deployedOk(byName("web"), "Deploy complete!"), false);
});

test("firebaseRulesParts: solo los destinos que despliegan reglas o índices", () => {
  assert.deepEqual(firebaseRulesParts(targets[0]), ["firestore", "storage"]);
  assert.equal(firebaseRulesParts(targets[1]), null);
  assert.equal(firebaseRulesParts(targets[3]), null);
  const detected: Target = { id: "#firebase-rules", name: "firebase-rules", dir: "", pm: "npm", provider: "firebase", source: "detected", auto: { cmd: ["npm", "run", "deploy:rules"], rank: 0, paths: ["firestore.rules", "firestore.indexes.json"], install: true } };
  assert.deepEqual(firebaseRulesParts(detected), ["firestore"]);
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Un repo con remoto (origin/main) y un destino de reglas de Firebase. */
function repoWithRemote() {
  const root = mkdtempSync(join(tmpdir(), "bc-deploylog-repo-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "app");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "firebase.json"), JSON.stringify({ firestore: { rules: "firestore.rules" } }));
  writeFileSync(join(repo, "firestore.rules"), "rules_version = '2';\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  return { repo, origin };
}

test("hook: un despliegue que acabó bien queda en la cola (paso y commit, sin el comando); uno que falla, no", async () => {
  const { repo } = repoWithRemote();
  const sha = git(repo, "rev-parse", "HEAD");
  const ok = { tool_name: "Bash", tool_input: { command: "FIREBASE_TOKEN=secreto npx firebase-tools deploy --only firestore" }, tool_response: { stdout: "✔  Deploy complete!", stderr: "", interrupted: false } };
  assert.deepEqual(await noteHookDeploy(ok, repo, "pHook"), ["firebase-rules"]);
  const file = join(process.env.BACKCODE_HOME!, "deploylog", "pHook.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "sha", "step", "via"]);
  assert.equal(lines[0].step, "deploy:#firebase-rules");
  assert.equal(lines[0].sha, sha);
  assert.equal(readFileSync(file, "utf8").includes("secreto"), false);
  // Sin la marca de éxito, interrumpido o con cambios sin commit en lo que cubre: nada.
  assert.deepEqual(await noteHookDeploy({ ...ok, tool_response: { stdout: "Error: 403", stderr: "", interrupted: false } }, repo, "pHook"), []);
  assert.deepEqual(await noteHookDeploy({ ...ok, tool_response: { ...ok.tool_response, interrupted: true } }, repo, "pHook"), []);
  writeFileSync(join(repo, "firestore.rules"), "rules_version = '2'; // sin commit\n");
  assert.deepEqual(await noteHookDeploy(ok, repo, "pHook"), []);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
});

test("runner: apunta lo que ya está en la rama principal remota, guarda lo que aún no y descarta lo raro", async () => {
  const { repo } = repoWithRemote();
  const inMain = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "firestore.rules"), "rules_version = '2'; // nuevo\n");
  git(repo, "commit", "-qam", "sin subir");
  const notPushed = git(repo, "rev-parse", "HEAD");
  const targets = await findDeployTargets(repo, "HEAD");
  const now = Date.now();
  queueDeploy("pRun", { step: "deploy:#firebase-rules", sha: inMain, at: now, via: "claude" });
  queueDeploy("pRun", { step: "deploy:#firebase-rules", sha: notPushed, at: now, via: "claude" });
  queueDeploy("pRun", { step: "deploy:#firebase-rules", sha: notPushed, at: now - 2 * 86_400_000, via: "claude" });
  queueDeploy("pRun", { step: "deploy:#otro", sha: inMain, at: now, via: "claude" });
  queueDeploy("pRun", { step: "deploy:#firebase-rules", sha: "nope", at: now, via: "claude" });
  const logged: [string, string, string][] = [];
  const opts = { projectId: "pRun", repoPath: repo, remote: "origin", baseBranch: "main", targets, log: async (step: string, sha: string, via: string) => void logged.push([step, sha, via]) };
  assert.equal(await flushDeployQueue(opts), 1);
  assert.deepEqual(logged, [["deploy:#firebase-rules", inMain, "claude"]]);
  // El commit sin subir sigue esperando; al llegar a origin/main, se apunta.
  const file = join(process.env.BACKCODE_HOME!, "deploylog", "pRun.jsonl");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  git(repo, "push", "-q", "origin", "main");
  assert.equal(await flushDeployQueue(opts), 1);
  assert.deepEqual(logged[1], ["deploy:#firebase-rules", notPushed, "claude"]);
  assert.equal(existsSync(file), false);
  // Si el registro falla (p. ej. el runner no es de un admin), no se reintenta para siempre.
  queueDeploy("pRun", { step: "deploy:#firebase-rules", sha: inMain, at: now, via: "claude" });
  assert.equal(await flushDeployQueue({ ...opts, log: async () => Promise.reject(new Error("permission-denied")) }), 0);
  assert.equal(existsSync(file), false);
});
