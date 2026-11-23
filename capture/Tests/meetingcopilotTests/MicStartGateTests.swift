import Foundation
import Testing

@testable import meetingcopilot

/// MEETONTRACK-189 review: the microphone now starts on a background thread.
/// A voice-processing route that delivers silence asks main to fall back to
/// raw capture; if that request lands before `start` finishes, it was dropped
/// and the microphone stayed silent for the rest of the call.
struct MicStartGateTests {
    @Test("A fallback asked for while the start is running runs once the start finishes")
    func fallbackDuringStartIsKept() {
        let gate = MicStartGate()
        gate.beginStart()
        #expect(gate.deferFallback(), "held while starting")
        #expect(gate.finishStart(), "handed back to run")
        #expect(!gate.finishStart(), "only once")
    }

    @Test("Outside a start the fallback runs at once, and a failed start forgets it")
    func fallbackOutsideStartRunsNow() {
        let gate = MicStartGate()
        #expect(!gate.deferFallback())
        gate.beginStart()
        #expect(gate.deferFallback())
        gate.abandonStart()
        #expect(!gate.deferFallback())
        gate.beginStart()
        #expect(!gate.finishStart())
    }

    @Test("Racing a fallback against the end of a start never loses it")
    func noLostFallback() async {
        for _ in 0..<500 {
            let gate = MicStartGate()
            gate.beginStart()
            let ran = Counter()
            await withTaskGroup(of: Void.self) { group in
                group.addTask { if gate.finishStart() { ran.bump() } }
                group.addTask { if !gate.deferFallback() { ran.bump() } }
            }
            #expect(ran.count == 1)
        }
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func bump() { lock.lock(); value += 1; lock.unlock() }
}
