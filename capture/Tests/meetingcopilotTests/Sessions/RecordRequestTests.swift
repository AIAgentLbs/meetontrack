import ArgumentParser
import Foundation
import os
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
        Record.ask = { action, _ in asked = action; return .none }

        let command = try Record.parse(["pause"])
        #expect(throws: ExitCode.failure) { try command.run() }
        #expect(asked == .pause)
    }

    @Test func answerIsSuccess() throws {
        let real = Record.ask
        defer { Record.ask = real }
        Record.ask = { _, _ in .done }

        try Record.parse(["resume"]).run()
    }

    /// J1: the server names the session a command is for. The app compares it with its own live
    /// session before acting, so a deferred Stop never lands on the next call.
    @Test func sessionTravelsWithTheCommand() throws {
        let real = Record.ask
        defer { Record.ask = real }
        var asked: (RecordRequest.Action, String?)?
        Record.ask = { action, session in asked = (action, session); return .done }
        try Record.parse(["stop", "--session", "A1"]).run()
        #expect(asked?.0 == .stop && asked?.1 == "A1")
        try Record.parse(["stop"]).run()
        #expect(asked?.0 == .stop && asked?.1 == nil)

        let encoded = RecordRequest.encode("R", .pause, session: "A1")
        #expect(RecordRequest.decode(encoded)?.action == .pause)
        #expect(RecordRequest.decode(encoded)?.session == "A1")
        #expect(RecordRequest.decode(RecordRequest.encode("R", .stop, session: nil))?.session == nil)
    }

    @Test func mismatchIsRefusedMatchIsAccepted() {
        #expect(RecordRequest.accepts(session: "A1", live: "A1"))
        #expect(!RecordRequest.accepts(session: "A1", live: "B2"))
        #expect(!RecordRequest.accepts(session: "A1", live: nil))
        #expect(RecordRequest.accepts(session: nil, live: "B2"))  // no --session: as before
        #expect(RecordRequest.accepts(session: nil, live: nil))
    }

    /// A refusal exits with its own code (3), so the server tells "another recording" from "no answer".
    @Test func refusalHasItsOwnExitCode() throws {
        let real = Record.ask
        defer { Record.ask = real }
        Record.ask = { _, _ in .refused }
        let command = try Record.parse(["stop", "--session", "A1"])
        #expect(throws: ExitCode(3)) { try command.run() }
    }

    /// The recognition watchdog sends `relisten`, never `resume`: only an
    /// explicit Resume unpauses, so a Stop's pause survives a watchdog tick.
    @Test func watchdogNeverUnpausesAPausedSession() throws {
        #expect(try Record.parse(["relisten"]).action == .relisten)
        #expect(RecordRequest.effects(of: .relisten, paused: true) == [])
        #expect(RecordRequest.effects(of: .relisten, paused: false) == [.relisten])
        #expect(RecordRequest.effects(of: .resume, paused: true) == [.unpause, .relisten])
        #expect(RecordRequest.effects(of: .resume, paused: false) == [.relisten])
        #expect(RecordRequest.effects(of: .pause, paused: false) == [.pause])
        #expect(RecordRequest.effects(of: .pause, paused: true) == [])
    }

    /// A paused capture is published as `paused` in the live file, which the
    /// server's watchdog reads, whatever recognition is doing.
    @Test func pausedCaptureIsPublished() async {
        let coordinator = LiveTranscriptionCoordinator(resolve: { .unavailable("off") })
        let published = OSAllocatedUnfairLock<[LiveTranscriptionCoordinator.Status]>(initialState: [])
        await coordinator.beginRecording(
            enabled: true, update: { snapshot in published.withLock { $0.append(snapshot.status) } },
            attach: { _ in })
        await coordinator.setCapturePaused(true)
        #expect(await coordinator.snapshot.status == .paused)
        #expect(published.withLock { $0.last } == .paused)
        await coordinator.setCapturePaused(false)
        #expect(await coordinator.snapshot.status == .unavailable("off"))
        await coordinator.finishRecording()
    }
}
