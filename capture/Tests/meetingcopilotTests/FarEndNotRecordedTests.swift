import Foundation
import Testing

@testable import meetingcopilot

/// MEETONTRACK-189 P0-1, P0-2, P1-10. On 2026.11.23 the far-end tap
/// delivered nothing for a whole call: the recording stopped at 20 minutes as
/// "no-call-audio" while the owner was still talking, nothing warned during
/// the call, and the one-sided report went out looking complete.
struct FarEndNotRecordedTests {
    private let settings = Config.AutoRecordSettings()
    private var window: TimeInterval { settings.silenceStop }
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("A far end never heard does not end a call you are still talking in")
    func neverHeardVetoesNoCallAudio() {
        for output in [true, false] {
            #expect(AutoRecordController.backstopStop(
                trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: output,
                farEndNeverHeard: true,
                micQuietFor: 1, farEndQuietFor: 2 * window + 1, settings: settings) == nil)
        }
        // Silence on both tracks still ends it.
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, farEndNeverHeard: true,
            micQuietFor: window + 1, farEndQuietFor: window + 1, settings: settings) == "silence")
    }

    @Test("Exact zeros read as the grant; faint samples as never heard; neither before 45 s")
    func farEndProblemCauses() {
        let at = start.addingTimeInterval(60)
        func problem(peak: Float, heard: Date? = nil, now: Date? = nil, measurable: Bool = true)
            -> SystemAudioRecorder.FarEndProblem? {
            SystemAudioRecorder.farEndProblem(
                sessionStartedAt: start, firstBufferAt: start, bufferCount: 500,
                highestPeak: peak, lastSoundAt: heard, levelMeasurable: measurable, now: now ?? at)
        }
        #expect(problem(peak: 0) == .silentTap)
        #expect(problem(peak: 0.0001) == .neverHeard)
        #expect(problem(peak: 0.3, heard: start.addingTimeInterval(5)) == nil)
        #expect(problem(peak: 0, now: start.addingTimeInterval(30)) == nil)
        #expect(problem(peak: 0, measurable: false) == nil)
        #expect(SystemAudioRecorder.FarEndProblem.silentTap.rawValue == "system_audio_permission")
    }

    @Test("capture_problems names a call whose far end was never recorded, not a voice memo")
    func captureProblemsInMeta() {
        #expect(RecordingSession.captureProblems(
            expectsFarEnd: true, micHeard: true, farEnd: .silentTap) == ["far_end_not_recorded"])
        #expect(RecordingSession.captureProblems(
            expectsFarEnd: true, micHeard: true, farEnd: nil).isEmpty)
        // A voice memo has no far end, and an empty room is not a call.
        #expect(RecordingSession.captureProblems(
            expectsFarEnd: false, micHeard: true, farEnd: .silentTap).isEmpty)
        #expect(RecordingSession.captureProblems(
            expectsFarEnd: true, micHeard: false, farEnd: .neverHeard).isEmpty)
    }

    @Test("A recorder-raised warning is published once per reason and closes on its own")
    func liveWarningFromRecorder() async {
        let coordinator = LiveTranscriptionCoordinator()
        await coordinator.beginRecording(enabled: false, update: { _ in }, attach: { _ in })
        await coordinator.noteCaptureWarning(
            reason: "system-audio-lost", cause: "system_audio_permission", since: start)
        await coordinator.noteCaptureWarning(reason: "system-audio-lost", cause: "never_heard")
        var warnings = await coordinator.snapshot.captureWarnings
        #expect(warnings.count == 1)
        #expect(warnings.first?.cause == "system_audio_permission")
        #expect(warnings.first?.ended_at == nil)
        await coordinator.endCaptureWarning(reason: "system-audio-lost")
        warnings = await coordinator.snapshot.captureWarnings
        #expect(warnings.first?.ended_at != nil)
        await coordinator.finishRecording()
    }
}
