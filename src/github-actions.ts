// GitHub Actions del repo vistos desde el runner: estado de los workflows, minutos gastados del mes (si `gh` tiene permiso
// para leer la facturación) y si se han acabado (por la facturación o porque los jobs no arrancan). Un admin puede pausar
// los workflows desde la app hasta que se renueven los minutos y reactivarlos (a mano o solos al renovarse). Mientras
// están pausados por Backcode, los checks se pasan en local (actions.ts). Lo usa solo el runner, con la sesión de `gh`.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { NOT_STARTED_RE } from "./hosts.js";
import { HOME_DIR } from "./paths.js";

const run = promisify(execFile);

export interface ActionsBilling {
  /** Minutos gastados este mes (equivalentes Linux: Windows ×2, macOS ×10). */
  minutesUsed: number;
  /** Minutos incluidos en el plan (Free 2000, Pro 3000…). */
  minutesIncluded: number;
  /** Minutos pagados este mes (por encima de los incluidos), si los hay. */
  paidMinutes?: number;
}

export interface ActionsPause {
  at: string;
  /** Hasta cuándo (la renovación de los minutos). Con autoResume, el runner los reactiva solo a partir de esa fecha. */
  until: string;
  autoResume: boolean;
  /** Workflows que pausó Backcode (solo esos se reactivan). */
  workflows: { id: number; name: string }[];
}

/** Lo que publica el runner en su documento (runners/{uid}.githubActions) para la app. */
export interface ActionsStatus {
  checkedAt: string;
  workflows: { active: number; disabled: number };
  billing?: ActionsBilling;
  /**
   * No se pudo leer la facturación. «scope»: este ordenador es del dueño de la cuenta, pero a `gh` le falta el permiso
   * (billingScope). «notOwner»: la facturación solo la ve el dueño del repo (owner), no hay nada que hacer aquí.
   */
  billingError?: "scope" | "notOwner" | "unavailable";
  /** Permiso que necesita `gh` para leer la facturación: «user» (cuenta personal) o «admin:org» (organización). */
  billingScope: "user" | "admin:org";
  /** Dueño del repo en GitHub (usuario u organización). */
  owner: string;
  /** Cuándo se renuevan los minutos (el día 1 del mes siguiente, UTC). */
  resetsAt: string;
  /** Minutos agotados: lo dice la facturación o el último run de Actions no llegó a arrancar. */
  outOfMinutes?: { detectedAt: string; source: "billing" | "jobs" };
  paused?: ActionsPause;
}

const MULTIPLIER: Record<string, number> = { linux: 1, windows: 2, macos: 10 };
const INCLUDED: Record<string, number> = { free: 2000, pro: 3000, team: 3000, enterprise: 50000 };

