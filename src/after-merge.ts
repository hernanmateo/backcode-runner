// Pasos «Después de mergear» que declara Claude en open_pull_request (result.afterMerge): qué se le dice y qué se guarda.

/**
 * Destino reservado para «publicar la OTA» cuando el repo la publica desde Backcode: la app lo reconoce y ofrece su
 * «Publicar OTA» en vez de un paso manual (app/src/lib/after-merge.ts, OTA_TARGET).
 */
export const OTA_AFTER_MERGE_TARGET = "backcode:ota";

/**
 * Destino reservado para «sacar una build nativa» cuando el repo hace builds desde Backcode (perfil `production` de EAS):
 * la app lo reconoce y ofrece su «Build» en vez de un paso manual (app/src/lib/after-merge.ts, BUILD_TARGET).
 */
export const BUILD_AFTER_MERGE_TARGET = "backcode:build";

/** deployTarget válido: un backcode:deploy:<nombre> del repo o uno de los destinos reservados (OTA, build). */
export const DEPLOY_TARGET_INPUT = /^(?:[a-z0-9][a-z0-9-]{0,39}|backcode:ota|backcode:build)$/;

/**
 * Operación con privilegios que se repetirá (refrescar datos, una tarea contra un servidor…): mejor un comando declarado en
 * el repo, que el runner ejecuta con un botón tras mergear, que un paso o una siguiente tarea a mano.
 */
export const REPEATABLE_HINT =
  ' If the work needs a privileged operation that will be run again (refreshing data, a job against a server, a backfill…), write the script, declare it in this same pull request as a [deploy.<name>] entry in backcode.toml (run = "<the script>", paths = [] so it only runs when someone asks; no secrets in it) and set the afterMerge step\'s deployTarget to that name: once merged, the app offers a button to run it with the runner, instead of a manual step or a follow-up.';

/** Lo que se añade a la descripción de open_pull_request según lo que el repo ya hace desde la app. */
export function afterMergeHint(deployNames: readonly string[], backcodeOta: boolean, backcodeBuild = false): string {
  const deploys = deployNames.length ? ` This repo can run these deploy targets from the app (set deployTarget to the matching one instead of, or as well as, the command): ${deployNames.join(", ")}.` : "";
  const ota = backcodeOta
    ? ` This project publishes OTA updates from the Backcode app: do not list publishing an OTA (ota:publish, eas update…) as an afterMerge step with a command, the app already offers «Publish OTA». If it must be mentioned, use deployTarget "${OTA_AFTER_MERGE_TARGET}" with no command.`
    : "";
  const build = backcodeBuild
    ? ` This project makes native builds (EAS, for TestFlight / internal testing) from the Backcode app: if the change needs a new native build (native code, a new native dependency, app.json native config…), don't give an eas build command as an afterMerge step; add one step with deployTarget "${BUILD_AFTER_MERGE_TARGET}", no command, and say in why which platforms need it. The app offers its «Build» button there.`
    : "";
  return deploys + REPEATABLE_HINT + ota + build;
}

export interface AfterMergeStep {
  why: string;
  command?: string;
  deployTarget?: string;
  /** El destino lo declara este mismo PR (aún no está en la rama principal): la app ofrece el botón cuando se mergea. */
  pendingMerge?: boolean;
}

const RESERVED = new Set([OTA_AFTER_MERGE_TARGET, BUILD_AFTER_MERGE_TARGET]);

/**
 * Pasos que se guardan: solo destinos que el repo declara de verdad (la app no ejecuta nada que el repo no ofrezca), el
 * de la OTA solo si el repo la publica desde Backcode y el de la build solo si hace builds desde Backcode. `prNames`: los
 * que declara la rama del PR; los que no están en la principal (`deployNames`) se guardan con `pendingMerge` y el botón
 * sale cuando el runner los ve en la principal.
 */
export function normalizeAfterMerge(
  steps: Omit<AfterMergeStep, "pendingMerge">[] | undefined,
  deployNames: readonly string[],
  backcodeOta: boolean,
  prNames: readonly string[] = [],
  backcodeBuild = false,
): AfterMergeStep[] | undefined {
  return steps?.map((s) => {
    const inBase =
      s.deployTarget === OTA_AFTER_MERGE_TARGET ? backcodeOta : s.deployTarget === BUILD_AFTER_MERGE_TARGET ? backcodeBuild : !!s.deployTarget && deployNames.includes(s.deployTarget);
    const inPr = !inBase && !!s.deployTarget && !RESERVED.has(s.deployTarget) && prNames.includes(s.deployTarget);
    return { why: s.why, ...(s.command ? { command: s.command } : {}), ...(inBase || inPr ? { deployTarget: s.deployTarget } : {}), ...(inPr ? { pendingMerge: true } : {}) };
  });
}
