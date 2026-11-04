import { z } from "zod";

// Siguientes tareas que propone Claude al abrir el PR (open_pull_request › followUps): trabajo nuevo, con su propio PR,
// que la app ofrece crear en el backlog cuando el PR está listo. No son los pasos a mano de este PR (afterMerge).
// - kind: "required" si algo queda a medias o roto sin ella; "refine" si es una mejora recomendable.
// - blocker: Claude no la pudo hacer en esta tarea porque necesita un permiso que no tiene, un secreto/key (que el runner
//   nunca lee) o algo externo (un login interactivo, una consola de terceros…). La app ofrece seguir en el Claude Code de
//   la persona (escritorio, claude.ai o terminal), donde ella pone la key sin que pase por el chat ni por Firestore.
// - needs: qué falta, sin el valor (p. ej. «STRIPE_SECRET_KEY en el entorno de functions»).

export const FOLLOW_UP_KINDS = ["required", "refine"] as const;
export const FOLLOW_UP_BLOCKERS = ["permission", "secret", "external"] as const;
export const FOLLOW_UPS_MAX = 5;

export const FOLLOW_UP_INPUT = z.object({
  title: z.string().min(5).max(120),
  prompt: z.string().min(20).max(4000),
  kind: z.enum(FOLLOW_UP_KINDS),
  why: z.string().min(3).max(300),
  blocker: z.enum(FOLLOW_UP_BLOCKERS).optional(),
  needs: z.string().min(3).max(300).optional(),
});

export type FollowUpInput = z.infer<typeof FOLLOW_UP_INPUT>;

export interface FollowUp {
  title: string;
  prompt: string;
  kind: (typeof FOLLOW_UP_KINDS)[number];
  why: string;
  blocker?: (typeof FOLLOW_UP_BLOCKERS)[number];
  needs?: string;
}

export const FOLLOW_UPS_DESCRIPTION = `Optionally, in followUps, propose the next tasks this work leads to (at most ${FOLLOW_UPS_MAX}): new work that deserves its own pull request, not steps of this one (those go in afterMerge). kind "required" when something stays incomplete or broken without it; "refine" for an improvement you would genuinely recommend (not obvious nice-to-haves). Each prompt must be self-contained (the new task won't see this session). If you could not do something here because it needs a permission you don't have (ask for it first with request_permission), a secret or key, or something external (an interactive login, a third-party console…), propose it with blocker and say in needs what is missing, never its value. Don't propose what you already did or what the user asked to leave out.`;

/** Limpia lo que propone Claude: sin repetidos (por título), las necesarias primero y como mucho FOLLOW_UPS_MAX. */
export function normalizeFollowUps(input: FollowUpInput[] | undefined): FollowUp[] | undefined {
  if (!input?.length) return undefined;
  const seen = new Set<string>();
  const out: FollowUp[] = [];
  for (const f of input) {
    const title = f.title.trim();
    const prompt = f.prompt.trim();
    const why = f.why.trim();
    const key = title.toLowerCase().replace(/\s+/g, " ");
    if (!title || !prompt || !why || seen.has(key)) continue;
    seen.add(key);
    const needs = f.needs?.trim();
    out.push({ title, prompt, kind: f.kind, why, ...(f.blocker ? { blocker: f.blocker } : {}), ...(f.blocker && needs ? { needs } : {}) });
  }
  out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "required" ? -1 : 1));
  return out.length ? out.slice(0, FOLLOW_UPS_MAX) : undefined;
}
