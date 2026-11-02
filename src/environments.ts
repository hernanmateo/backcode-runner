import { channelOfTarget } from "./deploy-tasks.js";

/**
 * Entornos preview y production de un proyecto (opcional). Sin «rama de preview» en el proyecto todo va a la rama base
 * (main), como siempre. Con ella (p. ej. `develop`): las tareas salen de esa rama y abren su PR contra ella, lo de preview
 * (OTA preview, destinos de staging, builds para testers) se publica desde ella y lo de production desde la rama base.
 * «Promocionar a producción» abre la PR de la rama de preview a la base y «Sincronizar» devuelve la base a la de preview.
 */

export type Channel = "preview" | "production";

/** Lo que vale una rama de preview (las reglas de Firestore validan lo mismo): ni la principal ni una de tarea. */
export function validPreviewBranch(name: unknown, baseBranch: string): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9._/-]{1,100}$/.test(name) &&
    !["main", "master", "HEAD", baseBranch].includes(name) &&
    !name.startsWith("backcode/") &&
    !name.startsWith("-") &&
    !name.includes("..")
  );
}

// Rama de preview vigente (la sigue index.ts desde el proyecto; solo cuenta si existe en el remoto).
let preview: string | undefined;
export function setPreviewBranch(name: string | undefined): void {
  preview = name;
}
export function previewBranch(): string | undefined {
  return preview;
}

/** Rama de la que salen las tareas y contra la que abren su PR. */
export function taskBase(baseBranch: string, previewName: string | undefined = preview): string {
  return previewName ?? baseBranch;
}

/** Rama que se publica en cada canal: preview → la de preview (si hay); production → la base. */
export function branchForChannel(baseBranch: string, channel: Channel, previewName: string | undefined = preview): string {
  return channel === "preview" ? (previewName ?? baseBranch) : baseBranch;
}

/**
 * Rama de un destino de despliegue (`<carpeta>#<nombre>`): los de staging/preview (channelOfTarget) salen de la de preview;
 * los de production y los que no se sabe a qué entorno van (reglas, functions…) salen de la base.
 */
export function branchForTarget(baseBranch: string, targetId: string, others: string[] = [], previewName: string | undefined = preview): string {
  return channelOfTarget(targetId, others) === "preview" ? branchForChannel(baseBranch, "preview", previewName) : baseBranch;
}

/** ¿Es la PR de promoción (de la rama de preview a la base)? Esa se mergea con merge commit y sin borrar la rama. */
export function isPromotionPr(pr: { branch: string; base: string }, baseBranch: string, previewName: string | undefined = preview): boolean {
  return !!previewName && pr.branch === previewName && pr.base === baseBranch;
}

/** Ramas que nunca se borran al cerrar un PR (la base y la de preview). */
export function protectedBranch(branch: string, baseBranch: string, previewName: string | undefined = preview): boolean {
  return branch === baseBranch || (!!previewName && branch === previewName);
}

export const MAX_PROMOTION_FEATURES = 50;

/** Título y cuerpo de la PR «Promocionar a producción», con las tareas que entran. */
export function promotionPr(
  features: { id: string; title: string }[],
  commits: number,
  from: string,
  to: string,
  footer: string,
): { title: string; body: string } {
  const title = `Promocionar a producción: ${from} → ${to} (${features.length || commits} ${features.length === 1 || (!features.length && commits === 1) ? "cambio" : "cambios"})`;
  const list = features.slice(0, MAX_PROMOTION_FEATURES).map((f) => `- ${f.title.replaceAll(/[\r\n]+/g, " ").slice(0, 120)} (\`${f.id}\`)`);
  const more = features.length > MAX_PROMOTION_FEATURES ? [`- … y ${features.length - MAX_PROMOTION_FEATURES} más`] : [];
  const body = [
    `Lleva a \`${to}\` lo que ya está en \`${from}\` (preview): ${commits} ${commits === 1 ? "commit" : "commits"}.`,
    "",
    "## Tareas que entran",
    ...(list.length ? [...list, ...more] : ["- (ninguna tarea de Backcode: solo commits sueltos)"]),
    "",
    `> Mergéala con **merge commit** (no squash) y sin borrar \`${from}\`: así las tareas pasan solas a «Pendiente de desplegar» en production. Desde la app de Backcode ya se hace así.`,
    "",
    "---",
    footer,
  ].join("\n");
  return { title, body };
}

/**
 * Cómo se lleva la base a la rama de preview: nada que hacer, fast-forward (la de preview no tiene nada propio) o merge
 * (las dos tienen commits propios: p. ej. un hotfix directo a la base con cosas aún sin promocionar).
 */
export function syncMode(behind: number, ahead: number): "uptodate" | "fast-forward" | "merge" {
  if (behind === 0) return "uptodate";
  return ahead === 0 ? "fast-forward" : "merge";
}
