import { spawn, type ChildProcess } from "node:child_process";
import { RESTART_CODE, UPDATE_EVERY_MS, updateIfAvailable } from "./autoupdate.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { KIT_DIR } from "./config.js";
import { t } from "./i18n.js";

// `npm run all`: un runner por cada proyecto configurado (.env.<proyecto> creados con `npm run connect`),
// todos a la vez. Cada línea de log lleva delante el proyecto. Ctrl+C los para a todos limpiamente.

const COLORS = [36, 35, 33, 32, 34, 31];
const files = readdirSync(KIT_DIR).filter((f) => /^\.env\.[A-Za-z0-9_-]+$/.test(f) && f !== ".env.example");
if (files.length === 0) {
  console.error(t("all.none"));
  process.exit(1);
}

console.log(`${t("all.starting", { n: files.length, list: files.map((f) => f.slice(5)).join(", ") })}\n`);
let alive = files.length;
const children = new Map<string, ChildProcess>();
const launch = (file: string, i: number) => {
  const projectId = /BACKCODE_PROJECT_ID=(.+)/.exec(readFileSync(join(KIT_DIR, file), "utf8"))?.[1]?.trim() ?? file.slice(5);
  const tag = `\x1b[${COLORS[i % COLORS.length]}m[${projectId}]\x1b[0m`;
  // BACKCODE_SUPERVISED: la actualización la gestiona este proceso; el runner, al recibir SIGUSR2, termina lo que tenga
  // en marcha y sale con RESTART_CODE para que aquí se vuelva a lanzar con el código nuevo.
  const child = spawn(process.execPath, [join(KIT_DIR, "dist", "index.js"), "--env", file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BACKCODE_SUPERVISED: "1" } });
  children.set(file, child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => console.log(`${tag} ${line}`));
  }
  child.on("exit", (code) => {
    if (code === RESTART_CODE) return launch(file, i);
    children.delete(file);
    console.log(`${tag} ${t("all.exited", { code: code ?? 0 })}`);
    if (--alive === 0) process.exit(0);
  });
};
files.forEach(launch);

// Actualización automática (una sola vez para todos): con versión nueva lista, cada runner se reinicia al quedar libre.
let updating = false;
const checkUpdate = async () => {
  if (updating) return;
  updating = true;
  try {
    if (await updateIfAvailable()) for (const child of children.values()) child.kill("SIGUSR2");
  } catch {
    // sin red o git no disponible: se vuelve a intentar en la próxima comprobación
  } finally {
    updating = false;
  }
};
setInterval(() => void checkUpdate(), UPDATE_EVERY_MS);
setTimeout(() => void checkUpdate(), 15_000);
// Ctrl+C llega a todos los hijos (mismo grupo de procesos); aquí solo se espera a que terminen.
process.on("SIGINT", () => undefined);
