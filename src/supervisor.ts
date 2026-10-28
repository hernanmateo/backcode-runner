import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { EXIT_MARK, RESTART_CODE, UPDATE_EVERY_MS, updateIfAvailable } from "./autoupdate.js";
import { updateMacApp } from "./mac-app-update.js";
import { t } from "./i18n.js";
import { migrateLegacyConfigs, projectFiles, readState, selfCommand, updateState } from "./paths.js";
import { valueIn } from "./setup.js";

// Un runner (proceso hijo) por cada proyecto conectado en este ordenador. Lo usan el panel (y el servicio) y
// `npm run all`. Guarda las últimas líneas de cada uno, los vuelve a lanzar si se caen al poco de arrancar (p. ej. sin
// red al iniciar sesión) y cuando se actualizan, y recuerda los que paraste a mano para no arrancarlos al volver.

const LOG_LINES = 1000;
/** Reintentos tras una caída (si llevaba poco tiempo en marcha), con espera creciente. */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

export type RunnerState = "running" | "stopping" | "stopped" | "crashed" | "retrying";

export interface ProjectRunner {
  id: string;
  file: string;
  name?: string;
  repoPath?: string;
  pullRequest?: string;
  state: RunnerState;
  startedAt?: number;
  exitCode?: number;
  /** Líneas de log numeradas (seq) para que el panel pida solo las nuevas. */
  logs: { seq: number; text: string }[];
  child?: ChildProcess;
  retries: number;
  retryTimer?: NodeJS.Timeout;
}

