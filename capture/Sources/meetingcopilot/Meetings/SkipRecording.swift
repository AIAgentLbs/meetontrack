import Foundation

/// Calls the person chose in MeetOnTrack not to record. The web server writes
/// `skip-recording.json` beside the live transcript; the recorder only reads it.
/// Calls are matched by time, never by id or title: the recorder knows the
/// calendar through EventKit, not through the server's event ids.
enum SkipRecording {
    static let path = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/share/meeting-copilot/skip-recording.json")

    /// How long before its start a call already counts as that call.
    static let lead: TimeInterval = 5 * 60

    /// One stored call. Its start names it: the server may end a skip earlier
    /// (a call booked right after it), never move its start.
    struct Call: Equatable {
        let start: Date
        let end: Date

        /// `start - 5 min <= now < end`.
        func covers(_ now: Date) -> Bool {
            start.addingTimeInterval(-SkipRecording.lead) <= now && now < end
        }
    }

    /// The stored calls: none when there is no file, nil when the file cannot be read or parsed
    /// (a skip already holding stays; only a successful read without its call lifts it).
    static func calls(at url: URL = path) -> [Call]? {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        guard let data = try? Data(contentsOf: url),
              let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let calls = document["calls"] as? [[String: Any]]
        else { return nil }
        return calls.compactMap { call in
            guard let start = instant(call["start"]), let end = instant(call["end"]) else { return nil }
            return Call(start: start, end: end)
        }
    }

    /// True when a stored call covers `now`.
    static func covers(_ now: Date, at url: URL = path) -> Bool {
        (calls(at: url) ?? []).contains { $0.covers(now) }
    }

    private static func instant(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions.insert(.withFractionalSeconds)
        return plain.date(from: text) ?? fractional.date(from: text)
    }
}
