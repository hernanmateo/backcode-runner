import { httpsCallable, type Functions } from "firebase/functions";
import { latestPublished, newer, UPDATE_MODE, VERSION } from "./autoupdate.js";
import { lang } from "./i18n.js";
import { olderThan, PLUGIN_VERSION, pluginInstalls } from "./plugin.js";
import { installedClaude } from "./preflight.js";

// Push al móvil y a la web cuando hay versión nueva del runner o el plugin de Claude Code instalado es más antiguo que el
// que trae este runner. Lo envía la Function reportUpdate, que avisa una sola vez por versión aunque haya varios runners.

/** Cada cuánto se mira (una consulta al registro y `claude plugin list`). */
export const UPDATE_NOTICE_EVERY_MS = 30 * 60_000;

export type UpdateReport = {
  runner?: { current: string; latest: string; auto: boolean };
  plugin?: { installed: string; latest: string };
};

/** Qué hay que avisar con lo que se sabe; null si todo está al día. El plugin, por la instalación más antigua. */
export function updateReport(latest: string | undefined, plugins: { version: string }[] | null, current = VERSION, auto = UPDATE_MODE !== "manual"): UpdateReport | null {
  const report: UpdateReport = {};
  if (latest && newer(latest, current)) report.runner = { current, latest, auto };
  const oldest = (plugins ?? []).map((p) => p.version).sort((a, b) => (olderThan(a, b) ? -1 : 1))[0];
  if (oldest && olderThan(oldest, PLUGIN_VERSION)) report.plugin = { installed: oldest, latest: PLUGIN_VERSION };
  return report.runner || report.plugin ? report : null;
}

let reported = "";

/** Mira si hay algo que avisar y, si es nuevo para este proceso, se lo pasa a reportUpdate. Nunca falla. */
export async function reportUpdates(fns: Functions, projectId: string): Promise<void> {
  try {
    const claude = installedClaude();
    const report = updateReport(await latestPublished(), claude ? await pluginInstalls(claude) : null);
    const key = JSON.stringify(report);
    if (!report || key === reported) return;
    await httpsCallable(fns, "reportUpdate")({ projectId, ...report, lang: lang() });
    reported = key;
  } catch (err) {
    console.warn(`[update] ${(err as Error).message}`);
  }
}
