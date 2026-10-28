// Panel del runner: habla con la API de este mismo servidor (127.0.0.1). El token llega en el enlace (#t=…) que abre
// `backcode`; se guarda en la pestaña para que recargar funcione.

// También se recuerda en este navegador (localStorage, solo de tu usuario): así el panel instalado como app, o abierto
// sin el enlace, funciona sin volver a pasar por `backcode`.
const token = (() => {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("t");
  try {
    if (fromHash) {
      sessionStorage.setItem("backcode-token", fromHash);
      localStorage.setItem("backcode-token", fromHash);
      history.replaceState(null, "", location.pathname + location.search);
    }
    return fromHash || sessionStorage.getItem("backcode-token") || localStorage.getItem("backcode-token") || "";
  } catch {
    return fromHash || "";
  }
})();
// Dentro de la app de Mac (ventana nativa).
if (new URLSearchParams(location.search).has("native")) document.documentElement.classList.add("native");

let S = {}; // textos del idioma del runner
// Vista compacta: solo una fila por proyecto (estado, nombre, qué hace e interruptor). Se recuerda en este navegador.
let compact = (() => {
  try {
    return localStorage.getItem("backcode-compact") === "1";
  } catch {
    return false;
  }
})();
function setCompact(on) {
  compact = on;
  try {
    localStorage.setItem("backcode-compact", on ? "1" : "0");
  } catch {
    /* sin almacenamiento: solo esta vez */
  }
  document.documentElement.classList.toggle("compact", on);
  render();
  reportSize();
}

// En la app de Mac (ventana nativa): en compacto, la ventana se ajusta a lo que ocupa el panel; al salir, vuelve a su tamaño.
const native = window.webkit?.messageHandlers?.backcode;
let lastReported = "";
function reportSize() {
  if (!native) return;
  const height = compact ? Math.ceil(document.body.getBoundingClientRect().height) : 0;
  const key = `${compact}:${height}`;
  if (key === lastReported) return;
  // En completo solo se avisa al salir de la compacta: el tamaño que elijas para la vista completa no se toca.
  const leavingCompact = lastReported.startsWith("true");
  lastReported = key;
  if (compact || leavingCompact) native.postMessage({ compact, height });
}
if (native && "ResizeObserver" in window) new ResizeObserver(() => compact && reportSize()).observe(document.body);
// En la app de Mac la franja de arriba (la cabecera y lo que queda a sus lados, donde iría la barra de título) hace de
// barra de título: la ventana pone encima una capa nativa que la arrastra (la WKWebView no lo hace sola). Aquí se le dice
// hasta dónde llega la cabecera (sigue al scroll; nunca menos que la barra de título) y dónde están sus controles
// (vista compacta, idioma, encendido…), que siguen siendo de la página.
let lastDragRegion = "";
function reportDragRegion() {
  if (!native) return;
  const header = document.querySelector("header.top");
  const height = Math.max(28, Math.round(header ? header.getBoundingClientRect().bottom : 0));
  const holes = header
    ? [...header.querySelectorAll("button, select, input, a, textarea, label")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.bottom > 0 && r.width > 0)
        .map((r) => [r.left, r.top, r.width, r.height].map(Math.round))
    : [];
  const key = JSON.stringify([height, holes]);
  if (key === lastDragRegion) return;
  lastDragRegion = key;
  native.postMessage({ dragRegion: { height, holes } });
}
if (native) {
  addEventListener("scroll", reportDragRegion, { passive: true });
  addEventListener("resize", reportDragRegion);
  if ("ResizeObserver" in window) new ResizeObserver(reportDragRegion).observe(document.body);
}
document.documentElement.classList.toggle("compact", compact);
let state = null;
let logsFor = null;
let logsAfter = 0;
let confirmRemove = null;
let pastedText = "";
let answers = {};
let failures = 0;
let leaving = null;

const $ = (id) => document.getElementById(id);
/** Nombre a mostrar: el de la app; si el runner aún no lo ha apuntado, la carpeta del repo. */
const title = (p) => p.name || (p.repoPath ?? "").replace(/\/+$/, "").split("/").pop() || p.id;
const s = (key, vars) => (S[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));

