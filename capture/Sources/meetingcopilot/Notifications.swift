import AppKit
import Foundation
import UserNotifications

/// Banners that belong to meetingcopilot.
///
/// The old ones didn't. `osascript -e 'display notification'` posts under
/// AppleScript's identity, so macOS drew them as Script Editor's, and clicking
/// one opened Script Editor — an app the person never asked for, showing
/// nothing about their meeting. It was the honest choice while meetingcopilot was a
/// bare binary, because `UNUserNotificationCenter` needs a bundle to belong to.
///
/// Inside `MeetingCopilot.app` there is one, so the banner says meetingcopilot, carries the
/// recording it is about, and clicking it opens that folder. A bare build —
/// `swift run`, a test — has no bundle to post under and stays silent, which
/// is the right answer for something nobody installed.
enum Notifications {
    static var usesNotificationCenter: Bool { Runtime.isBundled }

    private static let sessionKey = "com.aiagentlabs.meeting-copilot.session"
    /// A release banner: clicking it installs, like the menu item (MEETONTRACK-156).
    private static let releaseKey = "com.aiagentlabs.meeting-copilot.release"
    /// A banner whose click opens this URL, such as a System Settings pane.
    private static let urlKey = "com.aiagentlabs.meeting-copilot.url"

    @MainActor
    private static var authorization: Task<Bool, Never>?
    @MainActor
    private static var delegate: Delegate?

    /// Called once at startup so a click has somewhere to go. `onOpen` is
    /// handed the session folder when the banner named one.
    @MainActor
    static func install(onOpen: @escaping @MainActor (URL?) -> Void,
                        onRelease: @escaping @MainActor (String) -> Void = { _ in }) {
        guard usesNotificationCenter else { return }
        let delegate = Delegate(onOpen: onOpen, onRelease: onRelease)
        Self.delegate = delegate
        UNUserNotificationCenter.current().delegate = delegate
    }

    @MainActor
    static func post(title: String, body: String, opening session: URL?, release: String? = nil, url: URL? = nil) {
        guard usesNotificationCenter else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let session { content.userInfo = [sessionKey: session.path] }
        if let release { content.userInfo = [releaseKey: release] }
        if let url { content.userInfo = [urlKey: url.absoluteString] }

        // Asked for once, lazily: a permission dialog on first launch, before
        // anything has happened, is a question about nothing.
        let request = authorization ?? Task { () -> Bool in
            (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])) ?? false
        }
        authorization = request

        Task {
            guard await request.value else { return }
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(
                    identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    /// An automatic recording started without microphone access: the call is
    /// recorded, the person's own voice is not. A click opens the pane that
    /// grants it.
    @MainActor
    static func microphoneMissing() {
        post(title: localised("Not recording your voice: no microphone access",
                              "Ваш голос не записывается: нет доступа к микрофону"),
             body: "", opening: nil,
             url: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"))
    }

    /// The folder a banner was about, or nil when it named none.
    static func session(in userInfo: [AnyHashable: Any]) -> URL? {
        (userInfo[sessionKey] as? String).map { URL(fileURLWithPath: $0) }
    }

    @MainActor
    private final class Delegate: NSObject, UNUserNotificationCenterDelegate {
        private let onOpen: @MainActor (URL?) -> Void
        private let onRelease: @MainActor (String) -> Void

        init(onOpen: @escaping @MainActor (URL?) -> Void, onRelease: @escaping @MainActor (String) -> Void) {
            self.onOpen = onOpen
            self.onRelease = onRelease
        }

        /// Show the banner even when meetingcopilot is the active app: the recording it
        /// announces finished in the background, and the window it would
        /// otherwise be hidden behind may be on another Space.
        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .list]
        }

        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            let userInfo = response.notification.request.content.userInfo
            let folder = Notifications.session(in: userInfo)
            let release = userInfo[Notifications.releaseKey] as? String
            let url = (userInfo[Notifications.urlKey] as? String).flatMap(URL.init(string:))
            await MainActor.run {
                if let release { return onRelease(release) }
                if let url { NSWorkspace.shared.open(url); return }
                NSApp.activate(ignoringOtherApps: true)
                onOpen(folder)
            }
        }
    }
}

/// Best-effort user-visible notification.
func notifyUser(title: String, body: String, opening session: URL? = nil) {
    Task { @MainActor in
        Notifications.post(title: title, body: body, opening: session)
    }
}
