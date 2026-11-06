import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n.js";
import { HOME_DIR } from "./paths.js";
import { installOrUpdatePlugin, pluginInRepos, pluginInstalls } from "./plugin.js";
import { installedClaude } from "./preflight.js";
import { isRemoteSession, processAlive, startRemoteControl, stopGroup, type RemoteSession } from "./remote.js";

/**
 * «Sesión directa en Claude Code»: una sesión NUEVA de Claude Code con Remote Control en la carpeta real de un proyecto
 * conectado (no en un worktree), que pide su dueño desde la app (petición `openProjectSession`, remote-control.ts). Corre
 * con los permisos y la configuración normales de Claude Code de la persona, sin el sandbox del runner. La orden es fija
 * (`claude --remote-control <nombre> [-- <prompt>]`); de la app solo llega el texto del primer mensaje, como argumento.
 * Una por proyecto: si ya hay una abierta, se devuelve la misma.
 *
 * Sobrevive a los reinicios y las actualizaciones del runner (va aparte, remote.ts `persistent`): su pid, su enlace y el
 * proyecto se guardan en ~/.backcode/sessions.json y, al volver, se «adopta» (adopt) y se sigue publicando. Solo se
 * cierra cuando lo pide la persona, cuando Claude sale o al apagar del todo; el motivo se publica (`closedReason`).
 */

export const REMOTE_PLATFORMS: NodeJS.Platform[] = ["darwin", "linux"];
/** Tope del primer mensaje (el mismo en las reglas y en la app). */
export const PROMPT_MAX = 4000;
/** Cada cuánto se mira si sigue viva una sesión adoptada (de la que no somos el padre). */
const WATCH_MS = 5_000;

export type SessionErrorCode = "unavailable" | "noRepo" | "plugin" | "timeout" | "failed";
/**
 * Por qué se cerró: la persona desde la app (`user`), Claude salió (`exited`), no sobrevivió mientras el runner estaba
 * parado o se reinició el ordenador (`restart`), «Apagar del todo» (`shutdown`) o no se pudo seguir (`error`).
 */
export type ClosedReason = "user" | "exited" | "restart" | "shutdown" | "error";

export interface ProjectSessionState {
  projectId: string;
  state: "opening" | "open" | "failed" | "closed";
  /** Fase mientras se abre (lista cerrada, para que la app lo cuente): plugin o Claude Code arrancando hasta el enlace. */
  phase?: SessionPhase;
  url?: string;
  code?: SessionErrorCode;
  error?: string;
  closedReason?: ClosedReason;
}

export type SessionPhase = "preparing" | "starting";

export interface OpenResult {
  ok: boolean;
  url?: string;
  reused?: boolean;
  code?: SessionErrorCode;
  error?: string;
}

/** Lo que se guarda en disco de cada sesión abierta (sin rutas ni prompts). */
export interface SavedSession {
  projectId: string;
  pid: number;
  url: string;
  startedAt: number;
}

/** Lo que usa de fuera (en los tests, de mentira). */
export interface SessionDeps {
  claude: () => string | null;
  platform: NodeJS.Platform;
  exists: (dir: string) => boolean;
  /** Deja el plugin de Backcode activo en esa carpeta (instalándolo con --scope user si falta). Devuelve el error. */
  ensurePlugin: (claude: string, dir: string) => Promise<string | null>;
  launch: typeof startRemoteControl;
  /** Sesiones guardadas en disco. */
  load: () => SavedSession[];
  save: (list: SavedSession[]) => void;
  /** ¿Es una sesión nuestra viva? (al adoptarla). */
  isSession: (pid: number) => boolean;
  /** ¿Sigue vivo? (mientras está adoptada). */
  alive: (pid: number) => boolean;
  /** Cierra una sesión adoptada (todo su grupo de procesos). */
  kill: (pid: number) => void;
  watchMs: number;
}