/** Crea un elemento: h("button", { class: "primary", onclick }, "texto", hijo…). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "X-Backcode-Token": token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw Object.assign(new Error("token"), { token: true });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function copyButton(text) {
  const b = h("button", { type: "button", onclick: async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = s("copied");
      setTimeout(() => (b.textContent = s("copy")), 1500);
    } catch {
      /* sin permiso de portapapeles: se puede seleccionar a mano */
    }
  } }, s("copy"));
  return b;
}

// ── Pintar ─────────────────────────────────────────────────────────────────────────────────────────────────────

function renderStatic() {
  document.documentElement.lang = state.lang;
  $("lang").value = state.lang;
  if (logsFor) $("logs-title").textContent = s("logsTitle", { name: (state.projects.find((p) => p.id === logsFor) ? title(state.projects.find((p) => p.id === logsFor)) : logsFor) });
  for (const el of document.querySelectorAll("[data-s]")) el.textContent = s(el.dataset.s);
  $("version").textContent = `v${state.version}`;
  $("config-dir").textContent = s("configDir", { dir: state.configDir });
  const links = [["ios", "linkIos"], ["android", "linkAndroid"], ["web", "linkWeb"]].filter(([k]) => state.links?.[k]);
  $("links").replaceChildren(h("span", null, s("getApp")), ...links.map(([k, label]) => h("a", { href: state.links[k], target: "_blank", rel: "noreferrer" }, s(label))));
  $("links").hidden = !links.length;
}

function renderCompactControls() {
  const btn = $("compact");
  btn.textContent = s(compact ? "viewFull" : "viewCompact");
  btn.setAttribute("aria-pressed", String(compact));
  // En compacto, si falta algo en el ordenador o hay versión nueva, un aviso que vuelve a la vista completa.
  const missing = state.checks.filter((c) => c.status !== "ok").length;
  const alert = $("compact-alert");
  const text = missing ? s("compactMissing", { n: missing }) : state.restartNeeded || state.updateAvailable ? s("compactUpdate") : "";
  alert.textContent = text;
  alert.hidden = !compact || !text;
}

function render() {
  renderCompactControls();
  $("mode").textContent = state.service.self ? s("mode.service") : s("mode.foreground");
  renderPower();
  renderBanner();
  reportDragRegion();
  renderLegacy();
  renderChecks();
  renderProjects();
  renderService();
  renderDevices();
  renderAssign();
}

// «Decretazos» de tu perfil de la app, solo para verlo aquí (se cambia en la app: Perfil › Decretazos).
function renderAssign() {
  const known = typeof state.allowAdminAssign === "boolean";
  $("assign-section").hidden = !known;
  if (!known) return;
  $("assign-dot").className = `dot ${state.allowAdminAssign ? "ok" : ""}`;
  $("assign-state").textContent = s(state.allowAdminAssign ? "assignStateOn" : "assignStateOff");
  $("assign-body").textContent = s(state.allowAdminAssign ? "assignOn" : "assignOff");
}

function renderBanner() {
  const el = $("banner");
  el.replaceChildren();
  if (state.leaving === "restart") {
    // El panel sigue respondiendo mientras espera a los runners: que se vea a qué espera (antes parecía que no hacía nada).
    el.append(h("span", null, state.waitingFor.length ? s("restartWaiting", { names: state.waitingFor.join(", ") }) : s("restarting")));
  } else if (state.restartNeeded) {
    el.append(h("span", null, s("restartNeeded")), h("button", { type: "button", class: "primary", onclick: restartPanel }, s("restartPanel")));
  } else if (state.updateAvailable) {
    if (state.updateMode === "manual") {
      el.append(h("span", null, s("updateManual", { version: state.latest })), h("div", { class: "cmd" }, h("code", null, "npx backcode@latest"), copyButton("npx backcode@latest")));
    } else {
      el.append(h("span", null, s("update", { version: state.latest })), h("button", { type: "button", onclick: (e) => { e.target.disabled = true; api("POST", "/api/update").then(apply, () => undefined); } }, s("updateNow")));
    }
  }
  el.hidden = !el.childElementCount;
}

