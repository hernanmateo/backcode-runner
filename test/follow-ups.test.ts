import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_UP_INPUT, FOLLOW_UPS_MAX, followUpPrompt, mergeFollowUps, normalizeFollowUps, parseFollowUp, PLAN_LOCAL_INPUT, PLAN_LOCAL_MAX, planLocalFollowUps, planLocalMarkdown, type FollowUpInput, type PlanLocalInput } from "../src/follow-ups.js";

const f = (title: string, kind: FollowUpInput["kind"], extra: Partial<FollowUpInput> = {}): FollowUpInput => ({
  title,
  kind,
  prompt: `Haz ${title} con su test y su documentación.`,
  why: "Queda a medias sin esto",
  ...extra,
});

test("normalizeFollowUps: nada propuesto = nada guardado", () => {
  assert.equal(normalizeFollowUps(undefined), undefined);
  assert.equal(normalizeFollowUps([]), undefined);
});

test("normalizeFollowUps: quita repetidos por título, las necesarias primero y como mucho el máximo", () => {
  const out = normalizeFollowUps([
    f("Pulir la tarjeta", "refine"),
    f("Mostrar en la app", "required"),
    f("  mostrar   en la APP ", "required"),
    ...Array.from({ length: 8 }, (_, i) => f(`Mejora número ${i}`, "refine")),
  ])!;
  assert.equal(out.length, FOLLOW_UPS_MAX);
  assert.equal(out[0].title, "Mostrar en la app");
  assert.equal(out[1].title, "Pulir la tarjeta");
  assert.equal(out.filter((x) => x.title.toLowerCase().includes("mostrar")).length, 1);
});

test("normalizeFollowUps: needs solo con un bloqueo", () => {
  const [a, b] = normalizeFollowUps([
    f("Cobrar con Stripe", "required", { blocker: "secret", needs: " STRIPE_SECRET_KEY en functions " }),
    f("Renombrar el botón", "refine", { needs: "nada" }),
  ])!;
  assert.deepEqual({ blocker: a.blocker, needs: a.needs }, { blocker: "secret", needs: "STRIPE_SECRET_KEY en functions" });
  assert.equal("blocker" in b, false);
  assert.equal("needs" in b, false);
});

test("FOLLOW_UP_INPUT: rechaza tipos y bloqueos desconocidos", () => {
  assert.equal(FOLLOW_UP_INPUT.safeParse(f("Algo correcto", "required")).success, true);
  assert.equal(FOLLOW_UP_INPUT.safeParse({ ...f("Algo correcto", "required"), kind: "maybe" }).success, false);
  assert.equal(FOLLOW_UP_INPUT.safeParse({ ...f("Algo correcto", "required"), blocker: "root" }).success, false);
});

test("parseFollowUp: solo lo que tiene la forma que guarda el runner", () => {
  assert.equal(parseFollowUp(undefined), undefined);
  assert.equal(parseFollowUp({ title: "x" }), undefined);
  assert.deepEqual(parseFollowUp({ ...f(" Cobrar con Stripe ", "required"), blocker: "secret", needs: "STRIPE_SECRET_KEY" }), {
    title: "Cobrar con Stripe",
    prompt: "Haz  Cobrar con Stripe  con su test y su documentación.",
    kind: "required",
    why: "Queda a medias sin esto",
    blocker: "secret",
    needs: "STRIPE_SECRET_KEY",
  });
});

test("followUpPrompt: de dónde sale, qué le falta, la rama y las reglas de los secretos", () => {
  const p = followUpPrompt({ ...f("Cobrar con Stripe", "required"), blocker: "secret", needs: "STRIPE_SECRET_KEY en functions" }, { title: "Checkout", prUrl: "https://github.com/x/y/pull/9", branch: "backcode/me/abc", base: "origin/main" });
  assert.match(p, /pull request of «Checkout» \(https:\/\/github.com\/x\/y\/pull\/9\)/);
  assert.match(p, /key or secret.*: STRIPE_SECRET_KEY en functions\./);
  assert.match(p, /backcode\/me\/abc, from origin\/main/);
  assert.match(p, /never print, log or commit their values/);
  assert.match(p, /backcode task pr/);
  assert.match(p, /<follow_up>\nCobrar con Stripe\n\nHaz Cobrar con Stripe/);
});

