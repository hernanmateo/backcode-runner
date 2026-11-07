// Pasos «Después de mergear» que declara Claude en open_pull_request (result.afterMerge): qué se le dice y qué se guarda.

/**
 * Destino reservado para «publicar la OTA» cuando el repo la publica desde Backcode: la app lo reconoce y ofrece su
 * «Publicar OTA» en vez de un paso manual (app/src/lib/after-merge.ts, OTA_TARGET).
 */
export const OTA_AFTER_MERGE_TARGET = "backcode:ota";

/** deployTarget válido: un backcode:deploy:<nombre> del repo o el destino reservado de la OTA. */
export const DEPLOY_TARGET_INPUT = /^(?:[a-z0-9][a-z0-9-]{0,39}|backcode:ota)$/;

/** Lo que se añade a la descripción de open_pull_request según lo que el repo ya hace desde la app. */
export function afterMergeHint(deployNames: readonly string[], backcodeOta: boolean): string {
  const deploys = deployNames.length ? ` This repo can run these deploy targets from the app (set deployTarget to the matching one instead of, or as well as, the command): ${deployNames.join(", ")}.` : "";
  const ota = backcodeOta
    ? ` This project publishes OTA updates (and native builds) from the Backcode app: do not list publishing an OTA (ota:publish, eas update…) or a native build as an afterMerge step, the app already offers «Publish OTA» and «Build». If you really need to mention it, use deployTarget "${OTA_AFTER_MERGE_TARGET}" with no command.`
    : "";
  return deploys + ota;
}

export interface AfterMergeStep {
  why: string;
  command?: string;
  deployTarget?: string;
}

/**
 * Pasos que se guardan: solo destinos que el repo declara de verdad (la app no ejecuta nada que el repo no ofrezca) y el
 * de la OTA solo si el repo la publica desde Backcode.
 */
export function normalizeAfterMerge(steps: AfterMergeStep[] | undefined, deployNames: readonly string[], backcodeOta: boolean): AfterMergeStep[] | undefined {
  return steps?.map((s) => {
    const ok = s.deployTarget === OTA_AFTER_MERGE_TARGET ? backcodeOta : !!s.deployTarget && deployNames.includes(s.deployTarget);
    return { why: s.why, ...(s.command ? { command: s.command } : {}), ...(ok ? { deployTarget: s.deployTarget } : {}) };
  });
}