function renderLegacy() {
  const box = $("legacy");
  box.replaceChildren(...state.legacy.map((l) => h("div", { class: "banner warning" },
    h("div", { class: "text" },
      h("strong", null, s("legacyTitle", { n: l.ids.length, dir: l.dir })),
      h("span", null, s(l.running ? "legacyRunning" : "legacyBody"))),
    h("button", { type: "button", class: "primary", onclick: (e) => { e.target.disabled = true; api("POST", "/api/import", { dir: l.dir }).then(apply, refresh); } }, s("legacyImport")))));
}

// Guía de cada requisito que falta (como la de la app): pasos, el botón que lo hace por ti y el comando por si prefieres
// hacerlo a mano. El resultado de cada botón se queda en fixResult hasta la siguiente comprobación.
let fixResult = {};

function guideKey(c) {
  if (c.id === "gh") return c.missing === "session" ? "guide.ghSession" : "guide.gh";
  if (c.id === "git" && state.platform !== "darwin") return "guide.gitLinux";
  if (c.id === "login" && state.platform !== "darwin") return "guide.loginLinux";
  return `guide.${c.id}`;
}

async function fix(c, action, button) {
  button.disabled = true;
  fixResult[c.id] = { busy: true };
  renderChecks();
  try {
    const r = await api("POST", "/api/fix", { action });
    fixResult[c.id] = r.device ? { device: r.device } : r.terminal ? { note: s("terminalOpened") } : r.ok ? { note: s("fixDone") } : { error: `${s("fixFailed")} ${r.output ?? ""}` };
    if (r.state) apply(r.state);
    if (r.device) {
      window.open(r.device.url, "_blank", "noopener");
      waitForGithub();
    }
  } catch (err) {
    fixResult[c.id] = { error: `${s("fixFailed")} ${err.message}` };
  }
  renderChecks();
}

// Mientras se autoriza GitHub en el navegador, se comprueba cada pocos segundos hasta que la sesión existe.
let githubTimer = null;
function waitForGithub(onDone) {
  clearInterval(githubTimer);
  let tries = 0;
  githubTimer = setInterval(async () => {
    const next = await api("POST", "/api/checks").catch(() => null);
    if (next) apply(next);
    if (next?.checks.find((c) => c.id === "gh")?.status === "ok" || ++tries > 120) {
      clearInterval(githubTimer);
      delete fixResult.gh;
      renderChecks();
      onDone?.();
    }
  }, 4000);
}

