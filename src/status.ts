import { VERSION, UPDATE_MODE } from "./autoupdate.js";
import { t } from "./i18n.js";
import { panelAlive } from "./panel-client.js";
import { CONFIG_DIR, IS_BINARY, projectFiles, readState } from "./paths.js";
import { installedClaude, machineReport } from "./preflight.js";
import { pluginInRepos, pluginInstalls } from "./plugin.js";
import { serviceInstalled } from "./service.js";
import { valueIn } from "./setup.js";
import { readFileSync } from "node:fs";

// `backcode status`: todo de un vistazo, en texto (lo usa el plugin de Claude Code para saber qué falta). Nunca enseña
// llaves ni tokens: de cada proyecto, solo id, nombre, carpeta y dónde abre los PR.

const mark = { ok: "✓", warn: "⚠", fail: "✗" } as const;
const names = readState().names ?? {};
console.log(`Backcode runner ${VERSION} (${IS_BINARY ? "executable" : "npm"}, updates: ${UPDATE_MODE})`);
console.log(`${t("status.service")}: ${serviceInstalled() ? t("status.on") : t("status.off")} · ${t("status.panel")}: ${(await panelAlive()) ? "http://127.0.0.1:47474" : t("status.off")}`);
console.log(`\n${t("status.machine")}`);
for (const c of await machineReport()) console.log(`  ${mark[c.status]} ${c.id}: ${c.detail}${c.status !== "ok" && c.fix ? `  →  ${c.fix}` : ""}`);
const projects = projectFiles();
// El plugin de Claude Code en el repo de cada proyecto: activado para el equipo, solo para ti o no activo.
const claude = installedClaude();
const installs = claude ? await pluginInstalls(claude) : null;
const repoPaths = projects.flatMap((p) => valueIn(readFileSync(p.file, "utf8"), "BACKCODE_REPO_PATH") ?? []);
const plugins = claude && installs ? await pluginInRepos(claude, installs, repoPaths) : {};
console.log(`\n${t("status.projects", { n: projects.length, dir: CONFIG_DIR })}`);
for (const p of projects) {
  const text = readFileSync(p.file, "utf8");
  const name = valueIn(text, "BACKCODE_PROJECT_NAME") ?? names[p.id] ?? p.id;
  const stopped = (readState().stopped ?? []).includes(p.id) ? ` (${t("status.stoppedInPanel")})` : "";
  const repo = valueIn(text, "BACKCODE_REPO_PATH");
  const plugin = repo && plugins[repo] ? ` · ${t(`ui.plugin.${plugins[repo]}`)}` : "";
  console.log(`  · ${name} [${p.id}] ${repo ?? "?"} · ${valueIn(text, "BACKCODE_PULL_REQUEST") ?? "github"}${plugin}${stopped}`);
}
