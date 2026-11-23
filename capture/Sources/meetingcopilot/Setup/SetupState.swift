import Foundation

/// Whether the first-run window has been through, and for which version of it.
///
/// It lives in its own file rather than in `config.json`, because the config
/// file holds decisions a person made and nothing else — that is what makes it
/// readable — and "the setup window has been seen" is not a decision.
///
/// The absence of a config file cannot stand in for this. Settings are only
/// written when they differ from their default, so a person who agreed with
/// every default has no config file and never will, and using that as the
/// first-run flag would show them the window at every launch for ever.
///
/// The stored version is what lets a later release ask for something new — a
/// permission, a choice — without dragging everyone through the whole window
/// again: raise `current`, and the window opens once more showing only what it
/// hasn't been told.
enum SetupState {
    /// Raise this when the window gains something a person must answer.
    static let current = 1

    static let path = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/meeting-copilot/setup.json")

    /// The version of setup that has been completed, or nil for a machine that
    /// has never been through it.
    static func completedVersion(at stateURL: URL = path) -> Int? {
        guard
            let data = try? Data(contentsOf: stateURL),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json["version"] as? Int
    }

    static func isPending(at stateURL: URL = path) -> Bool {
        (completedVersion(at: stateURL) ?? 0) < current
    }

    static var isPending: Bool { isPending(at: path) }

    /// Record that the window has been through. Failure is not worth
    /// escalating: the cost is the window opening again, not a lost recording.
    static func markCompleted(at stateURL: URL = path) {
        write(["version": current, "completed_at": ISO8601DateFormatter().string(from: Date())], at: stateURL)
    }

    /// Remember that a deliberate tone made the round trip through the
    /// system-audio tap.
    ///
    /// macOS has no API that reads this grant, so without a memory the window
    /// has to treat every opening as the first one and ask for the test again
    /// — including on a Mac that has been recording both sides of meetings all
    /// week. What is remembered is a measurement and it is shown as one, with
    /// the date it was taken, and the test is always one click away.
    static func rememberSystemAudioHeard(now: Date = Date(), at stateURL: URL = path) {
        write(["system_audio_heard_at": ISO8601DateFormatter().string(from: now)], at: stateURL)
    }

    static func systemAudioHeardAt(at stateURL: URL = path) -> Date? {
        guard
            let data = try? Data(contentsOf: stateURL),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let stamp = json["system_audio_heard_at"] as? String
        else { return nil }
        return ISO8601DateFormatter().date(from: stamp)
    }

    /// A tone that no longer makes the round trip: the window asks again.
    static func forgetSystemAudioHeard(at stateURL: URL = path) {
        write(["system_audio_heard_at": NSNull()], at: stateURL)
    }

    // MARK: - after an install (MEETONTRACK-189 P1-5)

    /// What identifies an install: the version, the build, and when the
    /// executable was written, so reinstalling the same version counts too.
    /// nil for a bare build, which nobody installed.
    static var currentBuild: String? {
        guard Runtime.isBundled, let info = Bundle.main.infoDictionary else { return nil }
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let written = Bundle.main.executableURL
            .flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.modificationDate] as? Date }
            .map { ISO8601DateFormatter().string(from: $0) } ?? "?"
        return "\(version) (\(build)) \(written)"
    }

    /// The install whose grants were last checked at launch.
    static func checkedBuild(at stateURL: URL = path) -> String? {
        guard
            let data = try? Data(contentsOf: stateURL),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json["checked_build"] as? String
    }

    static func rememberCheckedBuild(_ build: String, at stateURL: URL = path) {
        write(["checked_build": build], at: stateURL)
    }

    /// The setup rows an install broke: a reinstall can reset the grants while
    /// setup still counts as done, and the first call then records zeros.
    @MainActor
    static func afterInstallFailures(
        microphone: SetupPermissions.State, systemAudio: SetupPermissions.SystemAudioResult
    ) -> [String] {
        (microphone == .granted ? [] : ["microphone"]) + (systemAudio == .heard ? [] : ["system_audio"])
    }

    /// Merge into whatever is already on disk: the completion version and the
    /// last heard tone are written at different moments and neither should
    /// erase the other. NSNull removes a key.
    private static func write(_ values: [String: Any], at stateURL: URL) {
        var json = (try? Data(contentsOf: stateURL))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            .flatMap { $0 } ?? [:]
        for (key, value) in values { json[key] = value is NSNull ? nil : value }

        guard let data = try? JSONSerialization.data(
            withJSONObject: json, options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? FileManager.default.createDirectory(
            at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? data.write(to: stateURL, options: .atomic)
    }

    /// Forget that the window has been through, so it opens again — what
    /// `meetingcopilot setup` does when it can't reach a running daemon to ask it
    /// politely.
    ///
    /// The heard tone is a measurement of the machine, not a record of what
    /// someone has read, so it survives. Deleting the file wholesale meant
    /// every `meetingcopilot setup` threw away the evidence and the window opened
    /// demanding a system-audio test that had passed minutes earlier.
    static func reset(at stateURL: URL = path) {
        guard
            let data = try? Data(contentsOf: stateURL),
            var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let heard = json["system_audio_heard_at"]
        else {
            try? FileManager.default.removeItem(at: stateURL)
            return
        }
        json = ["system_audio_heard_at": heard]
        guard let rewritten = try? JSONSerialization.data(
            withJSONObject: json, options: [.prettyPrinted, .sortedKeys]
        ) else {
            try? FileManager.default.removeItem(at: stateURL)
            return
        }
        try? rewritten.write(to: stateURL, options: .atomic)
    }
}