/** Alternativa a iniciar sesión: una API key de Anthropic, pegada aquí. */
function apiKeyBox() {
  if (state.apiKeySaved) {
    return h("div", { class: "row" }, h("span", { class: "muted small" }, s("apiKeySaved")),
      h("button", { type: "button", class: "link danger", onclick: () => api("POST", "/api/anthropic-key", { remove: true }).then(apply, () => undefined) }, s("apiKeyRemove")));
  }
  const input = h("input", { type: "password", placeholder: "sk-ant-…", autocomplete: "off" });
  const err = h("div", { class: "error", hidden: true });
  return h("details", { class: "apikey" },
    h("summary", null, s("apiKeyQuestion")),
    h("div", { class: "muted small" }, s("apiKeyBody")),
    input,
    h("div", { class: "row" }, h("button", { type: "button", onclick: async (e) => {
      e.target.disabled = true;
      err.hidden = true;
      try {
        apply(await api("POST", "/api/anthropic-key", { key: input.value }));
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
      e.target.disabled = false;
    } }, s("apiKeySave"))),
    err);
}

function deviceBox(device) {
  return h("div", { class: "device" },
    h("div", { class: "muted small" }, s("ghCodeIntro")),
    h("div", { class: "code-row" }, h("code", { class: "device-code" }, device.code), copyButton(device.code)),
    h("div", { class: "row" }, h("a", { class: "button primary", href: device.url, target: "_blank", rel: "noreferrer" }, s("ghOpen"))),
    h("div", { class: "muted small" }, s("ghWaiting")));
}

// Solo se repinta si algo ha cambiado: si no, un campo a medio escribir (la API key) o un desplegable abierto se perderían.
let checksKey = "";
function renderChecks() {
  const key = JSON.stringify([state.checks, state.checking, state.apiKeySaved, state.lang, fixResult]);
  if (key === checksKey) return;
  checksKey = key;
  const list = $("checks");
  list.replaceChildren();
  if (!state.checks.length) {
    list.append(h("li", null, h("span", { class: "dot" }), h("span", { class: "detail muted" }, s("checking"))));
    return;
  }
  for (const c of state.checks) {
    const result = fixResult[c.id];
    const guide = c.status === "ok" ? null : h("div", { class: "guide" },
      h("ol", { class: "steps" }, s(guideKey(c)).split("\n").map((step) => h("li", null, step))),
      c.actions?.length ? h("div", { class: "row" }, c.actions.map((a) => h("button", { type: "button", class: "primary", disabled: result?.busy, onclick: (e) => fix(c, a, e.target) }, s(`action.${a}`)))) : null,
      result?.busy ? h("div", { class: "muted" }, s("fixRunning")) : null,
      result?.device ? deviceBox(result.device) : null,
      result?.note ? h("div", { class: "success" }, result.note) : null,
      result?.error ? h("pre", { class: "fix-error" }, result.error) : null,
      c.fix ? (c.fix.startsWith("http")
        ? h("div", { class: "row" }, h("a", { class: "button", href: c.fix, target: "_blank", rel: "noreferrer" }, s("openSite")))
        : h("div", null, h("div", { class: "muted small" }, s("manual")), h("div", { class: "cmd" }, h("code", null, c.fix), copyButton(c.fix)))) : null,
      c.id === "login" ? apiKeyBox() : null);
    list.append(h("li", null,
      h("span", { class: `dot ${c.status}`, title: c.status }),
      h("div", { class: "detail" },
        h("div", null, h("strong", null, s(`check.${c.id}`)), " · ", h("span", { class: c.status === "ok" ? "muted" : "" }, c.detail)),
        guide)));
  }
  $("recheck").disabled = state.checking;
}

function renderProjects() {
  const box = $("projects");
  box.replaceChildren();
  if (!state.projects.length) {
    box.append(h("div", { class: "card empty" }, s("noProjects")));
    return;
  }
  if (compact) return renderCompactProjects(box);
  for (const p of state.projects) {
    const act = (action) => (e) => {
      e.target.disabled = true;
      api("POST", `/api/projects/${encodeURIComponent(p.id)}/${action}`).then(refresh, refresh);
    };
    const active = p.state === "running" || p.state === "retrying";
    const toggle = h("input", { type: "checkbox", checked: active || p.state === "stopping", disabled: p.state === "stopping", onchange: (e) => act(e.target.checked ? "start" : "stop")(e) });
    const actions = confirmRemove === p.id
      ? [h("span", null, s("removeConfirm", { name: title(p) })), h("button", { type: "button", class: "danger", onclick: (e) => { confirmRemove = null; act("remove")(e); } }, s("removeYes")), h("button", { type: "button", onclick: () => { confirmRemove = null; render(); } }, s("cancel"))]
      : [
          h("button", { type: "button", onclick: () => openLogs(p) }, s("logs")),
          p.state === "running" ? h("button", { type: "button", onclick: act("restart") }, s("restart")) : null,
          h("button", { type: "button", class: "link danger", onclick: () => { confirmRemove = p.id; render(); } }, s("remove")),
        ];
    box.append(h("div", { class: "card project" },
      h("div", { class: "head" },
        h("span", { class: `dot ${p.state}` }),
        h("span", { class: "name" }, title(p)),
        h("span", { class: "state" }, s(`state.${p.state}`)),
        h("label", { class: "switch", title: s(active ? "stop" : "start") }, toggle, h("span", { class: "slider", "aria-hidden": "true" }))),
      h("div", { class: "meta" }, [p.repoPath, s(`pr.${p.pullRequest}`)].filter(Boolean).join(" · ")),
      p.lastLine ? h("div", { class: "last", title: p.lastLine }, p.lastLine) : null,
      h("div", { class: "row" }, actions)));
  }
}

function renderCompactProjects(box) {
  const list = h("ul", { class: "checks compact-list" });
  for (const p of state.projects) {
    const active = p.state === "running" || p.state === "retrying";
    const toggle = h("input", { type: "checkbox", checked: active || p.state === "stopping", disabled: p.state === "stopping", onchange: (e) => {
      e.target.disabled = true;
      api("POST", `/api/projects/${encodeURIComponent(p.id)}/${e.target.checked ? "start" : "stop"}`).then(refresh, refresh);
    } });
    list.append(h("li", { class: "crow" },
      h("span", { class: `dot ${p.state}` }),
      h("div", { class: "detail" },
        h("div", { class: "crow-head" }, h("strong", { class: "name" }, title(p)), h("span", { class: "state" }, s(`state.${p.state}`))),
        h("div", { class: "last", title: p.lastLine ?? "" }, p.lastLine ?? "")),
      h("button", { type: "button", class: "icon-button", title: s("logs"), "aria-label": s("logs"), onclick: () => { setCompact(false); openLogs(p); } }, "≡"),
      h("label", { class: "switch small", title: s(active ? "stop" : "start") }, toggle, h("span", { class: "slider", "aria-hidden": "true" }))));
  }
  box.append(list);
}

function renderPower() {
  const button = $("power");
  button.setAttribute("aria-pressed", String(!state.off));
  button.textContent = s(state.off ? "powerOff" : "powerOn");
  button.title = s(state.off ? "powerOffHint" : "powerOnHint");
  if (!powerBusy) button.disabled = !!leaving;
}

let powerBusy = false;
async function togglePower() {
  const button = $("power");
  powerBusy = true;
  button.disabled = true;
  try {
    await api("POST", "/api/power", { on: !!state.off });
  } finally {
    powerBusy = false;
    button.disabled = false;
    await refresh();
  }
}

function renderService() {
  const input = $("service");
  input.checked = state.service.installed;
  input.disabled = !state.service.supported || !!leaving;
  $("service-body").textContent = !state.service.supported ? s("serviceUnsupported") : state.service.installed ? s("serviceBodyOn") : state.service.self ? s("serviceBodyRunning") : s("serviceBodyOff");
}

// ── Logs ───────────────────────────────────────────────────────────────────────────────────────────────────────

function openLogs(p) {
  logsFor = p.id;
  logsAfter = 0;
  $("logs").textContent = "";
  $("logs-title").textContent = s("logsTitle", { name: title(p) });
  $("logs-section").hidden = false;
  pollLogs();
  $("logs-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function pollLogs() {
  if (!logsFor) return;
  try {
    const { lines } = await api("GET", `/api/logs?project=${encodeURIComponent(logsFor)}&after=${logsAfter}`);
    if (lines.length) {
      const pre = $("logs");
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.append(lines.map((l) => l.text).join("\n") + "\n");
      logsAfter = lines.at(-1).seq;
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  } catch {
    /* se reintenta en el siguiente ciclo */
  }
}

// ── Conectar ───────────────────────────────────────────────────────────────────────────────────────────────────

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!/BACKCODE_/.test(text)) throw new Error("empty");
    $("config").value = text;
    connect(true);
  } catch {
    showResult([h("div", { class: "error" }, s("clipboardDenied"))]);
    showTextarea();
  }
}

