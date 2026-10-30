import { asAwakeMode, type MachineAwakeMode, strongerAwake } from "./awake.js";
import { findDeployTargets, git } from "./git.js";
import { t } from "./i18n.js";
import { readState, updateState } from "./paths.js";
import { guardById, guardFor } from "./workflow-guard.js";

// Lo que la skill /backcode:setup del plugin necesita para dejar un proyecto listo, sin leer la configuración (claves):
//   backcode deploys [--json] [--project <id>]   despliegues del proyecto en su rama principal (desde el repo o con --project)
//   backcode awake [off|plugged|always]          «Mantener el ordenador despierto» del panel (sin modo: el actual)

const flag = (args: string[], name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);

export interface DeployInfo {
  id: string;
  name: string;
  dir: string;
  provider: string | null;
  source: string;
}

/** Los despliegues de la rama principal (la del remoto si está, si no la local), sin comandos ni secretos. */
export async function listDeploys(opts: { dir?: string; projectId?: string }): Promise<DeployInfo[]> {
  const guard = opts.projectId ? guardById(opts.projectId) : guardFor(opts.dir ?? process.cwd());
  if (!guard) throw new Error(opts.projectId ? t("ready.unknownProject", { id: opts.projectId }) : t("task.notConnected", { dir: opts.dir ?? process.cwd() }));
  let commit = "";
  for (const ref of [`${guard.remote}/${guard.baseBranch}`, guard.baseBranch]) {
    commit = await git(guard.repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
    if (commit) break;
  }
  if (!commit) throw new Error(t("ready.noBase", { base: guard.baseBranch }));
  return (await findDeployTargets(guard.repoPath, commit)).map((d) => ({ id: d.id, name: d.name, dir: d.dir, provider: d.provider ?? null, source: d.source ?? "script" }));
}

export async function deploysMain(args: string[]): Promise<void> {
  try {
    const deploys = await listDeploys({ projectId: flag(args, "--project") });
    if (args.includes("--json")) console.log(JSON.stringify(deploys));
    else if (!deploys.length) console.log(t("ready.noDeploys"));
    else for (const d of deploys) console.log(`  ${d.name}  ${d.dir || "."}  ${d.provider ?? "-"}  (${d.source})`);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}

const MODES = ["off", "plugged", "always"] as const;

/** Cambia el modo del panel (el panel lo aplica en menos de un minuto) o, sin modo, dice el actual. */
export function awake(mode?: string): { mode: MachineAwakeMode; appMode: MachineAwakeMode; effective: MachineAwakeMode } {
  if (mode !== undefined) {
    if (!(MODES as readonly string[]).includes(mode)) throw new Error(t("ready.awakeBadMode", { mode }));
    updateState({ keepAwake: mode, keepAwakePlugged: undefined });
  }
  const s = readState();
  const panel = asAwakeMode(s.keepAwake ?? (s.keepAwakePlugged ? "plugged" : "off"));
  const app = asAwakeMode(s.appKeepAwake);
  return { mode: panel, appMode: app, effective: strongerAwake(panel, app) };
}

export function awakeMain(args: string[]): void {
  const mode = args.find((a) => !a.startsWith("--"));
  try {
    const r = awake(mode);
    if (args.includes("--json")) console.log(JSON.stringify(r));
    else console.log(t(mode ? "ready.awakeSet" : "ready.awakeIs", { mode: t(`ready.awake.${r.mode}`), app: t(`ready.awake.${r.appMode}`), effective: t(`ready.awake.${r.effective}`) }));
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(2);
  }
}
