// 회의노트 (MeetNote) — native macOS shell.
//
// Starts the local Python engine (python -m meetnote --no-window) and shows the
// UI in a WKWebView window. Handles what a plain browser tab can't: microphone
// permission for the app, the file picker, downloads to ~/Downloads, printing,
// and standard Mac menus/shortcuts. Built by scripts/build_app.sh with swiftc.

import Cocoa
import UserNotifications
import WebKit

let kPort = 8765
let kURL = URL(string: "http://127.0.0.1:\(kPort)/")!

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate,
    WKDownloadDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var splash: NSTextField!
    var downloads: [ObjectIdentifier: URL] = [:]

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        startServerIfNeeded()
        waitForServer(attempt: 0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Ask the page whether a recording is running before quitting.
        guard let webView = webView else { return .terminateNow }
        webView.evaluateJavaScript("window.__meetnoteRecording ? window.__meetnoteRecording() : false") { result, _ in
            if let busy = result as? Bool, busy {
                let alert = NSAlert()
                alert.messageText = "녹음 중입니다"
                alert.informativeText = "지금 종료하면 여기까지 녹음된 내용만 저장됩니다. 종료할까요?"
                alert.addButton(withTitle: "종료")
                alert.addButton(withTitle: "취소")
                let ok = alert.runModal() == .alertFirstButtonReturn
                sender.reply(toApplicationShouldTerminate: ok)
            } else {
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let p = server, p.isRunning {
            p.interrupt()  // SIGINT lets uvicorn shut down cleanly
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { usleep(100_000) }
            if p.isRunning { p.terminate() }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: server

    var appRoot: String {
        (Bundle.main.object(forInfoDictionaryKey: "MeetNoteRoot") as? String) ?? ""
    }

    var logURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MeetNote", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("engine.log")
    }

    func serverAlive() -> Bool {
        var alive = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: kURL.appendingPathComponent("api/state"))
        req.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            alive = (resp as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.0)
        return alive
    }

    func startServerIfNeeded() {
        if serverAlive() { return }
        let python = (appRoot as NSString).appendingPathComponent(".venv/bin/python")
        guard FileManager.default.isExecutableFile(atPath: python) else {
            showFatal("엔진을 찾을 수 없습니다", "\(python)\n\n설치 폴더에서 scripts/install.sh 를 다시 실행해 주세요.")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = ["-m", "meetnote", "--no-window", "--port", "\(kPort)"]
        p.currentDirectoryURL = URL(fileURLWithPath: appRoot)
        var env = ProcessInfo.processInfo.environment
        env["PYTHONUNBUFFERED"] = "1"
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            p.standardOutput = fh
            p.standardError = fh
        }
        do {
            try p.run()
            server = p
        } catch {
            showFatal("엔진을 시작하지 못했습니다", error.localizedDescription)
        }
    }

    func waitForServer(attempt: Int) {
        DispatchQueue.global().async {
            let up = self.serverAlive()
            DispatchQueue.main.async {
                if up {
                    self.splash.isHidden = true
                    self.webView.load(URLRequest(url: kURL))
                } else if attempt > 120 {
                    self.showFatal("엔진이 응답하지 않습니다", "로그: \(self.logURL.path)")
                } else if let p = self.server, !p.isRunning {
                    self.showFatal("엔진이 종료되었습니다", "로그: \(self.logURL.path)")
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForServer(attempt: attempt + 1) }
                }
            }
        }
    }

    func showFatal(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "로그 열기")
        alert.addButton(withTitle: "종료")
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(logURL)
        }
        NSApp.terminate(nil)
    }

    // MARK: window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.mediaTypesRequiringUserActionForPlayback = []
        let ucc = WKUserContentController()
        // window.print() does nothing in WKWebView: route it to the native print panel.
        let script = WKUserScript(source: """
            window.print = function () { window.webkit.messageHandlers.meetnote.postMessage({ type: 'print' }); };
            window.__meetnoteNative = true;
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        ucc.addUserScript(script)
        ucc.add(self, name: "meetnote")
        config.userContentController = ucc

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsMagnification = true

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "회의노트"
        window.minSize = NSSize(width: 980, height: 640)
        window.center()
        window.setFrameAutosaveName("MeetNoteMain")
        window.delegate = self
        window.backgroundColor = NSColor.windowBackgroundColor

        let container = NSView()
        container.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        splash = NSTextField(labelWithString: "회의노트를 시작하는 중…")
        splash.font = NSFont.systemFont(ofSize: 15, weight: .medium)
        splash.textColor = .secondaryLabelColor
        splash.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(splash)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            splash.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            splash.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: menus

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "회의노트에 관하여", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(item("설정…", #selector(openSettings), ","))
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "회의노트 숨기기", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "기타 숨기기", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "회의노트 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "파일")
        let rec = item("새 녹음", #selector(newRecording), "r")
        rec.keyEquivalentModifierMask = [.command, .shift]
        fileMenu.addItem(rec)
        fileMenu.addItem(item("파일 업로드…", #selector(upload), "u"))
        fileMenu.addItem(.separator())
        fileMenu.addItem(item("노트 검색", #selector(search), "k"))
        fileMenu.addItem(.separator())
        fileMenu.addItem(item("인쇄…", #selector(printPage), "p"))
        fileMenu.addItem(withTitle: "창 닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        // Without an Edit menu, ⌘C/⌘V/⌘Z don't reach the web view.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "편집")
        editMenu.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "실행 복귀", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "복사하기", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        editMenu.addItem(item("대화에서 찾기", #selector(findInNote), "f"))
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "보기")
        viewMenu.addItem(item("확대", #selector(zoomIn), "+"))
        viewMenu.addItem(item("축소", #selector(zoomOut), "-"))
        viewMenu.addItem(item("실제 크기", #selector(zoomReset), "0"))
        viewMenu.addItem(.separator())
        let fs = NSMenuItem(title: "전체 화면", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fs)
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let winItem = NSMenuItem()
        let winMenu = NSMenu(title: "윈도우")
        winMenu.addItem(withTitle: "최소화", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "확대/축소", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = winMenu
        main.addItem(winItem)
        NSApp.windowsMenu = winMenu

        let helpItem = NSMenuItem()
        let helpMenu = NSMenu(title: "도움말")
        helpMenu.addItem(item("엔진 로그 보기", #selector(openLog), ""))
        helpMenu.addItem(item("데이터 폴더 열기", #selector(openData), ""))
        helpMenu.addItem(item("브라우저에서 열기", #selector(openInBrowser), ""))
        helpItem.submenu = helpMenu
        main.addItem(helpItem)

        NSApp.mainMenu = main
    }

    func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    func js(_ code: String) { webView?.evaluateJavaScript(code, completionHandler: nil) }
    func key(_ k: String, meta: Bool = true, shift: Bool = false) {
        js("window.dispatchEvent(new KeyboardEvent('keydown', {key: '\(k)', metaKey: \(meta), shiftKey: \(shift), bubbles: true}))")
    }

    @objc func openSettings() { key(",") }
    @objc func newRecording() { key("R", shift: true) }
    @objc func upload() { key("u") }
    @objc func search() { key("k") }
    @objc func findInNote() { key("f") }
    @objc func printPage() { runPrint() }
    @objc func zoomIn() { webView.pageZoom = min(2.0, webView.pageZoom + 0.1) }
    @objc func zoomOut() { webView.pageZoom = max(0.6, webView.pageZoom - 0.1) }
    @objc func zoomReset() { webView.pageZoom = 1.0 }
    @objc func openLog() { NSWorkspace.shared.open(logURL) }
    @objc func openData() { NSWorkspace.shared.open(logURL.deletingLastPathComponent()) }
    @objc func openInBrowser() { NSWorkspace.shared.open(kURL) }

    func runPrint() {
        let info = NSPrintInfo.shared
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.topMargin = 36
        info.bottomMargin = 36
        info.leftMargin = 36
        info.rightMargin = 36
        let op = webView.printOperation(with: info)
        op.view?.frame = webView.bounds
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    // MARK: script messages

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "print" { runPrint() }
        if type == "quit" { NSApp.terminate(nil) }
        if type == "notify" {
            let content = UNMutableNotificationContent()
            content.title = (body["title"] as? String) ?? "회의노트"
            content.body = (body["body"] as? String) ?? ""
            content.sound = .default
            let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
        }
    }

    // MARK: WKUIDelegate

    // Grant the page microphone access; macOS itself asks the user once for the app.
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" || origin.host == "localhost" ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.message = "변환할 음성·영상 파일을 선택하세요"
        panel.beginSheetModal(for: window) { resp in
            completionHandler(resp == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "확인")
        alert.addButton(withTitle: "취소")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "확인")
        alert.addButton(withTitle: "취소")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // MARK: navigation + downloads

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if #available(macOS 11.3, *), navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if let url = navigationAction.request.url, let host = url.host,
           host != "127.0.0.1" && host != "localhost", navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)  // external links open in the default browser
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if #available(macOS 11.3, *), disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    @available(macOS 11.3, *)
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let base = (suggestedFilename as NSString).deletingPathExtension
        let ext = (suggestedFilename as NSString).pathExtension
        var dest = dir.appendingPathComponent(suggestedFilename)
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
            n += 1
        }
        downloads[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    @available(macOS 11.3, *)
    func downloadDidFinish(_ download: WKDownload) {
        if let dest = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([dest])
        }
    }

    @available(macOS 11.3, *)
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert(error: error)
        alert.runModal()
    }

    // Clicking a notification brings the window forward.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
        }
        completionHandler()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
