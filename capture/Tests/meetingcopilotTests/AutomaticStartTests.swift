import Foundation
import Testing

@testable import meetingcopilot

/// MEETONTRACK-189 P0-3: after a reinstall the calendar prompt waits for an
/// answer. Auto-record must already be watching while it does.
@MainActor
struct AutomaticStartTests {
    @Test("Auto-record starts while the calendar prompt is still unanswered")
    func autoRecordDoesNotWaitForCalendarPrompt() async {
        var started = false
        AppController.beginWatching(
            startAutoRecord: { started = true },
            requestCalendarAccess: {
                // An unanswered system prompt: it does not return within the test.
                try? await Task.sleep(for: .seconds(3600))
            })
        for _ in 0..<5 { await Task.yield() }
        #expect(started)
    }
}
