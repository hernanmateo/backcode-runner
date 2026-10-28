// Backcode Runner.app: una ventana nativa de macOS con el panel del runner dentro (sin navegador).
//
// El runner es el ejecutable de Contents/Resources/backcode. Al abrir la app se le pide `backcode app-url`: lo instala en
// ~/.backcode/bin si hace falta, lo deja como servicio («Arrancar al iniciar sesión»), espera al panel y devuelve su
// dirección (con el token), que se carga aquí. Cerrar la ventana cierra la app, no el runner: sigue en segundo plano.
// Los enlaces que salen del panel (GitHub, descargas…) se abren en el navegador.

import AppKit
import WebKit

/**
 * Barra de título de la ventana: una capa nativa transparente sobre la franja de la cabecera del panel. Recibe el clic
 * de verdad (no por mensaje desde la página, que llegaba tarde y no movía la ventana) y arrastra la ventana como una barra
 * de título normal (doble clic: zoom). Donde hay controles de la cabecera (los «huecos» que manda el panel) no se queda el
 * clic y llega a la página.
 */
final class DragRegionView: NSView {
  var holes: [NSRect] = []
  override var isFlipped: Bool { true }
  override var mouseDownCanMoveWindow: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? {
    let local = convert(point, from: superview)
    guard bounds.contains(local), !holes.contains(where: { $0.contains(local) }) else { return nil }
    return self
  }
  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  var window: NSWindow!
  var webView: WKWebView!
  let dragRegion = DragRegionView(frame: .zero)
  let spinner = NSProgressIndicator()
  /** Tamaño de la ventana en la vista completa, para volver a él al salir de la compacta. */
  var fullFrame: NSRect?
  /** Mínimos: en compacto, unas filas; en completo, lo justo para que el panel no se apriete. */
  static let compactMin = NSSize(width: 340, height: 150)
  static let fullMin = NSSize(width: 560, height: 620)

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    // El panel avisa de la vista compacta y de cuánto ocupa, y de cuándo se arrastra la ventana desde su cabecera
    // (window.webkit.messageHandlers.backcode).
    config.userContentController.add(self, name: "backcode")
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.setValue(false, forKey: "drawsBackground") // sin destello blanco antes de pintar (el panel pone su fondo)

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.title = "Backcode Runner"
    window.titleVisibility = .hidden // el panel ya lleva su cabecera
    window.titlebarAppearsTransparent = true
    window.minSize = Self.fullMin // en compacto baja a compactMin (lo pide el panel)
    window.backgroundColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(red: 0.12, green: 0.118, blue: 0.114, alpha: 1) : NSColor(red: 0.961, green: 0.949, blue: 0.918, alpha: 1) }
    // La página ocupa toda la ventana y, encima, la capa que hace de barra de título (ver DragRegionView).
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 860, height: 920))
    webView.frame = root.bounds
    webView.autoresizingMask = [.width, .height]
    root.addSubview(webView)
    dragRegion.frame = NSRect(x: 0, y: root.bounds.height - 28, width: root.bounds.width, height: 28)
    dragRegion.autoresizingMask = [.width, .minYMargin]
    root.addSubview(dragRegion, positioned: .above, relativeTo: webView)
    window.contentView = root
    window.setFrameAutosaveName("BackcodeRunnerMain")
    if !window.setFrameUsingName("BackcodeRunnerMain") { window.center() }

    spinner.style = .spinning
    spinner.translatesAutoresizingMaskIntoConstraints = false
    webView.addSubview(spinner)
    NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: webView.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: webView.centerYAnchor)])
    spinner.startAnimation(nil)

    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    start()
  }

  /** Pide al runner que se instale (si hace falta) y devuelva la dirección del panel. */
  func start() {
    DispatchQueue.global(qos: .userInitiated).async {
      let result = Self.runRunner(["app-url"])
      DispatchQueue.main.async {
        // ?native=1: el panel deja sitio a los botones de la ventana (rojo, amarillo y verde).
        if let url = result.flatMap({ URL(string: $0.replacingOccurrences(of: "/#", with: "/?native=1#")) }) {
          self.webView.load(URLRequest(url: url))
        } else {
          self.spinner.stopAnimation(nil)
          let alert = NSAlert()
          alert.messageText = "Backcode Runner"
          alert.informativeText = "The runner didn't start. Log: ~/.backcode/logs/service.log"
          alert.addButton(withTitle: "Retry")
          alert.addButton(withTitle: "Quit")
          if alert.runModal() == .alertFirstButtonReturn { self.spinner.startAnimation(nil); self.start() } else { NSApp.terminate(nil) }
        }
      }
    }
  }

  /** Ejecuta el runner de dentro de la app y devuelve la última línea que imprime (la URL). */
  static func runRunner(_ args: [String]) -> String? {
    guard let runner = Bundle.main.url(forResource: "backcode", withExtension: nil) else { return nil }
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
    do { try process.run() } catch { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)?.split(separator: "\n").last.map(String.init)
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
    spinner.stopAnimation(nil)
    spinner.removeFromSuperview()
  }

  // Si el panel se reinicia (actualización), la página vuelve a cargar sola; si la carga falla, se reintenta.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { webView.reload() }
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
   * Mensajes del panel. `dragRegion`: dónde está su cabecera, que hace de barra de título (la ventana no tiene la suya:
   * .fullSizeContentView y el título oculto), y qué controles tiene. `compact`: vista compacta,
   * la ventana se ajusta al contenido (las filas de los proyectos); al salir, vuelve a su tamaño.
   */
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    if let region = body["dragRegion"] as? [String: Any], let height = region["height"] as? Double, let root = window.contentView {
      // Franja de la cabecera (en puntos desde arriba) y los controles que tiene, que siguen siendo de la página.
      let h = CGFloat(min(max(height, 0), 400))
      dragRegion.frame = NSRect(x: 0, y: root.bounds.height - h, width: root.bounds.width, height: h)
      dragRegion.holes = ((region["holes"] as? [[Double]]) ?? []).filter { $0.count == 4 }.map { NSRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]).insetBy(dx: -2, dy: -2) }
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
