// ProjectDesk.swift — native macOS shell for the local ProjectDesk planner.
//
// A real desktop app: its own window (WKWebView), Dock icon, and menu. It runs
// entirely locally — it makes sure the local server is up (starting it if not)
// and shows the planner from http://127.0.0.1:<port>. No browser, no website.
//
// NODE_PATH, SERVER_JS, and APP_PORT are injected by the build via Config.swift.

import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    var startedServer = false
    var loadingLabel: NSTextField!

    var baseURL: String { "http://127.0.0.1:\(APP_PORT)/" }
    var pingURL: String { "http://127.0.0.1:\(APP_PORT)/api/ping" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        setAppIcon()
        buildMenu()
        buildWindow()
        ensureServerThenLoad()
        NSApp.activate(ignoringOtherApps: true)
    }

    // --- Window + web view ---------------------------------------------------
    func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "ProjectDesk"
        window.center()
        window.setFrameAutosaveName("ProjectDeskMain")
        window.minSize = NSSize(width: 720, height: 480)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // window.print() is a no-op inside WKWebView; the page posts to this
        // bridge instead (js/app.js prefers it when present) and we run a real
        // native print — @media print styles apply, so the status report
        // prints/saves-to-PDF exactly like it does in a browser.
        config.userContentController.add(self, name: "print")
        webView = WKWebView(frame: frame, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false

        let container = NSView(frame: frame)
        container.addSubview(webView)

        loadingLabel = NSTextField(labelWithString: "Starting ProjectDesk…")
        loadingLabel.font = NSFont.systemFont(ofSize: 15, weight: .medium)
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.alignment = .center
        loadingLabel.frame = NSRect(x: 0, y: frame.height/2 - 12, width: frame.width, height: 24)
        loadingLabel.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        container.addSubview(loadingLabel)

        window.contentView = container
        window.makeKeyAndOrderFront(nil)
    }

    // --- Local server: ensure up, then load ---------------------------------
    func serverIsUp() -> Bool {
        guard let url = URL(string: pingURL) else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.0
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        let task = URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 { ok = true }
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 1.5)
        return ok
    }

    func resolveNode() -> String? {
        var candidates = [NODE_PATH]
        candidates.append(contentsOf: [
            "/opt/homebrew/bin/node", "/opt/homebrew/opt/node@22/bin/node",
            "/usr/local/bin/node", "/usr/bin/node"
        ])
        for c in candidates where !c.isEmpty && FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return nil
    }

    func startServer() {
        guard FileManager.default.fileExists(atPath: SERVER_JS), let node = resolveNode() else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [SERVER_JS, "--port", APP_PORT]
        p.currentDirectoryURL = URL(fileURLWithPath: (SERVER_JS as NSString).deletingLastPathComponent)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin"
        p.environment = env
        do { try p.run(); serverProcess = p; startedServer = true } catch { /* fall through to error UI */ }
    }

    func ensureServerThenLoad() {
        DispatchQueue.global(qos: .userInitiated).async {
            if !self.serverIsUp() {
                self.startServer()
                for _ in 0..<50 { // wait up to ~10s
                    if self.serverIsUp() { break }
                    Thread.sleep(forTimeInterval: 0.2)
                }
            }
            let up = self.serverIsUp()
            DispatchQueue.main.async {
                if up, let url = URL(string: self.baseURL) {
                    self.webView.load(URLRequest(url: url))
                } else {
                    self.showStartupError()
                }
            }
        }
    }

    func showStartupError() {
        loadingLabel.stringValue = "Couldn't start the local ProjectDesk server.\n" +
            "Make sure Node.js is installed, then reopen the app.\n(Server: \(SERVER_JS))"
        loadingLabel.maximumNumberOfLines = 4
    }

    // --- WKNavigation --------------------------------------------------------
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingLabel.isHidden = true
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // transient during startup; a reload usually recovers
    }

    // --- Menu ----------------------------------------------------------------
    func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About ProjectDesk", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide ProjectDesk", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit ProjectDesk", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Print…", action: #selector(printWebView), keyEquivalent: "p")
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        viewItem.submenu = viewMenu

        let winItem = NSMenuItem()
        mainMenu.addItem(winItem)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = winMenu

        NSApp.mainMenu = mainMenu
    }

    @objc func reloadPage() { webView.reload() }

    // --- Printing ------------------------------------------------------------
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if message.name == "print" { printWebView() }
    }

    @objc func printWebView() {
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.topMargin = 24; info.bottomMargin = 24
        info.leftMargin = 24; info.rightMargin = 24
        let op = webView.printOperation(with: info)
        op.showsPrintPanel = true
        op.showsProgressPanel = true
        // The operation's view starts with a zero frame; without this the
        // printed pages come out blank.
        op.view?.frame = webView.bounds
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }
    @objc func showAbout() {
        let a = NSAlert()
        a.messageText = "ProjectDesk"
        a.informativeText = "A local project planner.\nRuns on your machine at 127.0.0.1:\(APP_PORT); your plans stay in local files."
        a.runModal()
    }

    // --- Dock icon (drawn programmatically) ---------------------------------
    func setAppIcon() {
        let size: CGFloat = 512
        let img = NSImage(size: NSSize(width: size, height: size))
        img.lockFocus()
        let rect = NSRect(x: 0, y: 0, width: size, height: size)
        let bg = NSBezierPath(roundedRect: rect.insetBy(dx: 44, dy: 44), xRadius: 96, yRadius: 96)
        let grad = NSGradient(colors: [NSColor(calibratedRed: 0.20, green: 0.40, blue: 0.92, alpha: 1),
                                       NSColor(calibratedRed: 0.16, green: 0.28, blue: 0.62, alpha: 1)])
        grad?.draw(in: bg, angle: -90)
        // gantt bars
        let bars: [(CGFloat, CGFloat, CGFloat, NSColor)] = [
            (120, 330, 220, NSColor.white.withAlphaComponent(0.95)),
            (170, 260, 200, NSColor(calibratedRed: 1, green: 0.82, blue: 0.35, alpha: 0.95)),
            (220, 300, 140, NSColor.white.withAlphaComponent(0.85)),
            (270, 250, 170, NSColor(calibratedRed: 0.55, green: 0.85, blue: 1, alpha: 0.95))
        ]
        for (y, x, w, c) in bars {
            c.setFill()
            NSBezierPath(roundedRect: NSRect(x: x, y: size - y - 34, width: w, height: 34), xRadius: 12, yRadius: 12).fill()
        }
        img.unlockFocus()
        NSApp.applicationIconImage = img
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        if startedServer { serverProcess?.terminate() }
    }
}

@main
struct ProjectDeskApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
