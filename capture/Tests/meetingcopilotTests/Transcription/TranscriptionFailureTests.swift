import Foundation
import Testing

@testable import meetingcopilot

/// A failed live transcript shows its reason, not "(STTRuntime.Failure error 1.)".
struct TranscriptionFailureTests {
    @Test("A transcription failure's localized description is its reason")
    func localizedDescriptionIsTheReason() {
        let error: Error = STTRuntime.Failure("the model is not downloaded")
        #expect(error.localizedDescription == "the model is not downloaded")
    }
}
