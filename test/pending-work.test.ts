import assert from "node:assert/strict";
import { test } from "node:test";
import { DECLARE_PENDING_PROMPT, FOLLOW_UPS_DESCRIPTION, followUpPrompt, markAfterMergeFollowUps, mentionsPendingWork, normalizeFollowUps, parseFollowUp, type FollowUpInput } from "../src/follow-ups.js";

const f = (title: string, kind: FollowUpInput["kind"], extra: Partial<FollowUpInput> = {}): FollowUpInput => ({
  title,
  kind,
  prompt: `Haz ${title} con su test y su documentación.`,
  why: "Queda a medias sin esto",
  ...extra,
});

test("normalizeFollowUps: conserva stage y las antiguas sin él siguen igual", () => {
  const out = normalizeFollowUps([f("Generar las fotos", "required", { stage: "beforeMerge", blocker: "permission", needs: "red a api.panoramax.xyz" }), f("Pulir la tarjeta", "refine")])!;
  assert.equal(out[0].stage, "beforeMerge");
  assert.equal("stage" in out[1], false);
  assert.equal(parseFollowUp(f("Vieja tarea", "refine"))?.stage, undefined);
  assert.equal(parseFollowUp({ ...f("Mala etapa", "refine"), stage: "later" }), undefined);
});

test("markAfterMergeFollowUps: la que contiene todos los comandos de afterMerge queda integrada", () => {
  const steps = [{ why: "Datos", command: "bun run data" }, { why: "V2", command: "bun   run data:v2" }, { why: "Publicar", command: "bun run data:publish" }];
  const same = { ...f("Regenerar datos y publicar fronteras", "required", { blocker: "secret", needs: "red y credenciales R2" }), prompt: "Ejecuta `bun run data`, `bun run data:v2` y luego `bun run data:publish`." };
  const partial = { ...f("Solo los datos", "required"), prompt: "Ejecuta bun run data y bun run data:v2 con red." };
  const out = markAfterMergeFollowUps(normalizeFollowUps([same, partial, f("Pulir la tarjeta", "refine")]), steps)!;
  assert.equal(out.find((x) => x.title.startsWith("Regenerar"))?.stage, "afterMerge");
  assert.equal(out.find((x) => x.title === "Solo los datos")?.stage, undefined);
  assert.equal(out.find((x) => x.title === "Pulir la tarjeta")?.stage, undefined);
});

test("markAfterMergeFollowUps: sin comandos no marca nada y respeta el stage que puso Claude", () => {
  const list = normalizeFollowUps([f("Algo concreto", "required", { stage: "beforeMerge" }), f("Otra cosa", "refine")])!;
  assert.deepEqual(markAfterMergeFollowUps(list, [{ why: "Desplegar" }]), list);
  assert.deepEqual(markAfterMergeFollowUps(list, undefined), list);
  const marked = markAfterMergeFollowUps(list, [{ why: "x", command: "Haz Algo concreto" }])!;
  assert.equal(marked[0].stage, "beforeMerge");
  assert.equal(markAfterMergeFollowUps(undefined, [{ why: "x", command: "y" }]), undefined);
});

test("mentionsPendingWork: detecta pendientes en prosa (ca/es/en) y no en un resumen sin nada", () => {
  assert.equal(mentionsPendingWork("Tasques pendents per al vostre Claude Code (a la branca del #117): executar `bun run data:photos`."), true);
  assert.equal(mentionsPendingWork("Después de fusionar: `firebase deploy --only functions`."), true);
  assert.equal(mentionsPendingWork("You need to run `bun install` with network access."), true);
  assert.equal(mentionsPendingWork("No he pogut executar els tests: necessiten xarxa."), true);
  assert.equal(mentionsPendingWork("He afegit el botó i els seus tests; typecheck i lint en verd."), false);
  assert.equal(mentionsPendingWork(undefined), false);
});

test("followUpPrompt: beforeMerge trabaja en la rama del PR y no abre otro", () => {
  const fu = normalizeFollowUps([f("Generar las fotos", "required", { stage: "beforeMerge", blocker: "permission", needs: "red a api.panoramax.xyz" })])![0];
  const p = followUpPrompt(fu, { title: "Fotos", prUrl: "https://github.com/o/r/pull/117", branch: "backcode/x", base: "main" });
  assert.match(p, /backcode\/x/);
  assert.match(p, /pull\/117/);
  assert.match(p, /Don't open a new pull request/);
  assert.match(p, /api\.panoramax\.xyz/);
});

test("instrucciones: todo lo pendiente estructurado y sin repetir afterMerge", () => {
  assert.match(FOLLOW_UPS_DESCRIPTION, /never only in prose/);
  assert.match(FOLLOW_UPS_DESCRIPTION, /stage "beforeMerge"/);
  assert.match(FOLLOW_UPS_DESCRIPTION, /only runs the afterMerge steps/);
  assert.match(DECLARE_PENDING_PROMPT, /declare_pending_work/);
  assert.match(DECLARE_PENDING_PROMPT, /Nothing pending/);
});
