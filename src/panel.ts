import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { latestVersion, newer, UPDATE_MODE } from "./autoupdate.js";
import { readAsset, VERSION } from "./assets.js";
import { KIT_DIR } from "./config.js";
import { lang, panelStrings, setLang, t } from "./i18n.js";
import { PANEL_HOST, PANEL_PORT, panelAlive, panelToken, panelUrl } from "./panel-client.js";
import { CONFIG_DIR, importLegacy, IS_BINARY, legacyConfigs, ownArgs, readState, updateState } from "./paths.js";
import { APP_LINKS } from "./links.js";
import { hasSavedApiKey, removeApiKey, saveApiKey } from "./anthropic.js";
import { FIX_ACTIONS, fixesFor, runFix, type FixAction } from "./fixes.js";
import { machineReport, type Check } from "./preflight.js";
import { disableAutostart, installService, isService, serviceInstalled, serviceSupported, uninstallService } from "./service.js";
import { bitbucketAccountState, connectProject, parseConfig, saveAccountBitbucket, type Answers } from "./setup.js";
import { Supervisor } from "./supervisor.js";

// El panel: una página pequeña en http://127.0.0.1:47474 que sirve este mismo proceso, para conectar proyectos, ver y
// controlar sus runners y activar «Arrancar al iniciar sesión» sin usar la terminal. Solo escucha en 127.0.0.1; la API
// exige el token de ~/.backcode/config/panel-token (va en el enlace que abre `backcode`) y rechaza otros Host y Origin
// (así no la puede usar una web que abras en el navegador, ni con DNS rebinding). Nunca devuelve llaves ni tokens.

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/panel.js": ["panel.js", "text/javascript; charset=utf-8"],
  "/panel.css": ["panel.css", "text/css; charset=utf-8"],
  "/icon.png": ["icon.png", "image/png"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const COLORS = [36, 35, 33, 32, 34, 31];

/** Idioma del panel (y de sus mensajes): elegido en el panel > perfil de la app > navegador > sistema. BACKCODE_LANG manda. */
function useLang(browser?: string | null): void {
  const saved = readState();
  const fromBrowser = browser?.slice(0, 2).toLowerCase();
  setLang(saved.panelLang ?? saved.profileLang ?? fromBrowser);
}

export async function servePanel(opts: { open: boolean }): Promise<void> {
  const service = isService();
  const token = Buffer.from(panelToken());
  const origins = new Set([`http://${PANEL_HOST}:${PANEL_PORT}`, `http://localhost:${PANEL_PORT}`]);
  const hosts = new Set([`${PANEL_HOST}:${PANEL_PORT}`, `localhost:${PANEL_PORT}`]);

  // Si ya hay un panel (el servicio u otra terminal), se abre ese: dos a la vez se pelearían por los mismos proyectos.
  if (await panelAlive()) {
    if (service) return waitForPort(opts);
    console.log(t("panel.alreadyRunning", { url: `http://${PANEL_HOST}:${PANEL_PORT}` }));
    if (opts.open) openBrowser(panelUrl());
    process.exit(0);
  }

  const tags = new Map<string, string>();
  const supervisor = new Supervisor((p, line) => {
    if (!tags.has(p.id)) tags.set(p.id, `\x1b[${COLORS[tags.size % COLORS.length]}m[${p.id}]\x1b[0m`);
    console.log(`${tags.get(p.id)} ${line}`);
  });
  let checks: Check[] = [];
  let checksLang = "";
  let checking: Promise<void> | null = null;
  const refreshChecks = () => {
    checksLang = lang();
    return (checking ??= machineReport().then((c) => void (checks = c)).finally(() => (checking = null)));
  };
  void refreshChecks();
  let updateReady = false;
  let leaving: string | null = null;

  const state = () => {
    supervisor.scan(); // nombres que acaban de apuntar los runners, proyectos conectados desde la terminal
    // Los textos de las comprobaciones salen en el idioma con el que se hicieron: si cambia, se rehacen.
    if (checksLang !== lang() && !checking) void refreshChecks();
    // Con npm, la versión instalada en disco puede ser ya la nueva (el ejecutable se sustituye entero: lo dice updateReady).
    const onDisk = (() => {
      if (IS_BINARY) return VERSION;
      try {
        return JSON.parse(readFileSync(join(KIT_DIR, "package.json"), "utf8")).version as string;
      } catch {
        return VERSION;
      }
    })();
    return {
      app: "backcode-runner",
      version: VERSION,
      latest: latestVersion,
      updateAvailable: !!latestVersion && newer(latestVersion, VERSION) && onDisk === VERSION,
      updateMode: UPDATE_MODE,
      // Los runners ya usan la versión nueva; el panel, hasta que se reinicie.
      restartNeeded: updateReady || onDisk !== VERSION,
      service: { supported: serviceSupported(), installed: serviceInstalled(), self: service },
      leaving,
      off: supervisor.off,
      // Reiniciando: los runners que aún terminan algo (el panel se reinicia cuando acaban).
      waitingFor: leaving === "restart" ? [...supervisor.projects.values()].filter((p) => p.child).map((p) => p.name ?? p.id) : [],
      lang: lang(),
      langChosen: !!readState().panelLang,
      strings: panelStrings(),
      checks: checks.map((c) => ({ ...c, actions: fixesFor(c) })),
      checking: !!checking,
      platform: process.platform,
      configDir: CONFIG_DIR,
      links: APP_LINKS,
      apiKeySaved: hasSavedApiKey(),
      legacy: legacyConfigs(),
      projects: [...supervisor.projects.values()].map((p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        pullRequest: p.pullRequest,
        state: p.state,
        startedAt: p.startedAt,
        exitCode: p.exitCode,
        lastLine: p.logs.at(-1)?.text,
      })),
    };
  };

  /** Termina los runners (sin cortar lo que estén haciendo si `idle`), cierra el panel y sale o se relanza. */
  const leave = async (why: "restart" | "service-on" | "service-off" | "quit") => {
    leaving = why;
    if (why === "restart") await supervisor.drain();
    else await supervisor.stopAll();
    server.close();
    if (why === "restart" && !service) return relaunch();
    // El ejecutable de Bun a veces se queda colgado en process.exit: como servicio, launchd lo relanza igual, así que se
    // termina con SIGKILL (los runners ya han salido).
    if (service && why === "restart") process.kill(process.pid, "SIGKILL");
    process.exit(0);
  };

  const routes: Record<string, (body: Record<string, unknown>, match: RegExpExecArray) => Promise<unknown> | unknown> = {
    "GET /api/hello": () => ({ app: "backcode-runner", version: VERSION }),
    "GET /api/state": () => state(),
    "POST /api/fix": async (body) => {
      const action = String(body.action) as FixAction;
      if (!FIX_ACTIONS.includes(action)) return { error: "action" };
      const result = await runFix(action).catch((err: Error) => ({ ok: false, output: err.message }));
      if (!("terminal" in result)) await refreshChecks();
      return { ...result, state: state() };
    },
    // Selector de carpeta nativo (macOS) para elegir dónde está el repo.
    "POST /api/pick-folder": async () => {
      if (process.platform !== "darwin") return { error: "unsupported" };
      const path = await new Promise<string | null>((resolve) =>
        execFile("osascript", ["-e", `POSIX path of (choose folder with prompt "${t("panel.pickFolder").replace(/"/g, "")}")`], { timeout: 10 * 60_000 }, (err, out) => resolve(err ? null : out.trim().replace(/\/$/, ""))),
      );
      return path ? { path } : { cancelled: true };
    },
    "POST /api/anthropic-key": async (body) => {
      const r = body.remove ? (removeApiKey(), { ok: true as const }) : await saveApiKey(String(body.key ?? ""));
      if ("error" in r) return { error: t(`panel.apiKey.${r.error}` as "panel.apiKey.invalid") };
      await refreshChecks();
      // Los runners en marcha la leen al arrancar: se reinician (sin cortar nada que no se pueda retomar).
      for (const p of supervisor.projects.values()) if (p.child) await supervisor.restart(p.id);
      return state();
    },
    "POST /api/import": async (body) => {
      const legacy = legacyConfigs().find((l) => l.dir === body.dir);
      if (!legacy) return state();
      const ids = importLegacy(legacy.dir);
      supervisor.scan();
      // Con los runners antiguos aún en marcha, arrancarlos aquí chocaría (mismo proyecto): se arrancan al pararlos allí.
      if (!legacy.running) for (const id of ids) supervisor.start(id);
      return state();
    },
    "POST /api/lang": (body) => {
      if (!["es", "en", "ca"].includes(String(body.lang))) return { error: "lang" };
      updateState({ panelLang: String(body.lang) });
      useLang();
      return state();
    },
    "POST /api/checks": async () => {
      await refreshChecks();
      return state();
    },
    "POST /api/connect": async (body) => {
      const pasted = parseConfig(String(body.text ?? ""));
      if ("error" in pasted) return { error: pasted.error, notes: [] };
      const result = await connectProject(pasted.values, (body.answers ?? {}) as Answers);
      if ("ok" in result) {
        await supervisor.restart(result.projectId);
        // Llave nueva: la anterior queda revocada, así que los demás proyectos de este ordenador se reinician con ella.
        for (const id of result.restart) if (supervisor.projects.get(id)?.child) await supervisor.restart(id);
      }
      return { ...result, ignored: pasted.ignored };
    },
    "POST /api/projects/(\\w[\\w-]*)/(start|stop|restart|remove)": async (_body, m) => {
      const [, id, action] = m;
      if (!supervisor.projects.has(id)) supervisor.scan();
      const p = supervisor.projects.get(id);
      if (!p) return { error: t("panel.noProject") };
      if (action === "start") supervisor.start(id);
      else if (action === "stop") await supervisor.stop(id);
      else if (action === "restart") await supervisor.restart(id);
      else {
        await supervisor.stop(id);
        rmSync(p.file, { force: true });
        supervisor.scan();
      }
      return { ok: true };
    },
    // Cuentas: sesión de gh y token de Bitbucket de tu cuenta (para crear proyectos desde la app). Nunca devuelve el token.
    "GET /api/accounts": async () => {
      const login = await promisify(execFile)("gh", ["api", "user", "--jq", ".login"], { timeout: 15_000 }).then((o) => o.stdout.trim(), () => "");
      return { github: login ? { login } : null, bitbucket: await bitbucketAccountState() };
    },
    "POST /api/accounts/bitbucket": async (body) => {
      const r = await saveAccountBitbucket(String(body.email ?? "").trim(), String(body.token ?? "").trim());
      if ("ok" in r) for (const id of r.updated) supervisor.restartWhenIdle(id);
      return r;
    },
    "POST /api/update": async () => {
      await supervisor.checkUpdateNow();
      return state();
    },
    "POST /api/restart": () => {
      setTimeout(() => void leave("restart"), 100);
      return { ok: true };
    },
    "POST /api/power": async (body) => {
      // Sin esperar a que paren (una tarea puede tardar en soltar): el panel muestra cada runner «parando».
      void supervisor.setPower(!!body.on);
      return state();
    },
    "POST /api/service": async (body) => {
      if (!serviceSupported()) return { error: t("panel.serviceUnsupported") };
      updateState({ autostartOff: !body.enabled });
      if (body.enabled) {
        // Siendo ya el servicio: solo se vuelve a dejar para el próximo inicio de sesión, sin cortar nada.
        if (service) {
          await installService({ keepRunning: true });
          return { ok: true };
        }
        // El servicio arranca ya y espera a que este panel le deje el puerto (ver waitForPort): sin cortar a nadie.
        await installService();
        setTimeout(() => void leave("service-on"), 300);
        return { ok: true, handoff: true };
      }
      // Solo deja de arrancar al iniciar sesión: lo que está en marcha sigue (para pararlo, el botón general).
      if (service) {
        await disableAutostart();
        return { ok: true };
      }
      await uninstallService();
      return { ok: true };
    },
  };

  const server = createServer((req, res) => void handle(req, res));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": CSP });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (!hosts.has(req.headers.host ?? "")) return send(403, { error: "host" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const file = STATIC[url.pathname];
      if (req.method === "GET" && file) return send(200, readAsset(`panel/${file[0]}`), file[1]);
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });

      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) return send(403, { error: "origin" });
      const given = Buffer.from(String(req.headers["x-backcode-token"] ?? ""));
      if (given.length !== token.length || !timingSafeEqual(given, token)) return send(401, { error: "token" });

      // Idioma: el elegido en el panel, el de tu perfil en la app o, si aún no hay, el del navegador.
      useLang(url.searchParams.get("lang"));
      if (req.method === "GET" && url.pathname === "/api/logs") {
        const id = url.searchParams.get("project") ?? "";
        return send(200, { lines: supervisor.logsAfter(id, Number(url.searchParams.get("after")) || 0) });
      }
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        if (!String(req.headers["content-type"]).startsWith("application/json")) return send(415, { error: "json" });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 256 * 1024) return send(413, { error: "too large" });
          chunks.push(chunk as Buffer);
        }
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      }
      for (const [key, fn] of Object.entries(routes)) {
        const [method, pattern] = key.split(" ");
        const m = new RegExp(`^${pattern}$`).exec(url.pathname);
        if (method === req.method && m) return send(200, await fn(body, m));
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PANEL_PORT, PANEL_HOST, () => resolve());
  }).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    if (service) return waitForPort(opts);
    console.error(t("panel.portBusy", { port: PANEL_PORT }));
    process.exit(1);
  });

  supervisor.startAll();
  // Versión nueva: los runners se reinician al quedar libres y, cuando lo han hecho todos, el panel también (unos segundos
  // sin runners): así no hace falta darle a «Reiniciar el panel» ni esperar con él a que acabe una tarea larga.
  supervisor.watchUpdates(() => {
    updateReady = true;
    const timer = setInterval(() => {
      if (supervisor.pendingRestart.size || leaving) return;
      clearInterval(timer);
      void leave("restart");
    }, 5_000);
  });
  supervisor.watchNewProjects();
  const shutdown = () => void leave("quit");
  process.on("SIGTERM", shutdown);
  // Ctrl+C ya les llega a los runners (mismo grupo de procesos); aquí se espera a que terminen.
  process.on("SIGINT", () => {
    if (!service) setInterval(() => [...supervisor.projects.values()].every((p) => !p.child) && process.exit(0), 300);
  });

  if (!service) {
    console.log(`\n${t(opts.open ? "panel.ready" : "panel.readyNoOpen", { url: `http://${PANEL_HOST}:${PANEL_PORT}` })}`);
    console.log(t(supervisor.projects.size ? "panel.keepOpen" : "panel.firstTime"));
    if (opts.open) openBrowser(panelUrl());
  } else console.log(`[backcode] ${t("panel.serviceReady", { version: VERSION })}`);
}

