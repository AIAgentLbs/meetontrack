import Foundation

/// What the menu bar says about a release, read from the assistant server's
/// `/api/updates` (MEETONTRACK-156). The server checks GitHub; this only mirrors
/// the web page's rule in `updates.js` for showing `updates-notice`.
struct ReleaseOffer: Equatable {
    enum Kind: Equatable { case available, scheduled, running, failed }

    let version: String
    let kind: Kind

    /// Nil when nothing is to be shown: no trusted offer the person still wants
    /// to hear about (`notify` covers the switch and dismissal), and no install under way.
    /// `installFailed` is the version of this app's own failed install request, like `installError`
    /// in `updates.js`. A failure counts only for the version attempted: a newer release is a fresh offer.
    init?(updates: [String: Any], installFailed: String? = nil) {
        let latest = updates["latest"] as? [String: Any]
        let latestVersion = latest?["version"] as? String
        let job = updates["install"] as? [String: Any]
        let state = job?["state"] as? String
        if let version = job?["version"] as? String, state == "scheduled" || state == "running" {
            self.version = version
            kind = state == "running" ? .running : .scheduled
            return
        }
        guard updates["notify"] as? Bool == true, let latestVersion,
              Self.isTrusted(latest?["url"] as? String) else { return nil }
        // A retry installs the release on offer now, as the page's Retry does.
        version = latestVersion
        let failedVersion = state == "failed" ? job?["version"] as? String : job == nil ? installFailed : nil
        kind = failedVersion == latestVersion ? .failed : .available
    }

    init(version: String, kind: Kind) {
        self.version = version
        self.kind = kind
    }

    /// The same pattern as `updates.js`: only this repository's release tags.
    static func isTrusted(_ url: String?) -> Bool {
        guard let url else { return false }
        return url.range(of: #"^https://github\.com/AIAgentLbs/meetontrack/releases/tag/(?:windows-)?v\d+\.\d+\.\d+$"#,
                         options: .regularExpression) != nil
    }

    /// An offer or a retry can be clicked; a scheduled or running install is a status line.
    var isActionable: Bool { kind == .available || kind == .failed }

    var title: String {
        switch kind {
        case .available: localised("Version \(version) available - Install", "Доступна версия \(version) - установить")
        case .scheduled: localised("Version \(version) will be installed after the call", "Версия \(version) установится после звонка")
        case .running: localised("Updating to version \(version)…", "Обновляю до версии \(version)…")
        case .failed: localised("Could not update. The current version keeps working. Try again",
                                "Не удалось обновить. Текущая версия продолжает работать. Повторить")
        }
    }

    /// One banner per new version.
    func shouldNotify(lastNotified: String?) -> Bool {
        kind == .available && version != lastNotified
    }

    /// A banner installs only the version it announced, and only while it is still on offer.
    func installs(bannerVersion: String) -> Bool {
        isActionable && version == bannerVersion
    }

    /// While an install is under way the server is asked often, so its end shows promptly.
    static func pollInterval(for offer: ReleaseOffer?) -> TimeInterval {
        offer?.kind == .scheduled || offer?.kind == .running ? 20 : 15 * 60
    }
}

/// Reports the person has not received, read from the assistant server's
/// delivery health every minute for the menu bar (MEETONTRACK-189 P2-21).
@MainActor
final class DeliveryAttention {
    private let server: LocalServer
    private let show: (String?) -> Void
    private var timer: Timer?

    init(server: LocalServer = .shared, show: @escaping (String?) -> Void) {
        self.server = server
        self.show = show
    }

    /// One line for the menu, or nil when everything went out.
    nonisolated static func line(delivery: [String: Any]) -> String? {
        let unsent = (delivery["undelivered"] as? [Any])?.count ?? 0
        let stuck = (delivery["stuck_recordings"] as? [Any])?.count ?? 0
        // A sign-in or a choice the person must make blocks sending without
        // being listed as undelivered yet.
        let blocked = Set(((delivery["channels"] as? [String: Any]) ?? [:]).values.flatMap {
            (($0 as? [String: Any])?["issues"] as? [[String: Any]] ?? []).compactMap {
                ["auth_required", "needs_choice"].contains($0["reason"] as? String ?? "")
                    ? $0["meeting_id"] as? String : nil
            }
        }).count
        if blocked > 0 {
            return localised("Reports wait for you: \(blocked)", "Отчеты ждут вашего действия: \(blocked)")
        }
        if unsent > 0 {
            return localised("Reports not sent: \(unsent)", "Не отправлено отчетов: \(unsent)")
        }
        if stuck > 0 {
            return localised("A recording was cut off; open the assistant",
                             "Запись прервалась, откройте помощник")
        }
        return nil
    }

