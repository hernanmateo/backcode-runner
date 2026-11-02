// Backcode Runner.app: una ventana nativa de macOS con el panel del runner dentro (sin navegador).
//
// El runner es el ejecutable de Contents/Resources/backcode. Al abrir la app se le pide `backcode app-url`: lo instala en
// ~/.backcode/bin si hace falta, lo deja como servicio («Arrancar al iniciar sesión»), espera al panel y devuelve su
// dirección (con el token), que se carga aquí. Cerrar la ventana cierra la app, no el runner: sigue en segundo plano.
// Los enlaces que salen del panel (GitHub, descargas…) se abren en el navegador.

import AppKit
import WebKit

/**
 * La WKWebView guarda el último clic: el aviso de arrastre del panel llega después, por mensaje, cuando NSApp.currentEvent
 * ya no es ese mouseDown (y performDrag con otro evento no hace nada: la ventana no se movía).
 */
final class PanelWebView: WKWebView {
  var lastMouseDown: NSEvent?
  override func mouseDown(with event: NSEvent) {
    lastMouseDown = event
    super.mouseDown(with: event)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  var window: NSWindow!
  var webView: PanelWebView!
  let spinner = NSProgressIndicator()
  /** Tamaño de la ventana en la vista completa, para volver a él al salir de la compacta. */
  var fullFrame: NSRect?
  /** Mínimos: en compacto, unas filas; en completo, lo justo para que el panel no se apriete. */
  static let compactMin = NSSize(width: 340, height: 150)
  static let fullMin = NSSize(width: 560, height: 620)
  /** Desde cuándo no responde el panel (nil mientras carga bien) y si ya se está avisando. */
  var failingSince: Date?
  var alerting = false
  /** Dirección del panel: si la primera carga falla, reload() no tiene página que recargar. */
  var panelURL: URL?
  /** El paso en curso bajo el spinner («Starting the service…», «Waiting for the panel…»…), lo cuenta `backcode app-url`. */
  let statusLabel = NSTextField(labelWithString: "")
  /** ¿Ha llegado el panel a didFinish desde el último start()? Mientras no, manda el límite global (watchdog). */
  var loaded = false
  /** Intento en curso: las respuestas de un intento anterior (tras un aviso o un Retry) se ignoran. */
  var attempt = 0
  var watchdog: DispatchWorkItem?
  /** `backcode app-url` en marcha, para pararlo si se pasa del límite. */
  var runnerProcess: Process?
  /** Límite global: como mucho en este tiempo hay panel o aviso con el motivo (nunca el spinner para siempre). */
  static let startLimit: TimeInterval = 60
  /** Límite de `backcode app-url`: por debajo del global, para que llegue su diagnóstico antes del aviso genérico. */
  static let runnerLimit: TimeInterval = 55
  /** Cada carga del panel: si el puerto acepta la conexión pero no contesta, falla pronto (no a los ~60 s de URLRequest). */
  static let loadTimeout: TimeInterval = 10

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    // El panel avisa de la vista compacta y de cuánto ocupa, y de cuándo se arrastra la ventana desde su cabecera
    // (window.webkit.messageHandlers.backcode).
    config.userContentController.add(self, name: "backcode")
    webView = PanelWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.setValue(false, forKey: "drawsBackground") // sin destello blanco antes de pintar (el panel pone su fondo)

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.title = "Backcode Runner"
    window.titleVisibility = .hidden // el panel ya lleva su cabecera
    window.titlebarAppearsTransparent = true
    window.minSize = Self.fullMin // en compacto baja a compactMin (lo pide el panel)
    window.backgroundColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(red: 0.12, green: 0.118, blue: 0.114, alpha: 1) : NSColor(red: 0.961, green: 0.949, blue: 0.918, alpha: 1) }
    window.contentView = webView
    window.setFrameAutosaveName("BackcodeRunnerMain")
    if !window.setFrameUsingName("BackcodeRunnerMain") { window.center() }

