import AVFoundation
import Foundation
import Testing

@testable import meetingcopilot

/// MEETONTRACK-189 P0-4: a microphone start that hangs froze the whole app
/// for about 16 minutes (2026.11.23-1235). The start now runs off the main
/// thread behind a watchdog, after the microphone grant is checked.
struct MicrophoneStartTests {
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func bump() { lock.lock(); value += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    @Test("A denied microphone is not started at all")
    func deniedIsNotStarted() async {
        let calls = Counter()
        let result = await RecordingSession.startMicrophone(
            status: .denied, requestAccess: { true }, timeout: 1,
            start: { calls.bump() }, late: { _ in })
        #expect(result == .denied)
        #expect(calls.count == 0)
    }

    @Test("An unanswered grant is asked for first; a refusal means no start")
    func notDeterminedAsksFirst() async {
        let calls = Counter()
        let refused = await RecordingSession.startMicrophone(
            status: .notDetermined, requestAccess: { false }, timeout: 1,
            start: { calls.bump() }, late: { _ in })
        #expect(refused == .denied)
        #expect(calls.count == 0)

        let granted = await RecordingSession.startMicrophone(
            status: .notDetermined, requestAccess: { true }, timeout: 1,
            start: { calls.bump() }, late: { _ in })
        #expect(granted == .started)
        #expect(calls.count == 1)
    }

    @Test("A hanging start times out, and its late result is still handed back")
    func hangingStartTimesOut() async {
        let late = Counter()
        // .timedOut itself proves the watchdog answered before the 3 s start
        // did; wall-clock bounds are left out because the parallel suite can
        // delay resuming this test by seconds.
        let result = await RecordingSession.startMicrophone(
            status: .authorized, requestAccess: { true }, timeout: 0.2,
            start: { Thread.sleep(forTimeInterval: 3) },
            late: { error in if error == nil { late.bump() } })
        #expect(result == .timedOut)
        for _ in 0..<100 where late.count == 0 { try? await Task.sleep(for: .milliseconds(100)) }
        #expect(late.count == 1)
    }

    @Test("A start that throws is reported as a failure")
    func throwingStartFails() async {
        struct Boom: Error {}
        let result = await RecordingSession.startMicrophone(
            status: .authorized, requestAccess: { true }, timeout: 1,
            start: { throw Boom() }, late: { _ in })
        guard case .failed = result else {
            Issue.record("expected .failed, got \(result)")
            return
        }
    }

    /// P3-7: the folder of a start that recorded nothing was left behind as
    /// invisible litter.
    @Test("A failed start's folder is removed only when it holds no audio")
    func emptyFolderIsRemoved() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mic-start-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let empty = root.appendingPathComponent("2026.01.02-0304", isDirectory: true)
        let kept = root.appendingPathComponent("2026.01.02-0305", isDirectory: true)
        for dir in [empty, kept] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(count: 4096).write(to: dir.appendingPathComponent("system.caf"))
            try Data(count: 4096).write(to: dir.appendingPathComponent("mic.caf"))
            try Data("{}".utf8).write(to: dir.appendingPathComponent(".recording.json"))
        }
        try Data(count: 64_000).write(to: kept.appendingPathComponent("mic.caf"))

        #expect(RecordingSession.removeIfNothingRecorded(empty))
        #expect(!RecordingSession.removeIfNothingRecorded(kept))
        #expect(!FileManager.default.fileExists(atPath: empty.path))
        #expect(FileManager.default.fileExists(atPath: kept.path))
    }

    /// Review rounds 1-2: a denied microphone left mic.caf listed but never
    /// written, and transcription stopped on it instead of reading the far end.
    @Test("Recovery lists only the tracks that were written, and the report names the missing mic")
    @MainActor
    func unwrittenMicTrack() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("unwritten-\(UUID().uuidString)", isDirectory: true)
        let dir = root.appendingPathComponent("2026.01.02-0306", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data(repeating: 0x41, count: 8192).write(to: dir.appendingPathComponent("system.caf"))
        try JSONSerialization.data(withJSONObject: [
            "pid": 999_999, "started": "2026-01-02T03:06:00Z",
            "files": ["mic": "mic.caf", "system": "system.caf"],
        ]).write(to: dir.appendingPathComponent(".recording.json"))

        #expect(RecordingSession.recoverInterrupted(root: root).count == 1)
        let meta = try JSONSerialization.jsonObject(
            with: Data(contentsOf: dir.appendingPathComponent("meta.json"))) as? [String: Any]
        #expect(meta?["files"] as? [String: String] == ["system": "system.caf"])
        #expect(RecordingSession.captureProblems(
            expectsFarEnd: true, micHeard: false, farEnd: nil, micRecorded: false) == ["mic_not_recorded"])
    }
}
