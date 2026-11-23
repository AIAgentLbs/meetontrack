import AVFoundation
import Foundation
import Testing

@testable import meetingcopilot

/// MEETONTRACK-189 P1-5 and P1-8: a reinstall reset the grants, setup still
/// counted as done, and the first calls recorded exact zeros that were then
/// retired as "no speech was recognized".
struct AfterInstallTests {
    private func scratch() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("after-install-\(UUID().uuidString)", isDirectory: true)
    }

    private func writeTrack(_ url: URL, amplitude: Float, seconds: Double = 2) throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        let frames = AVAudioFrameCount(48_000 * seconds)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        let samples = buffer.floatChannelData![0]
        for i in 0..<Int(frames) { samples[i] = amplitude * sin(Float(i) * 0.06) }
        try file.write(from: buffer)
    }

    @Test("Exact zeros on every track read as no audio captured; any sound does not")
    func zeroAudioIsNotNoSpeech() throws {
        let dir = scratch()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let mic = dir.appendingPathComponent("mic.caf")
        let system = dir.appendingPathComponent("system.caf")
        let spoken = dir.appendingPathComponent("spoken.caf")
        try writeTrack(mic, amplitude: 0)
        try writeTrack(system, amplitude: 0)
        try writeTrack(spoken, amplitude: 0.2)

        #expect(TranscriptionCoordinator.capturedNothing([mic, system]))
        #expect(!TranscriptionCoordinator.capturedNothing([mic, spoken]))
        // A track that cannot be read is no evidence of silence.
        #expect(!TranscriptionCoordinator.capturedNothing([mic, dir.appendingPathComponent("missing.caf")]))
        #expect(!TranscriptionCoordinator.capturedNothing([]))
        #expect("\(TranscriptionCoordinator.NoAudioCaptured())".hasPrefix("no_audio_captured"))
    }

    @Test("The checked install is remembered beside the other setup state")
    func checkedBuildRoundTrip() throws {
        let dir = scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let state = dir.appendingPathComponent("setup.json")
        SetupState.markCompleted(at: state)
        SetupState.rememberSystemAudioHeard(at: state)
        #expect(SetupState.checkedBuild(at: state) == nil)

        SetupState.rememberCheckedBuild("0.1.37 (37) 2026-01-01T00:00:00Z", at: state)
        SetupState.forgetSystemAudioHeard(at: state)
        #expect(SetupState.checkedBuild(at: state) == "0.1.37 (37) 2026-01-01T00:00:00Z")
        #expect(SetupState.systemAudioHeardAt(at: state) == nil)
        #expect(SetupState.completedVersion(at: state) == SetupState.current)
    }

    @Test("Only the rows an install broke are reported")
    @MainActor
    func failingRows() {
        #expect(SetupState.afterInstallFailures(microphone: .granted, systemAudio: .heard).isEmpty)
        #expect(SetupState.afterInstallFailures(microphone: .notAsked, systemAudio: .heard) == ["microphone"])
        #expect(SetupState.afterInstallFailures(microphone: .granted, systemAudio: .silent) == ["system_audio"])
        #expect(SetupState.afterInstallFailures(microphone: .denied, systemAudio: .refused("x"))
            == ["microphone", "system_audio"])
    }
}
