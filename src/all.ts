import { t } from "./i18n.js";
import { Supervisor } from "./supervisor.js";

// `npm run all` / `backcode start`: un runner por cada proyecto conectado (~/.backcode/config/<proyecto>.env, creados con
// `backcode connect`), todos a la vez y en esta terminal. Cada línea de log lleva delante el proyecto. Con proyectos
// como argumentos (`backcode start web api`), solo esos. Ctrl+C los para a todos limpiamente.

const COLORS = [36, 35, 33, 32, 34, 31];
const only = process.argv.slice(2).filter((a) => !a.startsWith("-") && a !== "start");
const tags = new Map<string, string>();
const supervisor = new Supervisor((p, line) => {
  if (!tags.has(p.id)) tags.set(p.id, `\x1b[${COLORS[tags.size % COLORS.length]}m[${p.id}]\x1b[0m`);
  console.log(`${tags.get(p.id)} ${line}`);
});
const ids = only.length ? only : [...supervisor.projects.keys()];
const unknown = ids.filter((id) => !supervisor.projects.has(id));
if (unknown.length) {
  console.error(t("all.unknown", { list: unknown.join(", ") }));
  process.exit(1);
}
if (ids.length === 0) {
  console.error(t("all.none"));
  process.exit(1);
}

console.log(`${t("all.starting", { n: ids.length, list: ids.join(", ") })}\n`);
// En la terminal se arrancan siempre (también los que se pararon desde el panel).
for (const id of ids) supervisor.start(id);
supervisor.watchUpdates();
supervisor.watchNewProjects();
const done = setInterval(() => {
  if ([...supervisor.projects.values()].every((p) => !p.child && p.state !== "retrying")) {
    clearInterval(done);
    process.exit(0);
  }
}, 1000);
// Ctrl+C llega a todos los hijos (mismo grupo de procesos); aquí solo se espera a que terminen.
process.on("SIGINT", () => {
  for (const p of supervisor.projects.values()) if (p.state === "retrying") p.state = "stopped";
});