function showTextarea() {
  $("config").hidden = false;
  $("connect-row").hidden = false;
  $("config").focus();
}

function showResult(children) {
  const el = $("connect-result");
  const shown = children.filter(Boolean);
  el.replaceChildren(...shown);
  el.hidden = !shown.length;
}

async function connect(fresh) {
  if (fresh) {
    pastedText = $("config").value;
    answers = {};
  }
  if (!pastedText.trim()) return showTextarea();
  $("ask").hidden = true;
  $("connect").disabled = $("paste").disabled = true;
  showResult([h("div", { class: "muted" }, s("connecting"))]);
  try {
    const r = await api("POST", "/api/connect", { text: pastedText, answers });
    const notes = r.notes?.length ? h("ul", null, r.notes.map((n) => h("li", null, n))) : null;
    const ignored = r.ignored?.length ? h("div", { class: "muted" }, s("ignoredKeys", { list: r.ignored.join(", ") })) : null;
    if (r.ok) {
      $("config").value = "";
      pastedText = "";
      $("config").hidden = $("connect-row").hidden = true;
      await refresh();
      const connected = state.projects.find((p) => p.id === r.projectId);
      showResult([h("div", { class: "success" }, s("connected", { name: connected ? title(connected) : r.projectId })), notes, ignored]);
    } else if (r.error) {
      showResult([h("div", { class: "error" }, r.error), notes]);
    } else if (r.need === "clone") {
      showResult([notes]);
      ask([
        h("p", null, s("askClone", { path: r.path, url: r.url })),
        h("div", { class: "row" },
          h("button", { type: "button", class: "primary", onclick: () => { answers.clone = true; connect(); } }, s("cloneYes")),
          h("button", { type: "button", onclick: () => { answers.clone = false; connect(); } }, s("cloneNo"))),
      ]);
    } else if (r.need === "repo") {
      showResult([notes]);
      const pick = async (e) => {
        e.target.disabled = true;
        const p = await api("POST", "/api/pick-folder").catch(() => null);
        e.target.disabled = false;
        if (p?.path) { answers.repoPath = p.path; connect(); }
      };
      ask([
        h("p", null, h("strong", null, s("repoTitle"))),
        h("p", { class: "muted" }, s(r.url ? "repoBody" : "repoBodyNoUrl")),
        h("div", { class: "row" },
          r.url ? h("button", { type: "button", class: "primary", onclick: () => { answers.clone = true; answers.clonePath = r.clonePath; connect(); } }, s("repoClone", { path: r.clonePath.replace(/^\/Users\/[^/]+/, "~") })) : null,
          state.platform === "darwin" ? h("button", { type: "button", onclick: pick }, s("repoPick")) : null),
        r.candidates.length ? h("div", { class: "muted small" }, s("repoFoundList")) : null,
        r.candidates.length ? h("div", { class: "repos" }, r.candidates.slice(0, 10).map((c) =>
          h("button", { type: "button", class: "repo", onclick: () => { answers.repoPath = c.path; connect(); } },
            h("strong", null, c.name), h("span", { class: "muted small" }, c.remote ?? c.path)))) : null,
        state.platform === "darwin" ? null : h("div", null, h("input", { type: "text", placeholder: "/home/…/repo", onchange: (e) => { answers.repoPath = e.target.value.trim(); connect(); } })),
      ]);
    } else if (r.need === "bitbucket") {
      showResult([notes]);
      const email = h("input", { type: "email", placeholder: s("bbEmail"), value: r.email || "", autocomplete: "off" });
      const tok = h("input", { type: "password", placeholder: s("bbToken"), autocomplete: "off" });
      ask([
        h("p", null, h("strong", null, s("bbTitle"))),
        h("p", { class: r.retry ? "error" : "muted" }, r.problem),
        h("ol", { class: "steps" },
          h("li", null, h("a", { href: "https://id.atlassian.com/manage-profile/security/api-tokens", target: "_blank", rel: "noreferrer" }, s("bbStep1"))),
          h("li", null, s("bbStep2")),
          h("li", null, s("bbStep3"), h("div", { class: "cmd" }, h("code", null, "read:user:bitbucket, read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket")), h("p", { class: "muted" }, s("bbCreateScope")))),
        email,
        tok,
        h("div", { class: "row" },
          h("button", { type: "button", class: "primary", onclick: () => { answers.bitbucket = { email: email.value.trim(), token: tok.value.trim() }; connect(); } }, s("bbSave")),
          h("button", { type: "button", onclick: () => { answers.bitbucket = "skip"; connect(); } }, s("bbSkip"))),
      ]);
    }
  } catch (err) {
    showResult([h("div", { class: "error" }, err.message)]);
  } finally {
    $("connect").disabled = $("paste").disabled = false;
  }
}

