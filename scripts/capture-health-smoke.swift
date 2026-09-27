import Foundation

/// Standalone gate for Macs whose Command Line Tools lack Swift Testing.
/// Compile together with the production CaptureRecoveryPolicy.swift.
@main struct CaptureHealthSmoke {
    static func main() {
        let now = Date(timeIntervalSince1970: 1000)
        func decision(buffer: Double = 0, nonzero: Double? = 50,
                      route: Bool = false, playing: Bool = true,
                      retry: Double? = nil, attempts: Int = 0) -> Bool {
            CaptureRecoveryPolicy.shouldRecover(
                now: now, firstBufferAt: now.addingTimeInterval(-100),
                lastBufferAt: now.addingTimeInterval(-buffer),
                lastNonzeroAt: nonzero.map { now.addingTimeInterval(-$0) },
                outputChanged: route, callHasOutput: playing,
                lastRecoveryAt: retry.map { now.addingTimeInterval(-$0) }, attempts: attempts
            )
        }
        precondition(decision())
        precondition(decision(buffer: 25, nonzero: 10))
        precondition(decision(nonzero: 10, route: true))
        precondition(!decision(nonzero: nil))
        precondition(!decision(playing: false))
        precondition(!decision(nonzero: 10))
        precondition(!decision(retry: 30))
        precondition(!decision(attempts: 3))
        print("capture health: 8 checks passed")
    }
}