/** El servicio arrancó mientras otro panel tenía el puerto (p. ej. al activarlo desde ese panel): espera su relevo. */
async function waitForPort(opts: { open: boolean }): Promise<void> {
  console.log(`[backcode] ${t("panel.waitingPort", { port: PANEL_PORT })}`);
  while (await panelAlive()) await new Promise((r) => setTimeout(r, 3000));
  await new Promise((r) => setTimeout(r, 1000));
  return servePanel(opts);
}

/**
 * Abre el panel como una app y no como una pestaña más: la app de Mac si está instalada; si no, una ventana de app de un
 * navegador Chromium (Chrome, Brave, Edge…: sin barra de direcciones ni pestañas); si no hay ninguno, el navegador por
 * defecto. BACKCODE_BROWSER=default fuerza el navegador normal.
 */
export function openBrowser(url: string): void {
  const plain = () => void execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => undefined);
  if (process.env.BACKCODE_BROWSER === "default") return plain();
  if (process.platform === "darwin") {
    // La app de Mac ya sabe abrir su panel (sin token en la línea de comandos). Solo con el servicio instalado: si no, la
    // app lo instalaría y chocaría con el panel de esta terminal.
    for (const dir of ["/Applications", join(homedir(), "Applications")]) {
      if (serviceInstalled() && existsSync(join(dir, "Backcode Runner.app")) && !process.execPath.includes("Backcode Runner.app")) return void execFile("open", ["-a", join(dir, "Backcode Runner.app")], () => undefined);
    }
    const chromium = ["Google Chrome", "Brave Browser", "Microsoft Edge", "Chromium", "Vivaldi"].find((app) => existsSync(`/Applications/${app}.app`) || existsSync(join(homedir(), "Applications", `${app}.app`)));
    if (chromium) return void execFile("open", ["-na", chromium, "--args", `--app=${url}`], (err) => err && plain());
    return plain();
  }
  const bin = ["google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"].find((b) => (process.env.PATH ?? "").split(":").some((d) => existsSync(join(d, b))));
  if (bin) return void execFile(bin, [`--app=${url}`], (err) => err && plain());
  plain();
}

/** Vuelve a arrancar este proceso (mismos argumentos, misma terminal) con el código nuevo. */
function relaunch(): void {
  const execve = (process as unknown as { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
  if (execve) execve(process.execPath, [process.execPath, ...ownArgs()], process.env);
  // Node antiguo sin process.execve: este proceso solo espera al nuevo.
  const child = spawn(process.execPath, ownArgs(), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
