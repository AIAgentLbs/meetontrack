import ArgumentParser
import Testing

@testable import meetingcopilot

/// `meetingcopilot record`: the server's Stop runs `record pause`, and only a
/// non-zero exit makes it fall back to an immediate stop.
@MainActor
@Suite(.serialized)
struct RecordRequestTests {
    @Test func pauseIsAVerb() throws {
        #expect(RecordRequest.Action(rawValue: "pause") == .pause)
        #expect(try Record.parse(["pause"]).action == .pause)
    }

    /// No app answered (not running, or a build too old to know the verb):
    /// the exit code must say so, or the server believes the pause happened.
    @Test func noAnswerIsFailure() throws {
        let real = Record.ask
        defer { Record.ask = real }
        var asked: RecordRequest.Action?
        Record.ask = { asked = $0; return false }

        let command = try Record.parse(["pause"])
        #expect(throws: ExitCode.failure) { try command.run() }
        #expect(asked == .pause)
    }

    @Test func answerIsSuccess() throws {
        let real = Record.ask
        defer { Record.ask = real }
        Record.ask = { _ in true }

        try Record.parse(["resume"]).run()
    }
}
