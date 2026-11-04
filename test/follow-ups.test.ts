import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_UP_INPUT, FOLLOW_UPS_MAX, followUpPrompt, normalizeFollowUps, parseFollowUp, type FollowUpInput } from "../src/follow-ups.js";

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
