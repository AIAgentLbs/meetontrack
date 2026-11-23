import Foundation
import Testing

@testable import meetingcopilot

/// MEETONTRACK-189: a recycled pid must not keep a dead recorder's marker
/// alive. The marker carries the owner's start time next to its pid.
struct MarkerOwnerTests {
    let pid = ProcessInfo.processInfo.processIdentifier

    @Test("This process's start time is readable and in the past")
    func readsStartTime() throws {
        let started = try #require(ProcessStart.of(pid))
        #expect(started <= Date().timeIntervalSince1970)
    }

    @Test("A live pid with a different start time is someone else")
    func recycledPidIsDead() throws {
        let started = try #require(ProcessStart.of(pid))
        #expect(ProcessStart.ownerAlive(["pid": pid, "pid_started": started]))
        #expect(!ProcessStart.ownerAlive(["pid": pid, "pid_started": started - 3600]))
        #expect(ProcessStart.ownerAlive(["pid": pid]), "an older marker falls back to the pid")
        #expect(!ProcessStart.ownerAlive(["pid": Int32.max]))
        #expect(!ProcessStart.ownerAlive([:]))
    }
}
