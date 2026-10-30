#!/usr/bin/env node

// `backcode` (o `npx backcode`): sin argumentos abre el panel. Los demás comandos, para quien prefiere la terminal.
// La versión se lee antes de cargar nada más: `--version` tiene que funcionar aunque falte algo (lo usa la actualización
// automática para comprobar que la versión nueva arranca).

const [command = "panel", ...rest] = process.argv.slice(2);
if (command === "--version" || command === "-v") {
  console.log((await import("./assets.js")).VERSION);
  process.exit(0);
}
// git usa la sesión de GitHub CLI (la del panel) para clonar y hacer push, en este proceso y en los runners que lance.
(await import("./github.js")).useGhForGit();
// La API key de Anthropic guardada desde el panel (si usas una en vez de un plan Pro o Max).
(await import("./anthropic.js")).loadSavedApiKey();

// El ejecutable sin Node lleva su propio motor (Bun); solo con Node hace falta la versión 22.
if (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`Backcode runner needs Node 22 or newer (you have ${process.version}): https://nodejs.org`);
  process.exit(1);
}

// Doble clic en «Backcode Runner.app»: instala, deja el servicio y abre el panel, sin terminal.
if (process.execPath.includes(".app/Contents/MacOS/")) {
  const appLaunch = await import("./app-launch.js");
  if (appLaunch.launchedAsApp()) await appLaunch.launchApp();
}

const { t } = await import("./i18n.js");
switch (command) {
  case "panel":
  case "serve": {
    const { servePanel } = await import("./panel.js");
    await servePanel({ open: command === "panel" && !rest.includes("--no-open") });
    break;
  }
  case "connect":
    await import("./connect.js");
    break;
  case "run":
    // Un runner (un proyecto): `backcode run --project <id>`. Lo usan el panel y `start` para cada proyecto.
    await import("./index.js");
    break;
  case "smoke":
    // Prueba de arranque de un OTA (la llama el script ota:publish del repo).
    await import("./smoke-cli.js");
    break;
  case "app-url": {
    // Para la app de Mac: prepara la instalación y el servicio, y devuelve la dirección del panel (la última línea).
    const { prepareApp } = await import("./app-launch.js");
    console.log(await prepareApp());
    process.exit(0);
    break;
  }
  case "task": {
    // Trabajo fuera de Backcode con sus pautas: worktree y rama de tarea, y PR registrado como tarea (task.ts).
    const { taskMain } = await import("./task.js");
    await taskMain(rest);
    break;
  }
  case "hook": {
    // Para el plugin de Claude Code (plugins/backcode/hooks): pautas de Backcode en sesiones normales. Nunca falla.
    const { hookMain } = await import("./workflow-guard.js");
    await hookMain(rest[0] ?? "").catch(() => undefined);
    process.exit(0);
    break;
  }
  case "deploys": {
    // Para la skill /backcode:setup: qué despliegues tiene el proyecto (y así qué sesiones comprobar). Sin secretos.
    const { deploysMain } = await import("./ready.js");
    await deploysMain(rest);
    break;
  }
  case "awake": {
    // «Mantener el ordenador despierto» del panel, desde la terminal (lo usa /backcode:setup).
    const { awakeMain } = await import("./ready.js");
    awakeMain(rest);
    break;
  }
  case "status":
    await import("./status.js");
    break;
  case "start":
    // `backcode start` todos en esta terminal; `backcode start <proyecto>…` solo esos.
    await import("./all.js");
    break;
  case "service": {
    const { installService, serviceInstalled, uninstallService, SERVICE_LOG } = await import("./service.js");
    const sub = rest[0] ?? "status";
    if (sub === "install") {
      await installService();
      console.log(t("cli.serviceOn", { log: SERVICE_LOG }));
    } else if (sub === "uninstall") {
      await uninstallService();
      console.log(t("cli.serviceOff"));
    } else console.log(t(serviceInstalled() ? "cli.serviceIsOn" : "cli.serviceIsOff"));
    break;
  }
  case "help":
  case "--help":
  case "-h":
    console.log(t("cli.help"));
    break;
  default:
    console.error(t("cli.unknown", { command }));
    console.log(t("cli.help"));
    process.exit(2);
}
