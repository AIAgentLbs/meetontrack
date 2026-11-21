import ArgumentParser
import Foundation

/// Microphone and call-audio permission as one JSON line, for the local web
/// server to warn before a call. It only reads the current state: no prompt,
/// no capture. The server is started by the app, so the microphone answer is
/// the app's own grant.
struct PermissionsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "permissions",
        abstract: "Print microphone and call-audio permission as JSON."
    )

    func run() throws {
        var answer: [String: Any] = MainActor.assumeIsolated {
            Self.report(
                microphone: SetupPermissions.microphone(),
                heardAt: SetupState.systemAudioHeardAt(),
                now: Date())
        }
        // Auto-record reads skip-recording.json, so Home may offer "Do not record".
        answer["skip_recording"] = true
        printJSON(answer)
    }

    /// A microphone nobody has decided on is `unknown`: auto-record raises the
    /// system prompt itself. Call audio has no API that reads it, so a tone
    /// heard this month is the only `granted`, and it is never `denied`.
    static func report(microphone: SetupPermissions.State, heardAt: Date?, now: Date) -> [String: String] {
        let mic: String
        switch microphone {
        case .granted: mic = "granted"
        case .denied: mic = "denied"
        case .notAsked, .unknown: mic = "unknown"
        }
        let heard = SetupPermissions.rememberedSystemAudio(heardAt: heardAt, now: now) == .heard
        return ["microphone": mic, "call_audio": heard ? "granted" : "unknown"]
    }
}