// --- Partes del plan para tu Claude Code (propose_plan › runsLocally) ---

const local = (title: string, extra: Partial<PlanLocalInput> = {}): PlanLocalInput => ({
  title,
  prompt: `Ejecuta ${title} desde tu ordenador con tus claves.`,
  why: "Necesita SSH y crear un servidor",
  blocker: "external",
  needs: "clave SSH y token de Hetzner",
  ...extra,
});

test("planLocalFollowUps: siguientes tareas necesarias, del plan, con su bloqueo y como mucho el máximo", () => {
  assert.equal(planLocalFollowUps(undefined), undefined);
  assert.equal(planLocalFollowUps([]), undefined);
  const out = planLocalFollowUps(Array.from({ length: 5 }, (_, i) => local(`Lanzar la extracción ${i}`)))!;
  assert.equal(out.length, PLAN_LOCAL_MAX);
  for (const x of out) assert.deepEqual({ kind: x.kind, blocker: x.blocker, fromPlan: x.fromPlan }, { kind: "required", blocker: "external", fromPlan: true });
  assert.equal(out[0].needs, "clave SSH y token de Hetzner");
});

test("PLAN_LOCAL_INPUT: solo secret o external, y needs obligatorio", () => {
  assert.equal(PLAN_LOCAL_INPUT.safeParse(local("Subir los datos a R2")).success, true);
  assert.equal(PLAN_LOCAL_INPUT.safeParse(local("Subir los datos a R2", { blocker: "permission" as never })).success, false);
  const { needs: _n, ...noNeeds } = local("Subir los datos a R2");
  assert.equal(PLAN_LOCAL_INPUT.safeParse(noNeeds).success, false);
});

test("mergeFollowUps: las del plan se quedan las primeras y las nuevas sustituyen a las otras de antes", () => {
  const planned = planLocalFollowUps([local("Lanzar la extracción")])!;
  const before = [...planned, ...normalizeFollowUps([f("Vieja mejora", "refine")])!];
  // Sin propuesta nueva: se queda todo lo de antes.
  assert.deepEqual(mergeFollowUps(before, undefined), before);
  assert.equal(mergeFollowUps(undefined, []), undefined);
  // Con propuesta: las del plan primero (su índice no cambia) y luego las nuevas; la vieja mejora se va.
  const out = mergeFollowUps(before, [f("Mostrar en la app", "required"), f("Lanzar la extracción", "refine")])!;
  assert.deepEqual(out.map((x) => x.title), ["Lanzar la extracción", "Mostrar en la app"]);
  assert.equal(out[0].fromPlan, true);
  assert.equal("fromPlan" in out[1], false);
});

test("normalizeFollowUps: fromPlan solo si viene a true (lo que propone Claude al abrir el PR no lo trae)", () => {
  const [x] = normalizeFollowUps([{ ...f("Mostrar en la app", "required"), fromPlan: "sí" } as unknown as FollowUpInput])!;
  assert.equal("fromPlan" in x, false);
});

test("planLocalMarkdown: sección para la tarjeta del plan, vacía si no hay nada", () => {
  const label = { heading: "En tu Claude Code", intro: "Esto lo ejecutas tú.", needs: "falta:" };
  assert.equal(planLocalMarkdown(undefined, label), "");
  const md = planLocalMarkdown(planLocalFollowUps([local("Lanzar la extracción")]), label);
  assert.match(md, /^\n\n## En tu Claude Code\n\nEsto lo ejecutas tú\.\n\n- \*\*Lanzar la extracción\*\*: Necesita SSH y crear un servidor \(falta: clave SSH y token de Hetzner\)$/);
});