    func start() {
        guard timer == nil else { return }
        server.onEveryReady { [weak self] in self?.refresh() }
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func refresh() {
        guard server.isReady,
              let url = URL(string: "http://127.0.0.1:\(server.port)/api/delivery") else { return }
        Task {
            var request = URLRequest(url: url)
            request.timeoutInterval = 12
            // Server busy or restarting: keep what is shown.
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let delivery = value["delivery"] as? [String: Any] else { return }
            show(Self.line(delivery: delivery))
        }
    }
}

/// Asks the app's own assistant server about releases at start and every 15 minutes
/// (the server's own GitHub refresh period; Swift never calls GitHub), shows the result
/// in the menu, posts one banner per new version, and starts the install the same way
/// the assistant page does. The server defers the install until the call ends.
@MainActor
final class ReleaseNotice {
    static let notifiedKey = "lastNotifiedReleaseVersion"
    private let server: LocalServer
    private let show: (ReleaseOffer?) -> Void
    private var timer: Timer?
    private var lastPoll = Date.distantPast
    private var installFailed: String?
    private(set) var offer: ReleaseOffer?

    init(server: LocalServer = .shared, show: @escaping (ReleaseOffer?) -> Void) {
        self.server = server
        self.show = show
    }

    func start() {
        guard timer == nil else { return }
        server.onEveryReady { [weak self] in self?.refresh() }
        if server.isReady { refresh() }
        // Ticks often, polls when due: every 15 minutes, every 20 s during an install.
        let timer = Timer(timeInterval: 20, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, Date().timeIntervalSince(self.lastPoll) >= ReleaseOffer.pollInterval(for: self.offer) - 1
                else { return }
                self.refresh()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func refresh(then next: (() -> Void)? = nil) {
        guard server.isReady else { return }
        lastPoll = Date()
        Task {
            apply(await request(post: nil))
            next?()
        }
    }

    /// The menu item lands here; no confirmation (fewest clicks).
    func install() {
        guard let offer, offer.isActionable, server.isReady else { return }
        installFailed = nil
        Task {
            if let updates = await request(post: ["version": offer.version]) {
                apply(updates)
            } else {
                // Shown as failed; a re-poll replaces a stale version with the current one.
                installFailed = offer.version
                refresh()
            }
        }
    }

    /// A banner click: waits for the server on a cold launch, then installs only
    /// if the banner's version is still the one on offer; otherwise the menu is just refreshed.
    func installFromBanner(version: String) {
        server.whenReady { [weak self] in
            self?.refresh { [weak self] in
                guard let self, self.offer?.installs(bannerVersion: version) == true else { return }
                self.install()
            }
        }
    }

    private func apply(_ updates: [String: Any]?) {
        guard let updates else { return }  // server busy or restarting: keep what is shown
        offer = ReleaseOffer(updates: updates, installFailed: installFailed)
        show(offer)
        let defaults = UserDefaults.standard
        guard let offer, offer.shouldNotify(lastNotified: defaults.string(forKey: Self.notifiedKey)) else { return }
        defaults.set(offer.version, forKey: Self.notifiedKey)
        Notifications.post(
            title: offer.title,
            body: localised("Click to install. During a call it waits until the call ends.",
                            "Нажмите, чтобы установить. Во время звонка установка дождется его окончания."),
            opening: nil, release: offer.version)
    }

    /// GET `/api/updates`, or POST `/api/updates/install` with the page's own Origin,
    /// which is what the server requires before it starts an install.
    private func request(post body: [String: String]?) async -> [String: Any]? {
        let base = "http://127.0.0.1:\(server.port)"
        guard let url = URL(string: base + (body == nil ? "/api/updates" : "/api/updates/install")) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        if let body {
            request.httpMethod = "POST"
            request.setValue(base, forHTTPHeaderField: "Origin")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["ok"] as? Bool == true else { return nil }
        return value["updates"] as? [String: Any]
    }
}