/** El día 1 del mes siguiente a `now` (UTC): cuando GitHub renueva los minutos incluidos. */
export function nextReset(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Facturación antigua (/settings/billing/actions). */
export function parseLegacyBilling(json: unknown): ActionsBilling | null {
  const j = json as { total_minutes_used?: number; included_minutes?: number; total_paid_minutes_used?: number };
  if (typeof j?.total_minutes_used !== "number" || typeof j.included_minutes !== "number") return null;
  return { minutesUsed: Math.round(j.total_minutes_used), minutesIncluded: j.included_minutes, ...(j.total_paid_minutes_used ? { paidMinutes: Math.round(j.total_paid_minutes_used) } : {}) };
}

/** Facturación nueva (/settings/billing/usage): suma los minutos de Actions del mes, ponderados por sistema. */
export function parseUsageBilling(json: unknown, plan: string | undefined): ActionsBilling | null {
  const items = (json as { usageItems?: { product?: string; sku?: string; unitType?: string; quantity?: number; netAmount?: number }[] })?.usageItems;
  if (!Array.isArray(items)) return null;
  let used = 0;
  let paid = 0;
  for (const i of items) {
    if (i.product?.toLowerCase() !== "actions" || !/minute/i.test(i.unitType ?? "")) continue;
    const os = Object.keys(MULTIPLIER).find((k) => (i.sku ?? "").toLowerCase().includes(k)) ?? "linux";
    used += (i.quantity ?? 0) * MULTIPLIER[os];
    if ((i.netAmount ?? 0) > 0) paid += (i.quantity ?? 0) * MULTIPLIER[os];
  }
  return { minutesUsed: Math.round(used), minutesIncluded: INCLUDED[(plan ?? "free").toLowerCase()] ?? INCLUDED.free, ...(paid ? { paidMinutes: Math.round(paid) } : {}) };
}

/** ¿Es un error de permisos de `gh` (le falta el scope user / admin:org)? */
export const isScopeError = (e: unknown) => /needs the "(user|read:user|admin:org|read:org)" scope|scope|403|404|Not Found|Resource not accessible/i.test(`${(e as { stderr?: unknown })?.stderr ?? ""}\n${(e as Error)?.message ?? e}`);

// Pausa guardada en este ordenador (por proyecto): qué workflows pausó Backcode y hasta cuándo.
const pauseFile = (projectId: string) => join(HOME_DIR, "actions-paused", `${projectId}.json`);

export function readPause(projectId: string): ActionsPause | undefined {
  try {
    return existsSync(pauseFile(projectId)) ? (JSON.parse(readFileSync(pauseFile(projectId), "utf8")) as ActionsPause) : undefined;
  } catch {
    return undefined;
  }
}

function writePause(projectId: string, pause: ActionsPause | undefined): void {
  if (!pause) return rmSync(pauseFile(projectId), { force: true });
  mkdirSync(join(HOME_DIR, "actions-paused"), { recursive: true });
  writeFileSync(pauseFile(projectId), JSON.stringify(pause, null, 2));
}

export interface GithubActions {
  status(): Promise<ActionsStatus>;
  /** Pausa los workflows activos del repo hasta la renovación de los minutos. */
  pause(autoResume: boolean): Promise<ActionsPause>;
  /** Reactiva los workflows que pausó Backcode (o, sin registro, los desactivados a mano). Devuelve sus nombres. */
  resume(): Promise<string[]>;
  /** Con la pausa vencida y autoResume, reactiva; devuelve true si lo hizo. */
  autoResumeIfDue(now?: Date): Promise<boolean>;
  /** Marca los minutos como agotados (p. ej. un merge vio jobs que no arrancaron). */
  markOutOfMinutes(): void;
  isPaused(): boolean;
}

export function githubActions(repoPath: string, projectId: string, gh = async (args: string[]) => (await run("gh", args, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 })).stdout.trim()): GithubActions {
  let repoInfo: Promise<{ name: string; owner: string; org: boolean }> | undefined;
  const repo = () =>
    (repoInfo ??= gh(["repo", "view", "--json", "nameWithOwner,owner,isInOrganization"]).then((out) => {
      const j = JSON.parse(out) as { nameWithOwner: string; owner: { login: string }; isInOrganization: boolean };
      return { name: j.nameWithOwner, owner: j.owner.login, org: j.isInOrganization };
    }).catch((e) => {
      repoInfo = undefined;
      throw e;
    }));
  let jobsOut: string | undefined;

  type Workflow = { id: number; name: string; path: string; state: string };
  const workflows = async (): Promise<Workflow[]> => {
    const j = JSON.parse(await gh(["api", `repos/${(await repo()).name}/actions/workflows`, "--paginate"])) as { workflows: Workflow[] };
    // Los de Dependabot, Pages y similares no son ficheros del repo: no se tocan.
    return j.workflows.filter((w) => w.path.startsWith(".github/workflows/"));
  };

  const billing = async (): Promise<{ billing?: ActionsBilling; billingError?: "scope" | "notOwner" | "unavailable" }> => {
    const { owner, org } = await repo();
    const base = org ? `orgs/${owner}` : `users/${owner}`;
    // Una cuenta personal: su facturación solo la ve su dueño. En el runner de un compañero no se pide ningún permiso.
    if (!org) {
      const login = await gh(["api", "user", "-q", ".login"]).catch(() => "");
      if (login && login.toLowerCase() !== owner.toLowerCase()) return { billingError: "notOwner" };
    }
    try {
      const legacy = parseLegacyBilling(JSON.parse(await gh(["api", `${base}/settings/billing/actions`])));
      if (legacy) return { billing: legacy };
    } catch (e) {
      if (!isScopeError(e)) return { billingError: "unavailable" };
    }
    try {
      const now = new Date();
      const plan = org ? undefined : await gh(["api", "user", "-q", ".plan.name"]).catch(() => undefined);
      const usage = parseUsageBilling(JSON.parse(await gh(["api", `${base}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`])), plan);
      return usage ? { billing: usage } : { billingError: "unavailable" };
    } catch (e) {
      return { billingError: isScopeError(e) ? "scope" : "unavailable" };
    }
  };

  /** ¿El último run de Actions falló sin arrancar? (la anotación de GitHub de su primer job en rojo). */
  const lastRunNotStarted = async (): Promise<boolean | null> => {
    const name = (await repo()).name;
    const runs = JSON.parse(await gh(["api", `repos/${name}/actions/runs?per_page=1&status=completed`])) as { workflow_runs: { id: number; conclusion: string | null }[] };
    const last = runs.workflow_runs[0];
    if (!last) return null;
    if (last.conclusion !== "failure") return false;
    const jobs = JSON.parse(await gh(["api", `repos/${name}/actions/runs/${last.id}/jobs`])) as { jobs: { id: number; conclusion: string | null; steps?: unknown[] }[] };
    const failed = jobs.jobs.find((j) => j.conclusion === "failure");
    if (!failed) return false;
    const notes = JSON.parse(await gh(["api", `repos/${name}/check-runs/${failed.id}/annotations`])) as { message?: string }[];
    return notes.some((n) => NOT_STARTED_RE.test(n.message ?? ""));
  };

  const self: GithubActions = {
    isPaused: () => !!readPause(projectId),
    markOutOfMinutes() {
      jobsOut ??= new Date().toISOString();
    },
    async status() {
      const now = new Date();
      const resetsAt = nextReset(now).toISOString();
      const list = await workflows();
      const info = await repo();
      const b = await billing();
      const paused = readPause(projectId);
      // Sin pausa, el último run dice si arrancan; con la pausa puesta no hay runs nuevos (se mantiene lo visto).
      if (!paused) {
        const notStarted = await lastRunNotStarted().catch(() => null);
        if (notStarted === true) self.markOutOfMinutes();
        else if (notStarted === false) jobsOut = undefined;
      }
      // Un mes nuevo renueva los minutos: lo visto el mes anterior ya no vale.
      if (jobsOut && new Date(jobsOut).getUTCMonth() !== now.getUTCMonth()) jobsOut = undefined;
      const billingOut = b.billing && b.billing.minutesUsed >= b.billing.minutesIncluded && !b.billing.paidMinutes;
      const outOfMinutes = jobsOut ? { detectedAt: jobsOut, source: "jobs" as const } : billingOut ? { detectedAt: now.toISOString(), source: "billing" as const } : undefined;
      return {
        checkedAt: now.toISOString(),
        workflows: { active: list.filter((w) => w.state === "active").length, disabled: list.filter((w) => w.state !== "active").length },
        ...b,
        billingScope: info.org ? "admin:org" : "user",
        owner: info.owner,
        resetsAt,
        ...(outOfMinutes ? { outOfMinutes } : {}),
        ...(paused ? { paused } : {}),
      };
    },
    async pause(autoResume) {
      const name = (await repo()).name;
      const active = (await workflows()).filter((w) => w.state === "active");
      for (const w of active) await gh(["api", "-X", "PUT", `repos/${name}/actions/workflows/${w.id}/disable`]);
      // Si ya había una pausa (p. ej. se pausó otro workflow nuevo), se suman.
      const prev = readPause(projectId);
      const pause: ActionsPause = {
        at: prev?.at ?? new Date().toISOString(),
        until: nextReset().toISOString(),
        autoResume,
        workflows: [...(prev?.workflows ?? []), ...active.map((w) => ({ id: w.id, name: w.name }))],
      };
      writePause(projectId, pause);
      return pause;
    },
    async resume() {
      const name = (await repo()).name;
      const pause = readPause(projectId);
      const list = await workflows();
      const ids = new Set(pause ? pause.workflows.map((w) => w.id) : list.filter((w) => w.state === "disabled_manually").map((w) => w.id));
      const targets = list.filter((w) => ids.has(w.id) && w.state !== "active");
      for (const w of targets) await gh(["api", "-X", "PUT", `repos/${name}/actions/workflows/${w.id}/enable`]);
      writePause(projectId, undefined);
      jobsOut = undefined;
      return targets.map((w) => w.name);
    },
    async autoResumeIfDue(now = new Date()) {
      const pause = readPause(projectId);
      if (!pause?.autoResume || now < new Date(pause.until)) return false;
      await self.resume();
      return true;
    },
  };
  return self;
}