    spinner.style = .spinning
    spinner.translatesAutoresizingMaskIntoConstraints = false
    webView.addSubview(spinner)
    NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: webView.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: webView.centerYAnchor)])
    spinner.startAnimation(nil)

    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.alignment = .center
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    statusLabel.lineBreakMode = .byTruncatingTail
    webView.addSubview(statusLabel)
    NSLayoutConstraint.activate([
      statusLabel.centerXAnchor.constraint(equalTo: webView.centerXAnchor),
      statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
      statusLabel.widthAnchor.constraint(lessThanOrEqualTo: webView.widthAnchor, constant: -40),
    ])

    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    start()
  }

  /** Por qué no se ha podido abrir el panel (lo diagnostica `backcode app-url` o lo decide la app al pasarse del límite). */
  struct StartFailure {
    var reason: String
    var hint: String?
    var log: [String] = []
    /** Ofrecer «Open Login Items» (Configuración del Sistema › General › Ítems de inicio). */
    var loginItems = false
    /** Ofrecer «Start without service» (no tiene sentido si ya se ha probado sin servicio). */
    var canSkipService = true
  }

  enum RunnerResult {
    case url(String)
    case failed(StartFailure)
  }

  static let logPath = "\(NSHomeDirectory())/.backcode/logs/service.log"
  static let loginItemsURL = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!

  func setStatus(_ text: String) {
    statusLabel.stringValue = text
    statusLabel.isHidden = text.isEmpty
  }

  /** La carga del panel, con tiempo máximo corto. */
  func panelRequest(_ url: URL) -> URLRequest {
    URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: Self.loadTimeout)
  }

  /**
   * Pide al runner que se instale (si hace falta) y devuelva la dirección del panel. `retry`: desde «Retry», con el panel
   * ya visto sin responder: el runner relanza el servicio (`launchctl kickstart -k`). `noService`: «Start without
   * service»: el panel en segundo plano sin launchd. Arma el límite global: si en `startLimit` no hay panel, aviso.
   */
  func start(retry: Bool = false, noService: Bool = false) {
    attempt += 1
    let current = attempt
    loaded = false
    failingSince = nil
    spinner.isHidden = false
    spinner.startAnimation(nil)
    setStatus("Starting…")
    watchdog?.cancel()
    let dog = DispatchWorkItem { [weak self] in
      guard let self, current == self.attempt, !self.loaded else { return }
      self.webView.stopLoading()
      self.startFailed(StartFailure(
        reason: "The runner's panel didn't open within \(Int(Self.startLimit)) seconds.",
        hint: "The background service may be stuck or blocked by macOS. Check System Settings › General › Login Items › Allow in the Background, or run `backcode` in Terminal to see what happens.",
        loginItems: true,
        canSkipService: !noService))
    }
    watchdog = dog
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.startLimit, execute: dog)

    var args = ["app-url"]
    if retry { args.append("--retry") }
    if noService { args.append("--no-service") }
    DispatchQueue.global(qos: .userInitiated).async {
      let result = Self.runRunner(args, onStatus: { text in
        DispatchQueue.main.async { if current == self.attempt, !self.loaded { self.setStatus(text) } }
      }, onProcess: { process in
        DispatchQueue.main.async { self.runnerProcess = process }
      })
      DispatchQueue.main.async {
        guard current == self.attempt, !self.alerting else { return }
        self.runnerProcess = nil
        switch result {
        case .url(let line):
          // ?native=1: el panel deja sitio a los botones de la ventana (rojo, amarillo y verde).
          if let url = URL(string: line.replacingOccurrences(of: "/#", with: "/?native=1#")) {
            self.panelURL = url
            self.setStatus("Loading the panel…")
            self.webView.load(self.panelRequest(url))
          } else {
            self.startFailed(StartFailure(reason: "The runner didn't return the panel's address."))
          }
        case .failed(var failure):
          if noService { failure.canSkipService = false }
          self.startFailed(failure)
        }
      }
    }
  }

  /**
   * El runner no arranca o su panel no responde: se dice con el motivo, qué hacer y botones para arreglarlo, en vez de
   * dejar el spinner para siempre. «Open log» y «Open Login Items» vuelven a enseñar el aviso (luego, «Retry»).
   */
  func startFailed(_ failure: StartFailure) {
    guard !alerting else { return }
    alerting = true
    attempt += 1 // lo que llegue del intento anterior ya no cuenta
    watchdog?.cancel()
    if let process = runnerProcess, process.isRunning { process.terminate() }
    runnerProcess = nil
    spinner.stopAnimation(nil)
    setStatus("")

    enum Action { case retry, log, loginItems, noService, quit }
    var actions: [(Action, String)] = [(.retry, "Retry"), (.log, "Open log")]
    if failure.loginItems { actions.append((.loginItems, "Open Login Items")) }
    if failure.canSkipService { actions.append((.noService, "Start without service")) }
    actions.append((.quit, "Quit"))

    var text = failure.reason
    if let hint = failure.hint, !hint.isEmpty { text += "\n\n\(hint)" }
    if !failure.log.isEmpty { text += "\n\nLast lines of the log:\n\(failure.log.joined(separator: "\n"))" }
    text += "\n\nLog: ~/.backcode/logs/service.log"

    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Backcode Runner couldn't open its panel"
    alert.informativeText = text
    for (_, title) in actions { alert.addButton(withTitle: title) }
    let index = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
    alerting = false
    let action = actions.indices.contains(index) ? actions[index].0 : .quit
    switch action {
    case .quit:
      NSApp.terminate(nil)
    case .log:
      NSWorkspace.shared.open(URL(fileURLWithPath: Self.logPath))
      DispatchQueue.main.async { self.startFailed(failure) }
    case .loginItems:
      NSWorkspace.shared.open(Self.loginItemsURL)
      DispatchQueue.main.async { self.startFailed(failure) }
    case .noService:
      start(noService: true)
    case .retry:
      start(retry: true)
    }
  }

  /**
   * Ejecuta el runner de dentro de la app. Lee su salida línea a línea (no hasta el final: si algún hijo heredara la
   * tubería, readDataToEndOfFile no acabaría nunca): «status: …» va a `onStatus`; la última línea es la dirección o
   * «error: {json}» con el diagnóstico. Si tarda más de `runnerLimit`, se para y cuenta como fallo.
   */
  static func runRunner(_ args: [String], onStatus: @escaping (String) -> Void, onProcess: (Process) -> Void) -> RunnerResult {
    let notStarted = StartFailure(reason: "The runner didn't start.", hint: "Run `backcode` in Terminal to see what happens.")
    guard let runner = Bundle.main.url(forResource: "backcode", withExtension: nil) else { return .failed(notStarted) }
    let process = Process()
    process.executableURL = runner
    process.arguments = args
    var env = ProcessInfo.processInfo.environment
    // Abierta desde el Finder la app no hereda el PATH de tu terminal: el servicio lo guarda, así que se completa aquí.
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(NSHomeDirectory())/.local/bin", "\(NSHomeDirectory())/.backcode/bin"]
    env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
    process.environment = env
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice

    let lock = NSLock()
    var buffer = Data()
    var lines: [String] = []
    let done = DispatchSemaphore(value: 0)
    out.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      lock.lock()
      buffer.append(chunk)
      var statuses: [String] = []
      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
        buffer.removeSubrange(buffer.startIndex...newline)
        if line.hasPrefix("status: ") { statuses.append(String(line.dropFirst(8))) } else if !line.isEmpty { lines.append(line) }
      }
      lock.unlock()
      statuses.forEach(onStatus)
      // Fin de la tubería: no se vuelve a llamar.
      if chunk.isEmpty { handle.readabilityHandler = nil }
    }
    process.terminationHandler = { _ in done.signal() }
    do { try process.run() } catch {
      out.fileHandleForReading.readabilityHandler = nil
      return .failed(notStarted)
    }
    onProcess(process)
    let timedOut = done.wait(timeout: .now() + runnerLimit) == .timedOut
    if timedOut, process.isRunning { process.terminate() }
    // Lo último que escribió antes de salir puede llegar un instante después del final del proceso.
    Thread.sleep(forTimeInterval: 0.3)
    out.fileHandleForReading.readabilityHandler = nil
    lock.lock()
    if !buffer.isEmpty { lines.append(String(decoding: buffer, as: UTF8.self)) }
    let last = lines.last?.trimmingCharacters(in: .whitespacesAndNewlines)
    lock.unlock()

    if let last, last.hasPrefix("error: "), let failure = parseFailure(String(last.dropFirst(7))) { return .failed(failure) }
    if timedOut {
      return .failed(StartFailure(
        reason: "The runner took too long to start its service (over \(Int(runnerLimit)) seconds).",
        hint: "launchd may be stuck. Check System Settings › General › Login Items › Allow in the Background, or run `backcode` in Terminal.",
        loginItems: true))
    }
    if process.terminationStatus == 0, let last, last.hasPrefix("http") { return .url(last) }
    return .failed(notStarted)
  }

  /** El diagnóstico de `backcode app-url` (app-diagnose.ts): message, hint, log y loginItems. */
  static func parseFailure(_ json: String) -> StartFailure? {
    guard let data = json.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let message = object["message"] as? String else { return nil }
    return StartFailure(
      reason: message,
      hint: object["hint"] as? String,
      log: object["log"] as? [String] ?? [],
      loginItems: object["loginItems"] as? Bool ?? false,
      canSkipService: object["kind"] as? String != "no-panel")
  }

  // El panel se queda en la ventana; cualquier otra dirección, al navegador.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let url = action.request.url, url.host != "127.0.0.1", url.host != "localhost", url.scheme != "about" {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  // window.open (p. ej. «Conectar con GitHub»): en el navegador.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    failingSince = nil
    loaded = true
    watchdog?.cancel()
    spinner.stopAnimation(nil)
    spinner.isHidden = true
    setStatus("")
  }

  // Si el panel se reinicia (actualización), la página vuelve a cargar sola; si la carga falla, se reintenta. Tras 30 s
  // sin respuesta (el servicio no arranca, el puerto lo tiene otro programa…) se avisa en vez de seguir con el spinner.
  // Cada carga tiene su tiempo máximo (loadTimeout) y, antes de la primera, manda además el límite global (watchdog).
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    guard !alerting else { return }
    let err = error as NSError
    if err.domain == NSURLErrorDomain && err.code != NSURLErrorCancelled {
      let since = failingSince ?? Date()
      failingSince = since
      if !loaded { setStatus("Waiting for the panel…") }
      if Date().timeIntervalSince(since) > 30 {
        return startFailed(StartFailure(
          reason: "The runner's panel isn't responding (\(err.localizedDescription)).",
          hint: "Retry restarts the background service. If it keeps happening, check that nothing else uses port 47474 (`lsof -iTCP:47474`)."))
      }
    }
    let current = attempt
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
      guard current == self.attempt, !self.alerting else { return }
      if let url = self.panelURL { webView.load(self.panelRequest(url)) } else { webView.reload() }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { window.makeKeyAndOrderFront(nil) }
    return true
  }

  /** Menú mínimo: Acerca de, Ocultar, Salir; Edición (copiar y pegar en el panel); Ver (recargar); Ventana. */
  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Backcode Runner", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide Backcode Runner", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Backcode Runner", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    viewItem.submenu = view
    main.addItem(viewItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)
    NSApp.windowsMenu = windowMenu
    NSApp.mainMenu = main
  }

  @objc func reload() { webView.reload() }

  /**
   * Mensajes del panel. `drag`: se ha pulsado en su cabecera, que hace de barra de título (la ventana no tiene la suya:
   * .fullSizeContentView y el título oculto), y la ventana sigue al ratón como cualquier otra. `compact`: vista compacta,
   * la ventana se ajusta al contenido (las filas de los proyectos); al salir, vuelve a su tamaño.
   */
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    if body["drag"] as? Bool == true {
      // Con el botón aún pulsado, la ventana sigue al ratón desde el clic que guardó la WKWebView.
      guard NSEvent.pressedMouseButtons & 1 == 1, let event = webView.lastMouseDown else { return }
      window.performDrag(with: event)
      return
    }
    guard let compact = body["compact"] as? Bool else { return }
    var frame = window.frame
    let screen = window.screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    if compact {
      guard let height = body["height"] as? Double, height > 0 else { return }
      if fullFrame == nil, frame.height > CGFloat(height) + 40 { fullFrame = frame }
      window.minSize = Self.compactMin
      let width = min(max(frame.width, 380), 520)
      let newHeight = min(max(CGFloat(height), Self.compactMin.height), screen.height - 40)
      frame.origin.y += frame.height - newHeight // se queda arriba, donde estaba
      frame.size = NSSize(width: width, height: newHeight)
      window.setFrame(frame, display: true, animate: true)
    } else {
      // Completa: el tamaño de antes o, si se abrió ya en compacto, uno cómodo; nunca por debajo del mínimo.
      window.minSize = Self.fullMin
      var target = fullFrame ?? NSRect(x: frame.minX, y: frame.maxY - 920, width: 860, height: 920)
      fullFrame = nil
      target.size.width = min(max(target.width, Self.fullMin.width), screen.width - 40)
      target.size.height = min(max(target.height, Self.fullMin.height), screen.height - 40)
      target.origin.y = min(max(frame.maxY - target.height, screen.minY + 20), screen.maxY - target.height) // arriba, donde estaba
      target.origin.x = min(max(target.minX, screen.minX + 20), screen.maxX - target.width - 20)
      window.setFrame(target, display: true, animate: true)
    }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
