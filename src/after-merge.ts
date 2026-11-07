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
  checks: readonly CheckCommand[] = [],
): AfterMergeStep[] | undefined {
  // Un check del proyecto no es un paso tras mergear: el runner lo pasa antes de mergear (red de seguridad del prompt).
  return steps?.filter((s) => s.deployTarget || !s.command || !isCheckStep(s.command, checks)).map((s) => {
    const inBase =
      s.deployTarget === OTA_AFTER_MERGE_TARGET ? backcodeOta : s.deployTarget === BUILD_AFTER_MERGE_TARGET ? backcodeBuild : !!s.deployTarget && deployNames.includes(s.deployTarget);
    const inPr = !inBase && !!s.deployTarget && !RESERVED.has(s.deployTarget) && prNames.includes(s.deployTarget);
    return { why: s.why, ...(s.command ? { command: s.command } : {}), ...(inBase || inPr ? { deployTarget: s.deployTarget } : {}), ...(inPr ? { pendingMerge: true } : {}) };
  });
}

/** Un `[check.<nombre>]` del backcode.toml de la rama base, tal como se le cuenta a Claude: carpeta y comando. */
export interface CheckCommand {
  name: string;
  /** Carpeta relativa al repo ("" = raíz). */
  dir: string;
  run: string;
}

/** El comando de un check como texto (local-checks.ts guarda `sh -c "<run>"` o la lista sin shell). */
export function checkRunText(cmd: readonly string[]): string {
  return cmd[0] === "sh" && cmd[1] === "-c" && cmd.length === 3 ? cmd[2] : cmd.join(" ");
}

/**
 * Lo que se añade a open_pull_request: los checks que el runner pasa antes de mergear y que, por tanto, nunca son un paso
 * tras mergear (los que no se pudieron ejecutar en el sandbox se cuentan en el PR o se piden con run_checks).
 */
export function checksHint(checks: readonly CheckCommand[], runChecks: boolean): string {
  if (!checks.length) return "";
  const list = checks.map((c) => `${c.name} (${c.dir || "."}: ${c.run})`).join("; ");
  const how = runChecks ? " If you couldn't run one of them in the sandbox, call run_checks before this tool and fix what fails; if you still couldn't verify something, say it" : " If you couldn't run one of them in the sandbox, say it";
  return ` The runner runs this project's checks itself before merging: ${list}. Never list running tests or these checks as an afterMerge step.${how} in the body's "How it was tested" section.`;
}

const norm = (cmd: string) => cmd.trim().replace(/\s+/g, " ");
const normDir = (dir: string) => dir.trim().replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\.$/, "");
/** Partes de un comando separadas por &&, ; o saltos de línea (sin entrar en comillas: ante la duda, no coincide). */
const segments = (cmd: string) =>
  cmd
    .split(/&&|;|\n/)
    .map((p) => norm(p).replace(/^\(+|\)+$/g, "").trim())
    .filter(Boolean)
    // `npm test` y `npm run test` son lo mismo (y con pnpm o yarn).
    .map((p) => p.replace(/^(npm|pnpm|yarn) test\b/, "$1 run test"));
/** Instalar dependencias antes del test: los checks ya lo hacen, no cambia lo que se comprueba. */
const INSTALL = /^(npm (ci|install|i)|pnpm (install|i)|yarn( install)?|bun (install|i))( --?[\w-]+(=\S+)?)*$/;

/**
 * ¿Este paso tras mergear solo ejecuta checks del proyecto? Conservador: cada parte del comando (salvo instalar
 * dependencias) tiene que ser una parte del comando de algún check de la misma carpeta (`cd <carpeta> && …` o la raíz).
 * Así «cd tests && npm run test:rules» cae si [check.tests] (dir = "tests") ejecuta «npm run test:unit && npm run
 * test:rules», pero «npm run test:e2e», que ningún check ejecuta, se queda como paso.
 */
export function isCheckStep(command: string, checks: readonly CheckCommand[]): boolean {
  if (!checks.length) return false;
  let rest = norm(command).replace(/^\((.*)\)$/, "$1").trim();
  let dir = "";
  const cd = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/.exec(rest);
  if (cd) {
    dir = normDir(cd[1].replace(/^["']|["']$/g, ""));
    rest = cd[2];
  }
  if (/[|`$<>]/.test(rest) || /\bcd\b/.test(rest)) return false;
  const parts = segments(rest).filter((p) => !INSTALL.test(p));
  if (!parts.length) return false;
  return checks.some((c) => {
    if (normDir(c.dir) !== dir) return false;
    const own = new Set(segments(c.run));
    return parts.every((p) => own.has(p));
  });
}
