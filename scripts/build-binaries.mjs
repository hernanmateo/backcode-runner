#!/usr/bin/env node
// Compila el runner a ejecutables sin Node (Bun --compile), uno por plataforma, en dist-bin/, con SHA256SUMS.
// Uso: node scripts/build-binaries.mjs [darwin-arm64 darwin-x64 linux-x64 linux-arm64]   (por defecto, todas)
// Los ficheros del paquete (panel, instrucciones, package.json) van incrustados: se compila desde una copia de src/ en
// .build/ con src/embedded.ts relleno, así el código fuente y el paquete de npm no cambian.
//
// La versión de Bun es la de .bun-version, la misma que usa GitHub Actions (setup-bun con bun-version-file): con otra, el
// ejecutable puede salir roto aunque compile (el 4-11-2026, uno hecho con Bun 1.3.2 se quedaba al 100 % de CPU al conectar).
// Si `bun` (o el de la variable BUN) no es esa versión, no se compila. Después, si entre los destinos está el de este
// ordenador, se prueba el ejecutable (--version y `selftest`) y, si falla, tampoco se da por bueno.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const t of targets) if (!ALL.includes(t)) throw new Error(`unknown target ${t} (${ALL.join(", ")})`);

const BUN = process.env.BUN || "bun";
const wanted = readFileSync(join(root, ".bun-version"), "utf8").trim();
const have = (() => {
  try {
    return execFileSync(BUN, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
if (have !== wanted) {
  console.error(`✗ hace falta Bun ${wanted} (el de .bun-version, el mismo que GitHub Actions) y ${BUN} es ${have || "inexistente"}.`);
  console.error(`  Instálalo aparte con: curl -fsSL https://bun.sh/install | BUN_INSTALL=/tmp/bun-${wanted} bash -s bun-v${wanted}`);
  console.error(`  y compila con BUN=/tmp/bun-${wanted}/bin/bun npm run build:bin`);
  process.exit(1);
}

const files = (dir) => readdirSync(join(root, dir)).flatMap((name) => (statSync(join(root, dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
const assets = ["package.json", ...files("panel"), ...files("instructions")];
const embedded = Object.fromEntries(assets.map((f) => [relative(root, join(root, f)), readFileSync(join(root, f)).toString("base64")]));

const build = join(root, ".build");
rmSync(build, { recursive: true, force: true });
cpSync(join(root, "src"), join(build, "src"), { recursive: true });
writeFileSync(join(build, "src", "embedded.ts"), `// Generado por scripts/build-binaries.mjs\nexport const EMBEDDED: Record<string, string> | null = ${JSON.stringify(embedded)};\n`);

const out = join(root, "dist-bin");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sums = [];
for (const target of targets) {
  const file = join(out, `backcode-${target}`);
  console.log(`▸ ${target}`);
  execFileSync(BUN, ["build", join(build, "src", "cli.ts"), "--compile", "--minify", `--target=bun-${target}`, "--outfile", file], { stdio: "inherit", cwd: root });
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  backcode-${target}`);
}
writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
rmSync(build, { recursive: true, force: true });
console.log(`✓ ${targets.length} ejecutable(s) en dist-bin/ (Bun ${have})`);

// Prueba de humo del de este ordenador (los demás no se pueden arrancar aquí).
const here = `${process.platform}-${process.arch}`;
if (targets.includes(here) && process.env.BACKCODE_SKIP_SMOKE !== "1") {
  const bin = join(out, `backcode-${here}`);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const got = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (got.stdout?.trim() !== version) {
    console.error(`✗ backcode-${here} --version dio «${(got.stdout || got.stderr || got.error?.message || "").trim()}», no ${version}`);
    process.exit(1);
  }
  const smoke = spawnSync(bin, ["selftest"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(smoke.stdout ?? "");
  if (smoke.status !== 0) {
    process.stderr.write(smoke.stderr ?? "");
    console.error(`✗ backcode-${here} no pasa la prueba de humo${smoke.error ? ` (${smoke.error.message})` : ""}: no se publica`);
    process.exit(1);
  }
  console.log(`✓ backcode-${here} pasa la prueba de humo`);
}