const ANSI = /\x1b\[[0-9;]*m/g;

export class Supervisor {
  readonly projects = new Map<string, ProjectRunner>();
  private seq = 0;
  private stoppedByUser: Set<string>;

  constructor(private readonly onLine?: (project: ProjectRunner, line: string) => void) {
    migrateLegacyConfigs();
    this.stoppedByUser = new Set(readState().stopped ?? []);
    this.scan();
  }

  /** Vuelve a leer los proyectos conectados (tras conectar o quitar uno). */
  scan(): void {
    const found = projectFiles();
    const names = readState().names ?? {};
    for (const { id, file } of found) {
      const text = readFileSync(file, "utf8");
      const p = this.projects.get(id) ?? { id, file, state: "stopped" as RunnerState, logs: [], retries: 0 };
      p.name = valueIn(text, "BACKCODE_PROJECT_NAME") ?? names[id];
      p.repoPath = valueIn(text, "BACKCODE_REPO_PATH");
      p.pullRequest = valueIn(text, "BACKCODE_PULL_REQUEST") ?? "github";
      this.projects.set(id, p);
    }
    for (const [id, p] of this.projects) if (!found.some((f) => f.id === id) && !p.child) this.projects.delete(id);
  }

  /**
   * Cada 10 s busca proyectos conectados nuevos (p. ej. uno creado desde la app por un runner, o conectado desde otra
   * terminal) y los arranca, salvo los que paraste a mano.
   */
  watchNewProjects(): void {
    setInterval(() => {
      const known = new Set(this.projects.keys());
      this.scan();
      for (const id of this.projects.keys()) {
        if (known.has(id) || this.stoppedByUser.has(id) || this.off) continue;
        this.log(this.projects.get(id)!, t("all.newProject"));
        this.start(id);
      }
    }, 10_000);
  }

  /** Arranca todos los proyectos salvo los que paraste a mano (y ninguno con el botón general en «apagado»). */
  startAll(opts: { includeStopped?: boolean } = {}): void {
    if (this.off) return;
    for (const p of this.projects.values()) if (opts.includeStopped || !this.stoppedByUser.has(p.id)) this.start(p.id);
  }

  start(id: string): boolean {
    this.scan();
    const p = this.projects.get(id);
    if (!p) return false;
    this.setStoppedByUser(id, false);
    clearTimeout(p.retryTimer);
    p.retries = 0;
    if (!p.child) this.launch(p);
    return true;
  }

  /** Para el runner (Ctrl+C): termina limpio y una tarea a medias vuelve a la cola. */
  async stop(id: string, opts: { byUser?: boolean } = { byUser: true }): Promise<void> {
    const p = this.projects.get(id);
    if (!p) return;
    if (opts.byUser) this.setStoppedByUser(id, true);
    clearTimeout(p.retryTimer);
    if (!p.child) {
      p.state = "stopped";
      return;
    }
    p.state = "stopping";
    const child = p.child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    // Si no termina en 2 minutos (una tarea que no responde), se fuerza.
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    await exited;
    clearTimeout(timer);
  }

  async restart(id: string): Promise<boolean> {
    await this.stop(id, { byUser: false });
    return this.start(id);
  }

  /** Botón general del panel: apagado para todos los runners (la tarea a medias vuelve a la cola) y se recuerda. */
  get off(): boolean {
    return !!readState().off;
  }
  async setPower(on: boolean): Promise<void> {
    updateState({ off: !on });
    if (on) this.startAll();
    else await this.stopAll();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.projects.values()].filter((p) => p.child).map((p) => this.stop(p.id, { byUser: false })));
  }

  /** Para todos los runners en cuanto queden libres (sin interrumpir nada) y no los vuelve a lanzar: reiniciar el panel. */
  async drain(): Promise<void> {
    this.draining = true;
    const running = [...this.projects.values()].filter((p) => p.child);
    await Promise.all(running.map((p) => new Promise<void>((resolve) => {
      p.child!.once("exit", () => resolve());
      p.child!.kill("SIGUSR2");
    })));
  }
  private draining = false;

  /** Reinicia un runner cuando quede libre (p. ej. al cambiar sus credenciales), sin cortar lo que esté haciendo. */
  restartWhenIdle(id: string): void {
    this.projects.get(id)?.child?.kill("SIGUSR2");
  }

  /** Pide a cada runner que se reinicie al quedar libre (sin interrumpir lo que esté haciendo): versión nueva. */
  restartAllWhenIdle(): void {
    for (const p of this.projects.values()) {
      if (!p.child) continue;
      this.pendingRestart.add(p.id);
      p.child.kill("SIGUSR2");
    }
  }
  /** Runners que aún no se han reiniciado con la versión nueva (están terminando algo). */
  readonly pendingRestart = new Set<string>();

  /** Comprueba actualizaciones (una vez para todos) y, con versión nueva lista, reinicia cada runner al quedar libre. */
  watchUpdates(onReady?: () => void): void {
    let checking = false;
    const check = async (force = false) => {
      if (checking) return;
      checking = true;
      try {
        if (await updateIfAvailable({ force })) {
          this.restartAllWhenIdle();
          onReady?.();
        }
        // La ventana de macOS (Backcode Runner.app), aparte: se sustituye por la del DMG de la última versión.
        await updateMacApp({ force }).catch(() => undefined);
      } catch {
        // sin red o git/npm no disponible: se vuelve a intentar en la próxima comprobación
      } finally {
        checking = false;
      }
    };
    setInterval(() => void check(), UPDATE_EVERY_MS);
    setTimeout(() => void check(true), 15_000);
    this.checkUpdateNow = () => check(true);
  }
  checkUpdateNow: () => Promise<void> = async () => undefined;

  logsAfter(id: string, after: number): { seq: number; text: string }[] {
    return (this.projects.get(id)?.logs ?? []).filter((l) => l.seq > after);
  }

  private launch(p: ProjectRunner): void {
    // BACKCODE_SUPERVISED: la actualización la gestiona este proceso; el runner, al recibir SIGUSR2, termina lo que tenga
    // en marcha y sale con RESTART_CODE para que aquí se vuelva a lanzar con el código nuevo.
    const [cmd, args] = selfCommand(["run", "--project", p.id]);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BACKCODE_SUPERVISED: "1" } });
    p.child = child;
    p.state = "running";
    p.startedAt = Date.now();
    p.exitCode = undefined;
    // El runner anuncia su salida (EXIT_MARK) justo antes de process.exit: si a los 3 s sigue vivo (el ejecutable de Bun a
    // veces se queda dormido ahí), se mata y cuenta como la salida anunciada. Sin esto, reiniciar el panel esperaba siempre.
    let announced: number | undefined;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        if (!line.startsWith(EXIT_MARK)) return this.log(p, line);
        announced = Number(line.slice(EXIT_MARK.length)) || 0;
        setTimeout(() => {
          if (p.child === child && child.pid && alive(child.pid)) process.kill(child.pid, "SIGKILL");
        }, 3_000).unref();
      });
    }
    child.on("exit", (exitCode, signal) => {
      const code = exitCode ?? announced ?? null;
      // Que haya terminado de verdad: con el ejecutable sin Node se han visto procesos que avisan de su salida y siguen
      // vivos (al 100 % de CPU y con el proyecto cogido). Si sigue ahí, se mata: nunca dos runners del mismo proyecto.
      if (child.pid && alive(child.pid)) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // ya no está
        }
      }
      p.child = undefined;
      p.exitCode = code ?? undefined;
      this.pendingRestart.delete(p.id);
      if (code === RESTART_CODE && p.state !== "stopping" && !this.draining) return this.launch(p);
      const wasStopping = p.state === "stopping";
      this.log(p, t("all.exited", { code: code ?? signal ?? 0 }));
      if (wasStopping || code === 0 || this.draining) {
        p.state = "stopped";
        return;
      }
      // Se cayó: si llevaba poco en marcha suele ser algo pasajero (sin red al iniciar sesión); se reintenta unas veces.
      if (Date.now() - (p.startedAt ?? 0) > 10 * 60_000) p.retries = 0;
      const delay = RETRY_DELAYS_MS[p.retries];
      if (delay === undefined) {
        p.state = "crashed";
        return;
      }
      p.retries++;
      p.state = "retrying";
      p.retryTimer = setTimeout(() => {
        if (p.state === "retrying" && !p.child) this.launch(p);
      }, delay);
    });
  }

  private log(p: ProjectRunner, line: string): void {
    p.logs.push({ seq: ++this.seq, text: line.replace(ANSI, "") });
    if (p.logs.length > LOG_LINES) p.logs.splice(0, p.logs.length - LOG_LINES);
    this.onLine?.(p, line);
  }

  private setStoppedByUser(id: string, stopped: boolean): void {
    if (stopped === this.stoppedByUser.has(id)) return;
    if (stopped) this.stoppedByUser.add(id);
    else this.stoppedByUser.delete(id);
    updateState({ stopped: [...this.stoppedByUser] });
  }
}

/** ¿Sigue vivo el proceso? (señal 0: solo comprueba). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
