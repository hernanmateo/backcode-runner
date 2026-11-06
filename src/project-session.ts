import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { t } from "./i18n.js";
import { installOrUpdatePlugin, pluginInRepos, pluginInstalls } from "./plugin.js";
import { installedClaude } from "./preflight.js";
import { startRemoteControl, type RemoteSession } from "./remote.js";

/**
 * «Sesión directa en Claude Code»: una sesión NUEVA de Claude Code con Remote Control en la carpeta real de un proyecto
 * conectado (no en un worktree), que pide su dueño desde la app (petición `openProjectSession`, remote-control.ts). Corre
 * con los permisos y la configuración normales de Claude Code de la persona, sin el sandbox del runner. La orden es fija
 * (`claude --remote-control <nombre> [-- <prompt>]`); de la app solo llega el texto del primer mensaje, como argumento.
 * Una por proyecto: si ya hay una abierta, se devuelve la misma.
 */

export const REMOTE_PLATFORMS: NodeJS.Platform[] = ["darwin", "linux"];
/** Tope del primer mensaje (el mismo en las reglas y en la app). */
export const PROMPT_MAX = 4000;

export type SessionErrorCode = "unavailable" | "noRepo" | "plugin" | "timeout" | "failed";

export interface ProjectSessionState {
  projectId: string;
  state: "opening" | "open" | "failed";
  /** Fase mientras se abre (lista cerrada, para que la app lo cuente): plugin o Claude Code arrancando hasta el enlace. */
  phase?: SessionPhase;
  url?: string;
  code?: SessionErrorCode;
  error?: string;
}

export type SessionPhase = "preparing" | "starting";

export interface OpenResult {
  ok: boolean;
  url?: string;
  reused?: boolean;
  code?: SessionErrorCode;
  error?: string;
}

/** Lo que usa de fuera (en los tests, de mentira). */
export interface SessionDeps {
  claude: () => string | null;
  platform: NodeJS.Platform;
  exists: (dir: string) => boolean;
  /** Deja el plugin de Backcode activo en esa carpeta (instalándolo con --scope user si falta). Devuelve el error. */
  ensurePlugin: (claude: string, dir: string) => Promise<string | null>;
  launch: typeof startRemoteControl;
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

const defaults: SessionDeps = {
  claude: installedClaude,
  platform: process.platform,
  exists: existsSync,
  ensurePlugin,
  launch: startRemoteControl,
};

/** Sesiones directas de este ordenador, por proyecto. `onChange`: para volver a publicar el estado en Firestore. */
export class ProjectSessions {
  private states = new Map<string, ProjectSessionState>();
  private sessions = new Map<string, RemoteSession>();
  private deps: SessionDeps;

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

  private fail(projectId: string, code: SessionErrorCode, error: string): OpenResult {
    this.set(projectId, { state: "failed", code, error });
    return { ok: false, code, error };
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
      session = await this.deps.launch({ bin: claude, cwd: dir, name: (project.name ?? projectId).slice(0, 80), ...(prompt ? { prompt } : {}) });
    } catch (err) {
      const message = String((err as Error).message ?? err);
      return this.fail(projectId, message.startsWith("timeout") ? "timeout" : "failed", t("remote.failed", { error: message.slice(0, 400) }));
    }
    this.sessions.set(projectId, session);
    this.set(projectId, { state: "open", url: session.url });
    void session.exited.then(() => {
      if (this.sessions.get(projectId) !== session) return;
      this.sessions.delete(projectId);
      this.set(projectId, null);
    });
    return { ok: true, url: session.url };
  }

  /** Cierra la sesión (o borra el fallo que se mostraba). */
  close(projectId: string): void {
    const session = this.sessions.get(projectId);
    this.sessions.delete(projectId);
    session?.stop();
    if (this.states.has(projectId)) this.set(projectId, null);
  }

  closeAll(): void {
    for (const id of [...this.states.keys()]) this.close(id);
  }
}