function ask(children) {
  const el = $("ask");
  el.replaceChildren(...children.filter(Boolean));
  el.hidden = false;
}

// ── Cuentas ────────────────────────────────────────────────────────────────────────────────────────────────────
// Sesión de gh y token de Bitbucket de tu cuenta: los usa el runner para crear proyectos desde la app y abrir sus PR.
// Se piden aparte del estado (comprobarlos llama a gh y a Bitbucket) al abrir el panel y al guardar.

let accounts = null;
let bbForm = false;
let bbMessage = null;

async function loadAccounts() {
  try {
    accounts = await api("GET", "/api/accounts");
  } catch {
    accounts = null;
  }
  renderAccounts();
}

// Cuentas con las que el runner abre PR y crea repos nuevos: una fila por servicio, como «Este ordenador».
let ghDevice = null;
// ── Móviles («Instalar en mi móvil» de la app) ─────────────────────────────────────────────────────────────────

function renderDevices() {
  const box = $("devices");
  if (!box) return;
  const devices = state.devices ?? [];
  const rows = devices.map((d) => {
    const ready = d.state === "ready";
    const meta = [d.model !== d.name ? d.model : null, d.os, ready ? s(d.connection === "wired" ? "deviceCable" : "deviceWifi") : null].filter(Boolean).join(" · ");
    return h("li", null,
      h("span", { class: `dot ${ready ? "ok" : "warn"}` }),
      h("div", { class: "detail" },
        h("div", null, h("strong", null, d.name), meta ? h("span", { class: "muted" }, ` · ${meta}`) : null),
        ready ? h("div", { class: "muted small" }, s("deviceReady")) : h("div", { class: "small" }, s(`deviceFix.${d.state}`))));
  });
  if (!devices.length) rows.push(h("li", null, h("span", { class: "dot" }), h("div", { class: "detail muted" }, s("devicesNone"))));
  const help = (state.devicePlatforms ?? []).map((p) => h("li", null, h("span", { class: "dot" }), h("div", { class: "detail small muted", style: "white-space: pre-line" }, s(p === "ios" ? "devicePairIos" : "devicePairAndroid"))));
  box.replaceChildren(...rows, ...help);
  $("devices-section").hidden = !(state.devicePlatforms ?? []).length;
}

