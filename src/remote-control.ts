import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { collection, doc, onSnapshot, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, type Firestore } from "firebase/firestore";
import { parseEnv } from "./config.js";
import { t } from "./i18n.js";
import { MACHINE_BEAT_MS, machineId, machineStatus } from "./machines.js";
import { projectFiles } from "./paths.js";
import { PLUGIN_UPDATE_CMDS } from "./plugin.js";
import { installedClaude } from "./preflight.js";
import { connect } from "./store.js";
import type { Supervisor } from "./supervisor.js";

// Control remoto del runner desde la app: peticiones `users/{uid}/machines/{machineId}/requests/{id}` con `type` (parar,
// arrancar o reiniciar un proyecto, reiniciar todo, actualizar ya, pausar/reanudar y apagar del todo). Las atiende el
// supervisor (el panel/servicio o `backcode start`), no el runner de un proyecto: así sigue escuchando con todo en pausa.
// Cada petición se valida aquí (ids con las mismas regex, el proyecto conectado en este ordenador), se reclama una sola
// vez (pending -> running en una transacción) y deja su resultado. Nunca hay comandos libres: cada tipo hace algo fijo.
// Además publica en el documento del ordenador el estado de cada proyecto (`control`): solo metadatos, nunca tokens.

const run = promisify(execFile);

export const CONTROL_TYPES = ["stopProject", "startProject", "restartProject", "restartAll", "updateNow", "pauseAll", "resumeAll", "shutdown"] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];
const PROJECT_TYPES: readonly ControlType[] = ["stopProject", "startProject", "restartProject"];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Cada cuánto se mira si ha cambiado el estado de los proyectos (solo se escribe si cambia o toca latido). */
const STATE_EVERY_MS = 5_000;
/** Reintento de la conexión (sin red al iniciar sesión, ningún proyecto conectado aún…). */
const RETRY_MS = 60_000;

export type ControlRequest = { type: Exclude<ControlType, "stopProject" | "startProject" | "restartProject"> } | { type: "stopProject" | "startProject" | "restartProject"; projectId: string };

/** ¿Es una petición de control (y no una de «Conectar en <host>», que atiende el runner de un proyecto)? */
export function isControlRequest(raw: Record<string, unknown>): boolean {
  return raw.type !== undefined && raw.type !== null;
}

/** Valida la petición tal como llega de Firestore. `connected`: proyectos conectados en este ordenador. */
export function parseControlRequest(raw: Record<string, unknown>, connected: Iterable<string>): ControlRequest | { error: string } {
  const type = raw.type;
  if (typeof type !== "string" || !(CONTROL_TYPES as readonly string[]).includes(type)) return { error: t("scaffold.bad", { field: "type" }) };
  if (!PROJECT_TYPES.includes(type as ControlType)) {
    if (raw.projectId !== undefined) return { error: t("scaffold.bad", { field: "projectId" }) };
    return { type: type as Exclude<ControlType, "stopProject" | "startProject" | "restartProject"> };
  }
  const projectId = raw.projectId;
  if (typeof projectId !== "string" || !ID_RE.test(projectId)) return { error: t("scaffold.bad", { field: "projectId" }) };
  if (![...connected].includes(projectId)) return { error: t("control.notConnected", { id: projectId }) };
  return { type: type as "stopProject" | "startProject" | "restartProject", projectId };
}

/** Lo que el control remoto usa del supervisor (en los tests, uno de mentira). */
export type ControlTarget = Pick<Supervisor, "projects" | "off" | "scan" | "start" | "stop" | "restart" | "setPower" | "restartAllWhenIdle" | "checkUpdateNow">;

export interface ControlHooks {
  /** Reiniciar todo cuando los runners queden libres (el panel se relanza entero); por defecto, solo los runners. */
  restartAll?: () => void | Promise<void>;
  /** Apagar del todo: parar los runners (las tareas a medias vuelven a la cola) y terminar este proceso. */
  shutdown: () => void | Promise<void>;
  /** Tras pausar o reanudar (p. ej. el panel ajusta «mantener despierto»). */
  onPower?: (on: boolean) => void;
  /** Actualizar el plugin de Claude Code (por defecto, PLUGIN_UPDATE_CMDS). Devuelve el error, si lo hay. */
  updatePlugin?: () => Promise<string | null>;
}

