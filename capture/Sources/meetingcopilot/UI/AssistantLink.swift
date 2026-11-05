import AppKit
import WebKit

/// Shared entry point from setup, the menu bar and recorder controls: the
/// assistant opens in MeetOnTrack's own window, not in a browser tab.
enum AssistantLink {
    /// Posted by the `meeting-copilot` command to open this window in the running app.
    nonisolated static let request = Notification.Name("com.aiagentlabs.meeting-copilot.open-assistant")

    @MainActor private static var window: AssistantWindow?

    @MainActor static func open() {
        let window = window ?? AssistantWindow(server: .shared)
        Self.window = window
        window.show()
    }
}

/// Where a link inside the assistant goes. Pages of the local service stay in
/// the window; everything else (sign-in pages, Drive, release notes, report
/// PDFs opened as a new tab) belongs in the person's own browser.
enum AssistantLinkPolicy: Equatable {
    case load, openExternally, ignore

    static func decide(_ url: URL?, newWindow: Bool, port: Int) -> AssistantLinkPolicy {
        guard let url, let scheme = url.scheme?.lowercased() else { return .ignore }
        if ["about", "data", "blob"].contains(scheme) { return newWindow ? .ignore : .load }
        let local = ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == port
        if local, scheme == "http" { return newWindow ? .openExternally : .load }
        return ["http", "https", "mailto"].contains(scheme) ? .openExternally : .ignore
    }
}

@MainActor
final class AssistantWindow: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let server: LocalServer
    private let webView: WKWebView
    private let window: NSWindow
    private var loaded = false

    init(server: LocalServer) {
        self.server = server
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        super.init()
        window.title = ProductBrand.name
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("MeetOnTrackAssistant")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        // Whenever the service is ready, a shown window leaves the starting or failure page,
        // and follows a restarted service to another port (MEETONTRACK-130).
        server.onEveryReady { [weak self] in
            guard let self, self.loaded else { return }
            let current = self.webView.url
            guard current?.scheme != "http" || current?.port != self.server.port else { return }
            self.loadAssistant()
        }
    }

    func show() {
        if !loaded { load() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func load() {
        loaded = true
        guard server.isReady else {
            webView.loadHTMLString(Self.page(Self.startingText), baseURL: nil)
            server.whenCannotStart { [weak self] in
                guard let self, !self.server.isReady else { return }
                self.webView.loadHTMLString(Self.page(Self.cannotStartText), baseURL: nil)
            }
            return
        }
        loadAssistant()
    }

    private func loadAssistant() {
        webView.load(URLRequest(url: server.url))
    }

    private static var startingText: String {
        localised(
            "Starting MeetOnTrack… If this takes more than a minute, quit and reopen the app. Log: ~/.local/share/meeting-copilot/server.log",
            "Запускаем MeetOnTrack… Если это длится дольше минуты, закройте и снова откройте приложение. Журнал: ~/.local/share/meeting-copilot/server.log")
    }

    /// Shown only when the app could not resolve a start problem by itself (MEETONTRACK-130).
    private static var cannotStartText: String {
        localised(
            "MeetOnTrack could not start its assistant. Restart the Mac and open MeetOnTrack again.",
            "MeetOnTrack не смог запустить помощника. Перезагрузите Mac и снова откройте MeetOnTrack.")
    }

    private static func page(_ text: String) -> String {
        "<html><body style=\"font:15px -apple-system;color:#555;padding:48px\">\(text)</body></html>"
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        // Subframes (none today) follow their page; only top-level loads are routed.
        let newWindow = action.targetFrame == nil
        guard newWindow || action.targetFrame?.isMainFrame == true else { return decisionHandler(.allow) }
        switch AssistantLinkPolicy.decide(action.request.url, newWindow: newWindow, port: server.port) {
        case .load: decisionHandler(.allow)
        case .openExternally:
            if let url = action.request.url { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        case .ignore: decisionHandler(.cancel)
        }
    }

    /// Anything the window cannot show (an attachment, an archive) is a
    /// download: the browser already does that well, with its own UI.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let attachment = (response.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        guard response.isForMainFrame, !response.canShowMIMEType || attachment else { return decisionHandler(.allow) }
        if let url = response.response.url, AssistantLinkPolicy.decide(url, newWindow: true, port: server.port) == .openExternally {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// The service restarts after a crash; reload once it answers again.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryWhenReady()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        retryWhenReady()
    }

    private func retryWhenReady() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.server.whenReady { [weak self] in self?.loadAssistant() }
        }
    }

    // MARK: page dialogs — WKWebView shows none of these by itself

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if AssistantLinkPolicy.decide(action.request.url, newWindow: true, port: server.port) == .openExternally,
           let url = action.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: localised("Cancel", "Отмена"))
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}
