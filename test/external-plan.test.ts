import assert from "node:assert/strict";
import { test } from "node:test";
import { leakedSecrets, MAX_GROUPS, PlanInput, planPrompt, validatePlan, type PlanGroup } from "../src/external-plan.js";

const input = PlanInput.parse({
  tasks: [
    { fid: "t104", title: "Datos v2", mergedAt: Date.UTC(2026, 10, 1), steps: [{ step: 0, why: "Publicar datos", command: "bun run data:publish" }] },
    { fid: "t94", title: "Datos picos", steps: [{ step: 1, why: "Regenerar y publicar", command: "bun scripts/data/v2/deckCheck.ts && bun run data:publish" }] },
    { fid: "t87", title: "Caducar build", steps: [{ step: 0, why: "Caducar la build 18 en TestFlight" }, { step: 2, why: "Otro", command: "echo x" }] },
  ],
  running: [{ fid: "run1", title: "data:v2" }],
});

test("validatePlan: deja los grupos de Claude que cubren pasos reales, con waitFor solo a tareas en marcha", () => {
  const groups: PlanGroup[] = [
    { title: "Datos", commands: ["bun scripts/data/v2/deckCheck.ts && bun run data:publish"], notes: "Mira los WARN", rollback: "Copia CURRENT.prev.json", covers: [{ fid: "t104", step: 0 }, { fid: "t94", step: 1 }], waitFor: "run1" },
    { title: "TestFlight", commands: [], covers: [{ fid: "t87", step: 0 }], waitFor: "t104" },
  ];
  const out = validatePlan(groups, input);
  assert.equal(out[0].waitFor, "run1");
  assert.equal(out[0].rollback, "Copia CURRENT.prev.json");
  assert.deepEqual(out[0].covers, [{ fid: "t104", step: 0 }, { fid: "t94", step: 1 }]);
  // waitFor a una tarea que no está en marcha: fuera.
  assert.equal(out[1].waitFor, undefined);
  // El paso que Claude no cubrió va al final, solo y con su comando original.
  assert.deepEqual(out[2], { title: "Otro", commands: ["echo x"], covers: [{ fid: "t87", step: 2 }] });
  assert.equal(out.length, 3);
});

test("validatePlan: pasos inventados o repetidos no se guardan, y un grupo sin pasos reales desaparece", () => {
  const out = validatePlan(
    [
      { title: "A", commands: ["a"], covers: [{ fid: "t104", step: 0 }, { fid: "nope", step: 0 }, { fid: "t104", step: 5 }] },
      { title: "B", commands: ["b"], covers: [{ fid: "t104", step: 0 }] },
      { title: "C", commands: ["c"], covers: [] },
    ],
    input,
  );
  assert.deepEqual(out[0].covers, [{ fid: "t104", step: 0 }]);
  assert.ok(!out.some((g) => g.title === "B" || g.title === "C"));
  // Cada paso pendiente, exactamente una vez.
  const all = out.flatMap((g) => g.covers.map((c) => `${c.fid}:${c.step}`));
  assert.deepEqual([...all].sort(), ["t104:0", "t87:0", "t87:2", "t94:1"]);
  assert.equal(new Set(all).size, all.length);
});

test("validatePlan: recorta textos, sin comandos vacíos y título por defecto el porqué", () => {
  const out = validatePlan([{ title: "  ", commands: ["", "  x  "], notes: "n".repeat(5000), covers: [{ fid: "t94", step: 1 }] }], input);
  assert.equal(out[0].title, "Regenerar y publicar");
  assert.deepEqual(out[0].commands, ["x"]);
  assert.equal(out[0].notes?.length, 2000);
  assert.ok(out.length <= MAX_GROUPS);
});

test("PlanInput: rechaza ids raros y entradas vacías", () => {
  assert.equal(PlanInput.safeParse({ tasks: [] }).success, false);
  assert.equal(PlanInput.safeParse({ tasks: [{ fid: "../x", title: "a", steps: [{ step: 0, why: "a" }] }] }).success, false);
  assert.deepEqual(PlanInput.parse({ tasks: [{ fid: "a1", title: "a", steps: [{ step: 0, why: "a" }] }] }).running, []);
});

test("planPrompt: lista tareas, pasos con o sin comando y las tareas en marcha", () => {
  const p = planPrompt(input);
  assert.match(p, /Task t104 «Datos v2» \(merged 2026-11-01\)/);
  assert.match(p, /step 0: Caducar la build 18 en TestFlight \(no command\)/);
  assert.match(p, /- run1 «data:v2»/);
});

test("leakedSecrets: detecta un secreto copiado en el plan", () => {
  assert.deepEqual(leakedSecrets([{ title: "ok", commands: ["bun run data:publish"], covers: [] }]), []);
  assert.equal(leakedSecrets([{ title: "x", commands: [`export KEY=${"AKIA"}${"ABCDEFGHIJKLMNOP"}`], covers: [] }]).length, 1);
});