function renderAccounts() {
  const box = $("accounts");
  if (!box || !state) return;
  if (!accounts) return box.replaceChildren(h("li", null, h("span", { class: "dot" }), h("span", { class: "detail muted" }, s("checking"))));
  const bb = accounts.bitbucket;
  const gh = accounts.github;
  const ghCheck = state.checks.find((c) => c.id === "gh");

  const githubButton = gh ? null : h("button", { type: "button", class: "primary", disabled: ghCheck?.missing === "program", onclick: async (e) => {
    e.target.disabled = true;
    const r = await api("POST", "/api/fix", { action: "login-gh" }).catch((err) => ({ output: err.message }));
    if (r.device) {
      ghDevice = r.device;
      window.open(r.device.url, "_blank", "noopener");
      waitForGithub(() => { ghDevice = null; loadAccounts(); });
    }
    renderAccounts();
  } }, s("action.login-gh"));
  // Tres columnas: punto · texto (baja de línea si no cabe) · botón. El botón nunca encima del texto.
  const githubRow = h("li", { class: "account" },
    h("span", { class: `dot ${gh ? "ok" : "warn"}` }),
    h("div", { class: "detail" },
      h("div", null, h("strong", null, "GitHub"), " · ", h("span", { class: gh ? "muted" : "" }, gh ? s("accountAs", { who: gh.login }) : s("accountNone"))),
      h("div", { class: "muted small" }, s("accountGithubUse")),
      ghCheck?.missing === "program" && !gh ? h("div", { class: "muted small" }, s("accountGhMissing")) : null,
      ghDevice && !gh ? deviceBox(ghDevice) : null),
    githubButton ?? h("span"));

  const bitbucketRow = h("li", { class: "account" },
    h("span", { class: `dot ${bb && !bb.problem ? "ok" : bb?.problem ? "fail" : ""}` }),
    h("div", { class: "detail" },
      h("div", null, h("strong", null, "Bitbucket"), " · ", h("span", { class: bb && !bb.problem ? "muted" : "" }, bb ? (bb.problem ? s("bbAccountBad", { problem: bb.problem }) : s("accountAs", { who: bb.email })) : s("accountNoToken"))),
      h("div", { class: "muted small" }, s("accountBitbucketUse")),
      bbMessage ? h("div", { class: bbMessage.error ? "error" : "success" }, bbMessage.text) : null,
      bbForm ? bitbucketForm(bb) : null),
    bbForm ? h("span") : h("button", { type: "button", class: bb ? undefined : "primary", onclick: () => { bbForm = true; bbMessage = null; renderAccounts(); } }, s(bb ? "accountChange" : "accountAdd")));

  box.replaceChildren(githubRow, bitbucketRow);
}