export interface ControlOutcome {
  status: "done" | "failed";
  result: { error?: string; updated?: boolean; pluginError?: string };
  /** Lo que corta este proceso (reiniciar, apagar) va después de dejar el resultado en la petición. */
  after?: () => void | Promise<void>;
}

/** Los comandos fijos de PLUGIN_UPDATE_CMDS con la Claude Code de este ordenador. */
export async function updatePlugin(): Promise<string | null> {
  const claude = installedClaude();
  if (!claude) return "claude";
  try {
    for (const cmd of PLUGIN_UPDATE_CMDS) {
      const [bin, ...args] = cmd.split(" ");
      await run(bin === "claude" ? claude : bin, args, { timeout: 5 * 60_000 });
    }
    return null;
  } catch (err) {
    return String((err as Error).message ?? err).slice(0, 500);
  }
}

/** Ejecuta una petición ya validada. */
export async function runControlRequest(target: ControlTarget, hooks: ControlHooks, req: ControlRequest): Promise<ControlOutcome> {
  switch (req.type) {
    case "stopProject":
      await target.stop(req.projectId);
      return { status: "done", result: {} };
    case "startProject":
      return target.start(req.projectId) ? { status: "done", result: {} } : { status: "failed", result: { error: t("control.notConnected", { id: req.projectId }) } };
    case "restartProject":
      return (await target.restart(req.projectId)) ? { status: "done", result: {} } : { status: "failed", result: { error: t("control.notConnected", { id: req.projectId }) } };
    case "restartAll":
      return { status: "done", result: {}, after: hooks.restartAll ?? (() => target.restartAllWhenIdle()) };
    case "updateNow": {
      // Runner (y app de Mac) y plugin de Claude Code; luego cada runner se reinicia al quedar libre (sin cortar tareas).
      const updated = await target.checkUpdateNow().catch(() => false);
      const pluginError = await (hooks.updatePlugin ?? updatePlugin)();
      return {
        status: "done",
        result: { updated, ...(pluginError ? { pluginError: t("control.pluginFailed", { error: pluginError }) } : {}) },
        // Con versión nueva, el supervisor ya ha pedido los reinicios (y el panel se relanza tras ellos).
        after: updated ? undefined : () => target.restartAllWhenIdle(),
      };
    }
    case "pauseAll":
      await target.setPower(false);
      hooks.onPower?.(false);
      return { status: "done", result: {} };
    case "resumeAll":
      await target.setPower(true);
      hooks.onPower?.(true);
      return { status: "done", result: {} };
    case "shutdown":
      return { status: "done", result: {}, after: hooks.shutdown };
  }
}

export type PublishedState = "running" | "stopping" | "stopped" | "crashed" | "retrying" | "paused";

/** Estado para la app (`control` en users/{uid}/machines/{id}): sin rutas ni tokens. */
export function controlState(target: Pick<Supervisor, "projects" | "off">): { paused: boolean; projects: { id: string; name: string | null; state: PublishedState }[] } {
  const paused = target.off;
  return {
    paused,
    projects: [...target.projects.values()]
      .filter((p) => ID_RE.test(p.id))
      .slice(0, 200)
      .map((p) => ({
        id: p.id,
        name: p.name ? p.name.replaceAll(/[\x00-\x1f\x7f]/g, " ").slice(0, 80) : null,
        state: paused && !p.child ? "paused" : p.state,
      })),
  };
}

/** Llave e instalación de Backcode de un proyecto conectado (todas las de este ordenador son del mismo usuario). */
function credentials(): Parameters<typeof connect>[0] | null {
  for (const { file } of projectFiles()) {
    try {
      const env = new Map(parseEnv(readFileSync(file, "utf8")));
      const apiKey = env.get("BACKCODE_FIREBASE_API_KEY");
      const projectId = env.get("BACKCODE_FIREBASE_PROJECT_ID");
      const runnerKey = env.get("BACKCODE_RUNNER_KEY");
      if (!apiKey || !projectId || !runnerKey) continue;
      return {
        firebase: { apiKey, authDomain: env.get("BACKCODE_FIREBASE_AUTH_DOMAIN") || undefined, projectId, storageBucket: env.get("BACKCODE_FIREBASE_STORAGE_BUCKET") || `${projectId}.appspot.com` },
        functionsRegion: env.get("BACKCODE_FUNCTIONS_REGION") || "us-central1",
        emulators: env.get("BACKCODE_USE_EMULATORS") === "1",
        runnerKey,
      };
    } catch {
      // fichero ilegible: el siguiente
    }
  }
  return null;
}

