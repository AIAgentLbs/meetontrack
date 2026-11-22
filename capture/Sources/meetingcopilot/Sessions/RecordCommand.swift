import AppKit
import ArgumentParser
import Foundation

/// Start or stop a recording in the meetingcopilot that is already running.
///
/// It never records anything itself. System audio is granted to the
/// application, and a second recorder launched from a terminal captures
/// digital silence (see `.issues/rca-002`) — so this asks the running app and
/// says so plainly when nobody answers.
struct Record: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "record",
        abstract: "Start or stop recording in the running meetingcopilot."
    )

    @Argument(help: "start, stop, toggle, pause, resume, or relisten (restart recognition only) the current recording.")
    var action: RecordRequest.Action

    /// Test seam: who answers the request. The real one rings the running app.
    @MainActor static var ask: (RecordRequest.Action) -> Bool = { RecordRequest.askRunningApp($0) }

    /// No answer exits non-zero: a missing app, or an app older than this CLI
    /// that ignores an unknown verb, must not read as done. The server's Stop
    /// relies on it to fall back from `pause` to an immediate stop.
    func run() throws {
        let action = action
        let answered = MainActor.assumeIsolated { Record.ask(action) }
        guard answered else {
            FileHandle.standardError.write(Data(
                ("meetingcopilot isn't running. Start it from the Dock, or `launchctl kickstart "
                    + "gui/$(id -u)/com.aiagentlabs.meeting-copilot`.\n").utf8))
            throw ExitCode.failure
        }
    }
}

/// The same cross-process doorbell `meetingcopilot setup` uses, carrying which of the
/// verbs was asked for. Distributed notifications never leave this Mac.
enum RecordRequest {
    enum Action: String, ExpressibleByArgument, Sendable {
        case start
        case stop
        case toggle
        case pause
        case resume
        /// Restart recognition of a running recording, never unpause it: the
        /// server's recognition watchdog sends this, so it cannot undo a Stop.
        case relisten
    }

    enum Effect: Equatable, Sendable {
        case pause, unpause, relisten
    }

    /// What pause, resume and relisten do to a live session. Only an explicit
    /// `resume` unpauses; a paused session ignores `relisten`.
    static func effects(of action: Action, paused: Bool) -> [Effect] {
        switch action {
        case .pause: return paused ? [] : [.pause]
        case .resume: return paused ? [.unpause, .relisten] : [.relisten]
        case .relisten: return paused ? [] : [.relisten]
        case .start, .stop, .toggle: return []
        }
    }

    private static let request = Notification.Name("com.aiagentlabs.meeting-copilot.record")
    private static let acknowledged = Notification.Name("com.aiagentlabs.meeting-copilot.record-ack")

    @MainActor
    private final class Reply {
        var arrived = false
    }

    /// The request identifier and the verb travel together in the notification
    /// object, because that is the only field a distributed notification can
    /// carry between two processes that share no user info.
    private static func encode(_ id: String, _ action: Action) -> String {
        "\(id) \(action.rawValue)"
    }

    private static func decode(_ object: String?) -> (id: String, action: Action)? {
        guard let parts = object?.split(separator: " ", maxSplits: 1), parts.count == 2,
              let action = Action(rawValue: String(parts[1]))
        else { return nil }
        return (String(parts[0]), action)
    }

    @MainActor
    static func askRunningApp(_ action: Action, timeout: TimeInterval = 4) -> Bool {
        let center = DistributedNotificationCenter.default()
        let requestID = UUID().uuidString
        let reply = Reply()
        let token = center.addObserver(
            forName: acknowledged, object: requestID, queue: .main
        ) { _ in
            MainActor.assumeIsolated { reply.arrived = true }
        }
        defer { center.removeObserver(token) }

        center.postNotificationName(
            request, object: encode(requestID, action), deliverImmediately: true)

        let deadline = Date().addingTimeInterval(timeout)
        while !reply.arrived, Date() < deadline {
            _ = RunLoop.current.run(
                mode: .default,
                before: min(deadline, Date().addingTimeInterval(0.05))
            )
        }
        return reply.arrived
    }

    @MainActor
    static func observe(_ act: @escaping @MainActor (Action) -> Void) -> NSObjectProtocol {
        let center = DistributedNotificationCenter.default()
        return center.addObserver(forName: request, object: nil, queue: .main) { note in
            // Pull the Sendable string out before crossing into MainActor:
            // carrying the whole Notification across is a data race to Swift 6,
            // even though this observer is delivered on main.
            let object = note.object as? String
            MainActor.assumeIsolated {
                guard let (requestID, action) = decode(object) else { return }
                // Answer before acting. Starting a recording takes a moment —
                // the tap, the file, the engine — and a caller that waits for
                // the work to finish before hearing anything concludes that
                // nobody is home and says so, having just been obeyed.
                center.postNotificationName(
                    acknowledged, object: requestID, deliverImmediately: true)
                act(action)
            }
        }
    }
}
