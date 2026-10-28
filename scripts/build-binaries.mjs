#!/usr/bin/env node
// Compila el runner a ejecutables sin Node (Bun --compile), uno por plataforma, en dist-bin/, con SHA256SUMS.
// Uso: node scripts/build-binaries.mjs [darwin-arm64 darwin-x64 linux-x64 linux-arm64]   (por defecto, todas)
// Los ficheros del paquete (panel, instrucciones, package.json) van incrustados: se compila desde una copia de src/ en
// .build/ con src/embedded.ts relleno, así el código fuente y el paquete de npm no cambian.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const t of targets) if (!ALL.includes(t)) throw new Error(`unknown target ${t} (${ALL.join(", ")})`);

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
  execFileSync("bun", ["build", join(build, "src", "cli.ts"), "--compile", "--minify", `--target=bun-${target}`, "--outfile", file], { stdio: "inherit", cwd: root });
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  backcode-${target}`);
}
writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
rmSync(build, { recursive: true, force: true });
console.log(`✓ ${targets.length} ejecutable(s) en dist-bin/`);
