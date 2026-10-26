import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { KIT_DIR } from "./config.js";

// `npm run all`: un runner por cada proyecto configurado (.env.<proyecto> creados con `npm run connect`),
// todos a la vez. Cada línea de log lleva delante el proyecto. Ctrl+C los para a todos limpiamente.

const COLORS = [36, 35, 33, 32, 34, 31];
const files = readdirSync(KIT_DIR).filter((f) => /^\.env\.[A-Za-z0-9_-]+$/.test(f) && f !== ".env.example");
if (files.length === 0) {
  console.error("No hay proyectos configurados. Conecta uno con `npm run connect` (app → Proyecto → Conectar mi Claude Code).");
  process.exit(1);
}

console.log(`Arrancando ${files.length} runner(s): ${files.map((f) => f.slice(5)).join(", ")}\n`);
let alive = files.length;
for (const [i, file] of files.entries()) {
  const projectId = /BACKCODE_PROJECT_ID=(.+)/.exec(readFileSync(join(KIT_DIR, file), "utf8"))?.[1]?.trim() ?? file.slice(5);
  const tag = `\x1b[${COLORS[i % COLORS.length]}m[${projectId}]\x1b[0m`;
  const child = spawn(process.execPath, [join(KIT_DIR, "dist", "index.js"), "--env", file], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => console.log(`${tag} ${line}`));
  }
  child.on("exit", (code) => {
    console.log(`${tag} terminado (${code ?? 0})`);
    if (--alive === 0) process.exit(0);
  });
}
// Ctrl+C llega a todos los hijos (mismo grupo de procesos); aquí solo se espera a que terminen.
process.on("SIGINT", () => undefined);