/** ¿Está activo el plugin en la carpeta? Si no, se instala/actualiza (--scope user) y se vuelve a mirar. */
export async function ensurePlugin(claude: string, dir: string): Promise<string | null> {
  const active = async () => {
    const installs = await pluginInstalls(claude);
    // Claude Code sin `plugin list`: no se puede saber, se sigue (como el resto del runner).
    if (!installs) return true;
    return (await pluginInRepos(claude, installs, [dir]))[dir] !== "off";
  };
  if (await active()) return null;
  const r = await installOrUpdatePlugin(claude);
  if (!r.ok) return r.output.slice(-300) || "plugin";
  return (await active()) ? null : "plugin";
}

export const SESSIONS_FILE = join(HOME_DIR, "sessions.json");
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Las sesiones guardadas, solo las que tienen buena forma (el fichero podría estar a medias o tocado a mano). */
export function loadSessions(file = SESSIONS_FILE): SavedSession[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is SavedSession => !!s && typeof s === "object" && ID_RE.test(String(s.projectId)) && Number.isInteger(s.pid) && s.pid > 1 && typeof s.url === "string" && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(s.url))
      .map((s) => ({ projectId: s.projectId, pid: s.pid, url: s.url, startedAt: Number(s.startedAt) || 0 }))
      .slice(0, 200);
  } catch {
    return [];
  }
}

/** Nunca falla: sin permisos en ~/.backcode simplemente no se recuerda (y no se podrá adoptar tras un reinicio). */
export function saveSessions(list: SavedSession[], file = SESSIONS_FILE): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // se vuelve a intentar con el próximo cambio
  }
}

const defaults: SessionDeps = {
  claude: installedClaude,
  platform: process.platform,
  exists: existsSync,
  ensurePlugin,
  launch: startRemoteControl,
  load: () => loadSessions(),
  save: (list) => saveSessions(list),
  isSession: isRemoteSession,
  alive: processAlive,
  kill: stopGroup,
  watchMs: WATCH_MS,
};

/** Una sesión abierta: lanzada por este proceso o adoptada de uno anterior. */
interface Live {
  pid: number;
  url: string;
  startedAt: number;
  stop: () => void;
  /** Adoptada: no somos su padre, se mira cada `watchMs` si sigue viva. */
  adopted: boolean;
}

/** Sesiones directas de este ordenador, por proyecto. `onChange`: para volver a publicar el estado en Firestore. */
export class ProjectSessions {
  private states = new Map<string, ProjectSessionState>();
  private lives = new Map<string, Live>();
  private deps: SessionDeps;
  private watcher?: NodeJS.Timeout;

  constructor(
    private onChange: () => void = () => undefined,
    deps: Partial<SessionDeps> = {},
  ) {
    this.deps = { ...defaults, ...deps };
  }

  /** Lo que se publica (sin rutas, tokens ni prompts). */
  list(): ProjectSessionState[] {
    return [...this.states.values()].slice(0, 200);
  }

  private set(projectId: string, s: Omit<ProjectSessionState, "projectId"> | null) {
    if (s) this.states.set(projectId, { projectId, ...s });
    else this.states.delete(projectId);
    this.onChange();
  }

  private persist() {
    this.deps.save([...this.lives].map(([projectId, l]) => ({ projectId, pid: l.pid, url: l.url, startedAt: l.startedAt })));
  }

  private fail(projectId: string, code: SessionErrorCode, error: string): OpenResult {
    this.set(projectId, { state: "failed", code, error });
    return { ok: false, code, error };
  }

  /** Ya no está (Claude salió, o no sobrevivió): se publica cerrada con el motivo. */
  private ended(projectId: string, live: Live, reason: ClosedReason) {
    if (this.lives.get(projectId) !== live) return;
    this.lives.delete(projectId);
    this.persist();
    this.set(projectId, { state: "closed", closedReason: reason });
  }

