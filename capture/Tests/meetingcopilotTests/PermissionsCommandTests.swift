import Foundation
import Testing
@testable import meetingcopilot

/// What `meetingcopilot permissions` tells the local web server before a call.
struct PermissionsCommandTests {
    @Test("Microphone states and the remembered tone map to the web server's vocabulary")
    func testReportMapsStates() {
        let now = Date()
        let day: TimeInterval = 24 * 60 * 60
        let mic: [(SetupPermissions.State, String)] = [
            (.granted, "granted"), (.denied, "denied"), (.notAsked, "unknown"), (.unknown, "unknown"),
        ]
        for (state, expected) in mic {
            let report = PermissionsCommand.report(microphone: state, heardAt: nil, now: now)
            #expect(report == ["microphone": expected, "call_audio": "unknown"])
        }
        let report = { (heardAt: Date?) in
            PermissionsCommand.report(microphone: .granted, heardAt: heardAt, now: now)["call_audio"]
        }
        #expect(report(now.addingTimeInterval(-3 * day)) == "granted")
        #expect(report(now.addingTimeInterval(-40 * day)) == "unknown")
        #expect(report(nil) == "unknown")
    }
}