function bitbucketForm(bb) {
  const email = h("input", { type: "email", placeholder: s("bbEmail"), value: bb?.email || "", autocomplete: "off" });
  const tok = h("input", { type: "password", placeholder: s("bbToken"), autocomplete: "off" });
  const save = h("button", { type: "button", class: "primary", onclick: async () => {
    save.disabled = true;
    try {
      const r = await api("POST", "/api/accounts/bitbucket", { email: email.value.trim(), token: tok.value.trim() });
      if (r.error) bbMessage = { error: true, text: r.error };
      else {
        bbMessage = { text: s("bbSaved") };
        bbForm = false;
      }
    } catch (err) {
      bbMessage = { error: true, text: err.message };
    }
    await loadAccounts();
  } }, s("bbSave"));
  return h("div", { class: "guide" },
    h("ol", { class: "steps" },
      h("li", null, h("a", { href: "https://id.atlassian.com/manage-profile/security/api-tokens", target: "_blank", rel: "noreferrer" }, s("bbStep1"))),
      h("li", null, s("bbStep2")),
      h("li", null, s("bbStep3"), h("div", { class: "cmd" }, h("code", null, "read:user:bitbucket, read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, admin:repository:bitbucket"), copyButton("read:user:bitbucket, read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, admin:repository:bitbucket")))),
    email,
    tok,
    h("div", { class: "row" }, save, h("button", { type: "button", class: "link", onclick: () => { bbForm = false; bbMessage = null; renderAccounts(); } }, s("cancel"))));
}

// ── Servicio y reinicio ────────────────────────────────────────────────────────────────────────────────────────

async function toggleService() {
  const enabled = $("service").checked;
  $("service").disabled = true;
  $("service-error").hidden = true;
  if (enabled) $("service-body").textContent = s("serviceInstalling");
  try {
    const r = await api("POST", "/api/service", { enabled });
    if (r.error) throw new Error(r.error);
    if (r.handoff) leaving = "handoff";
    if (r.stopping) leaving = "gone";
  } catch (err) {
    $("service-error").textContent = err.message;
    $("service-error").hidden = false;
  }
  await refresh();
}

async function restartPanel() {
  leaving = "restart";
  await api("POST", "/api/restart").catch(() => undefined);
  showOffline();
}

function showOffline(message) {
  $("offline-text").textContent = message ?? (leaving === "gone" ? s("offlineGone") : leaving === "handoff" ? s("handoff") : leaving === "restart" ? s("restarting") : s("offline"));
  $("offline").hidden = false;
}

// ── Ciclo ──────────────────────────────────────────────────────────────────────────────────────────────────────

function apply(next) {
  // También si llegan textos que antes no estaban (el panel se ha actualizado con la página abierta).
  const relabel = !state || state.lang !== next.lang || Object.keys(next.strings).length !== Object.keys(S).length;
  state = next;
  S = next.strings;
  if (relabel) {
    renderStatic();
    renderAccounts();
  }
  render();
  // Abierta ya en compacto: la ventana se ajusta en cuanto hay filas que medir.
  if (compact) requestAnimationFrame(reportSize);
}

async function refresh() {
  try {
    apply(await api("GET", `/api/state?lang=${encodeURIComponent(navigator.language || "")}`));
    failures = 0;
    if (leaving !== "gone") leaving = null;
    $("offline").hidden = true;
  } catch (err) {
    if (err.token) return showOffline(S.noToken ?? "Open the panel with: npx backcode");
    if (++failures >= 2 || leaving) showOffline();
  }
}

if (!token) {
  showOffline("Open the panel with: npx backcode");
} else {
  $("recheck").addEventListener("click", () => { fixResult = {}; api("POST", "/api/checks").then(apply, () => undefined); });
  $("paste").addEventListener("click", pasteFromClipboard);
  $("show-text").addEventListener("click", showTextarea);
  $("connect").addEventListener("click", () => connect(true));
  $("logs-close").addEventListener("click", () => { logsFor = null; $("logs-section").hidden = true; });
  $("service").addEventListener("change", toggleService);
  $("power").addEventListener("click", () => void togglePower());

  $("compact").addEventListener("click", () => setCompact(!compact));
  $("compact-alert").addEventListener("click", () => setCompact(false));
  $("lang").addEventListener("change", (e) => api("POST", "/api/lang", { lang: e.target.value }).then(apply, () => undefined));
  refresh().then(loadAccounts);
  setInterval(refresh, 2000);
  setInterval(pollLogs, 1500);
}