  /**
   * Al arrancar el supervisor: las sesiones que dejó abiertas el anterior (reinicio, actualización) y siguen vivas se
   * vuelven a publicar como abiertas con su enlace; las que ya no están, como cerradas (`restart`).
   */
  adopt(): void {
    let changed = false;
    for (const s of this.deps.load()) {
      if (this.lives.has(s.projectId)) continue;
      changed = true;
      if (!this.deps.isSession(s.pid)) {
        this.states.set(s.projectId, { projectId: s.projectId, state: "closed", closedReason: "restart" });
        continue;
      }
      this.lives.set(s.projectId, { pid: s.pid, url: s.url, startedAt: s.startedAt, adopted: true, stop: () => this.deps.kill(s.pid) });
      this.states.set(s.projectId, { projectId: s.projectId, state: "open", url: s.url });
    }
    if (!changed) return;
    this.persist();
    this.onChange();
    this.watch();
  }

  /** Mira cada `watchMs` si siguen vivas las adoptadas (de las propias avisa su `exited`). */
  private watch() {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      const adopted = [...this.lives].filter(([, l]) => l.adopted);
      if (!adopted.length) {
        clearInterval(this.watcher);
        this.watcher = undefined;
        return;
      }
      for (const [id, l] of adopted) {
        try {
          if (!this.deps.alive(l.pid)) this.ended(id, l, "exited");
        } catch {
          this.ended(id, l, "error");
        }
      }
    }, this.deps.watchMs);
    this.watcher.unref?.();
  }

  async open(projectId: string, project: { name?: string; repoPath?: string }, prompt?: string): Promise<OpenResult> {
    const current = this.states.get(projectId);
    if (current?.state === "open" && current.url) return { ok: true, url: current.url, reused: true };
    if (current?.state === "opening") return { ok: false, code: "failed", error: t("session.busy") };
    const claude = this.deps.claude();
    if (!claude || !REMOTE_PLATFORMS.includes(this.deps.platform)) return this.fail(projectId, "unavailable", t("remote.unavailable"));
    const dir = project.repoPath?.replace(/^~(?=\/|$)/, homedir());
    if (!dir || !this.deps.exists(dir)) return this.fail(projectId, "noRepo", t("session.noRepo"));
    this.set(projectId, { state: "opening", phase: "preparing" });
    const pluginError = await this.deps.ensurePlugin(claude, dir).catch((err: Error) => err.message || "plugin");
    if (pluginError) return this.fail(projectId, "plugin", t("session.plugin", { error: pluginError.slice(0, 300) }));
    this.set(projectId, { state: "opening", phase: "starting" });
    let session: RemoteSession;
    try {
      session = await this.deps.launch({ bin: claude, cwd: dir, name: (project.name ?? projectId).slice(0, 80), persistent: true, ...(prompt ? { prompt } : {}) });
    } catch (err) {
      const message = String((err as Error).message ?? err);
      return this.fail(projectId, message.startsWith("timeout") ? "timeout" : "failed", t("remote.failed", { error: message.slice(0, 400) }));
    }
    const live: Live = { pid: session.pid, url: session.url, startedAt: Date.now(), adopted: false, stop: () => session.stop() };
    this.lives.set(projectId, live);
    this.persist();
    this.set(projectId, { state: "open", url: session.url });
    void session.exited.then(
      () => this.ended(projectId, live, "exited"),
      () => this.ended(projectId, live, "error"),
    );
    return { ok: true, url: session.url };
  }

  /** Cierra la sesión (motivo `reason`) o, si ya no hay ninguna, borra lo que se mostraba (un fallo o un cierre). */
  close(projectId: string, reason: ClosedReason = "user"): void {
    const live = this.lives.get(projectId);
    if (!live) {
      if (this.states.has(projectId)) this.set(projectId, null);
      return;
    }
    this.lives.delete(projectId);
    this.persist();
    live.stop();
    this.set(projectId, { state: "closed", closedReason: reason });
  }

  /** Solo al apagar del todo (`shutdown`): un reinicio o una actualización del runner NO cierran las sesiones. */
  closeAll(reason: ClosedReason = "shutdown"): void {
    for (const id of [...this.lives.keys()]) this.close(id, reason);
  }
}
