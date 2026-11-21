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

    /// True when a stored call has `start - 5 min <= now < end`. A missing,
    /// unreadable or malformed file skips nothing.
    static func covers(_ now: Date, at url: URL = path) -> Bool {
        guard let data = try? Data(contentsOf: url),
              let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let calls = document["calls"] as? [[String: Any]]
        else { return false }
        return calls.contains { call in
            guard let start = instant(call["start"]), let end = instant(call["end"]) else { return false }
            return start.addingTimeInterval(-lead) <= now && now < end
        }
    }

    private static func instant(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions.insert(.withFractionalSeconds)
        return plain.date(from: text) ?? fractional.date(from: text)
    }
}