/**
 * Escucha las peticiones de control de este ordenador y publica el estado de sus proyectos. Se conecta con la llave de
 * cualquiera de los proyectos conectados y lo reintenta cada minuto si aún no puede (sin red, sin proyectos).
 */
export function startRemoteControl(supervisor: Supervisor, hooks: ControlHooks, log: (line: string) => void = (l) => console.log(`[control] ${l}`)): { readonly connected: boolean } {
  const mid = machineId();
  const handle = { connected: false };
  let attempt = 0;

  const listen = (db: Firestore, uid: string) => {
    const machineRef = doc(db, "users", uid, "machines", mid);
    const requests = collection(machineRef, "requests");
    let busy = false;
    let pending: string[] = [];

    const finish = (id: string, outcome: Pick<ControlOutcome, "status" | "result">) =>
      updateDoc(doc(requests, id), { status: outcome.status, result: outcome.result, updatedAt: serverTimestamp() }).catch((err) => log((err as Error).message));

    const drain = async () => {
      if (busy) return;
      busy = true;
      try {
        while (pending.length) {
          const id = pending.shift()!;
          const ref = doc(requests, id);
          const raw = await runTransaction(db, async (tx) => {
            const d = await tx.get(ref);
            if (!d.exists() || d.get("status") !== "pending" || !isControlRequest(d.data())) return null;
            tx.update(ref, { status: "running", updatedAt: serverTimestamp() });
            return d.data();
          }).catch(() => null);
          if (!raw) continue;
          supervisor.scan();
          const req = parseControlRequest(raw, supervisor.projects.keys());
          if ("error" in req) {
            await finish(id, { status: "failed", result: { error: req.error } });
            continue;
          }
          log(t("control.request", { type: "projectId" in req ? `${req.type} ${req.projectId}` : req.type }));
          const outcome = await runControlRequest(supervisor, hooks, req).catch((err): ControlOutcome => ({ status: "failed", result: { error: String((err as Error).message ?? err).slice(0, 1500) } }));
          await finish(id, outcome);
          await publish(true);
          if (outcome.after) {
            await outcome.after();
            await publish(true);
          }
        }
      } finally {
        busy = false;
      }
    };

    let last = "";
    let lastAt = 0;
    const publish = async (force = false) => {
      const control = controlState(supervisor);
      const key = JSON.stringify(control);
      if (!force && key === last && Date.now() - lastAt < MACHINE_BEAT_MS) return;
      last = key;
      lastAt = Date.now();
      // Con todo en pausa no queda ningún runner que dé el latido: lo da el supervisor (así la app deja reanudar).
      await setDoc(machineRef, { ...(await machineStatus()), control, lastSeen: serverTimestamp() }, { merge: true }).catch((err) => log((err as Error).message));
    };
    void publish(true);
    const timer = setInterval(() => void publish(), STATE_EVERY_MS);
    timer.unref();

    onSnapshot(
      query(requests, where("status", "==", "pending")),
      (snap) => {
        pending = snap.docs.filter((d) => isControlRequest(d.data())).map((d) => d.id);
        void drain();
      },
      (err) => {
        // Sesión caducada o llave revocada: se vuelve a conectar.
        log(err.message);
        clearInterval(timer);
        handle.connected = false;
        setTimeout(() => void open(), RETRY_MS).unref();
      },
    );
  };

  const open = async () => {
    const cfg = credentials();
    if (!cfg) return void setTimeout(() => void open(), RETRY_MS).unref();
    try {
      const { db, uid } = await connect(cfg, `control-${++attempt}`);
      handle.connected = true;
      listen(db, uid);
    } catch (err) {
      log((err as Error).message);
      setTimeout(() => void open(), RETRY_MS).unref();
    }
  };
  void open();
  return handle;
}
