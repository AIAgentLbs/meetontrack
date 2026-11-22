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
