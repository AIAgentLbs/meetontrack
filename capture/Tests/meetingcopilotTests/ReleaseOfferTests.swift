import Foundation
import Testing
@testable import meetingcopilot

/// The menu's release line mirrors `updates.js` (MEETONTRACK-156).
@MainActor
@Suite("Release offer in the menu bar")
struct ReleaseOfferTests {
    let trusted = "https://github.com/AIAgentLbs/meetontrack/releases/tag/v0.9.1"

    func updates(notify: Bool = true, url: String? = nil, install: [String: Any]? = nil) -> [String: Any] {
        var value: [String: Any] = ["notify": notify, "latest": ["version": "0.9.1", "url": url ?? trusted]]
        if let install { value["install"] = install }
        return value
    }

    @Test("A trusted offer the person wants to hear about is shown and clickable")
    func offer() {
        let offer = ReleaseOffer(updates: updates())
        #expect(offer == ReleaseOffer(version: "0.9.1", kind: .available))
        #expect(offer?.isActionable == true)
    }

    @Test("Nothing when notify is off (switched off or dismissed), untrusted, or no release")
    func silent() {
        #expect(ReleaseOffer(updates: updates(notify: false)) == nil)
        #expect(ReleaseOffer(updates: updates(url: "https://evil.example/releases/tag/v0.9.1")) == nil)
        #expect(ReleaseOffer(updates: ["notify": true, "latest": NSNull()]) == nil)
    }

    @Test("A scheduled or running install shows even with notify off, and is not clickable")
    func job() {
        let scheduled = ReleaseOffer(updates: updates(notify: false, install: ["version": "0.9.1", "state": "scheduled"]))
        #expect(scheduled == ReleaseOffer(version: "0.9.1", kind: .scheduled))
        #expect(scheduled?.isActionable == false)
        let running = ReleaseOffer(updates: updates(install: ["version": "0.9.1", "state": "running"]))
        #expect(running?.kind == .running)
    }

    @Test("A failed install reads as failed with a retry of the release on offer")
    func failed() {
        let failed = ReleaseOffer(updates: updates(install: ["version": "0.9.1", "state": "failed"]))
        #expect(failed == ReleaseOffer(version: "0.9.1", kind: .failed))
        #expect(failed?.isActionable == true)
        #expect(failed?.shouldNotify(lastNotified: nil) == false)
        #expect(ReleaseOffer(updates: updates(notify: false, install: ["version": "0.9.1", "state": "failed"])) == nil)
        // The app's own failed request, like installError in updates.js; a server job wins over it.
        #expect(ReleaseOffer(updates: updates(), installFailed: "0.9.1")?.kind == .failed)
        #expect(ReleaseOffer(updates: updates(install: ["version": "0.9.1", "state": "running"]), installFailed: "0.9.1")?.kind == .running)
    }

    @Test("A failure of an older version leaves a newer release a fresh offer with its banner")
    func failedOlder() {
        let newer = ReleaseOffer(updates: updates(install: ["version": "0.9.0", "state": "failed"]))
        #expect(newer == ReleaseOffer(version: "0.9.1", kind: .available))
        #expect(newer?.shouldNotify(lastNotified: "0.9.0") == true)
        #expect(ReleaseOffer(updates: updates(), installFailed: "0.9.0")?.kind == .available)
    }

    @Test("A banner installs only its own version while it is still on offer")
    func banner() {
        #expect(ReleaseOffer(version: "0.9.1", kind: .available).installs(bannerVersion: "0.9.1"))
        #expect(!ReleaseOffer(version: "0.9.2", kind: .available).installs(bannerVersion: "0.9.1"))
        #expect(!ReleaseOffer(version: "0.9.1", kind: .scheduled).installs(bannerVersion: "0.9.1"))
    }

    @Test("Polls every 20 s during an install, otherwise every 15 minutes")
    func poll() {
        #expect(ReleaseOffer.pollInterval(for: ReleaseOffer(version: "1", kind: .running)) == 20)
        #expect(ReleaseOffer.pollInterval(for: ReleaseOffer(version: "1", kind: .scheduled)) == 20)
        #expect(ReleaseOffer.pollInterval(for: ReleaseOffer(version: "1", kind: .failed)) == 900)
        #expect(ReleaseOffer.pollInterval(for: nil) == 900)
    }

    @Test("One banner per new version, none for a job")
    func notifyOnce() {
        let offer = ReleaseOffer(version: "0.9.1", kind: .available)
        #expect(offer.shouldNotify(lastNotified: nil))
        #expect(offer.shouldNotify(lastNotified: "0.9.0"))
        #expect(!offer.shouldNotify(lastNotified: "0.9.1"))
        #expect(!ReleaseOffer(version: "0.9.2", kind: .running).shouldNotify(lastNotified: nil))
    }

    @Test("Texts match the web page, in both languages, without em-dashes or yo")
    func texts() {
        let spoken = InterfaceLanguage.current
        defer { InterfaceLanguage.current = spoken }
        InterfaceLanguage.current = .english
        #expect(ReleaseOffer(version: "1.2.3", kind: .available).title == "Version 1.2.3 available - Install")
        #expect(ReleaseOffer(version: "1.2.3", kind: .scheduled).title == "Version 1.2.3 will be installed after the call")
        #expect(ReleaseOffer(version: "1.2.3", kind: .running).title == "Updating to version 1.2.3…")
        InterfaceLanguage.current = .russian
        #expect(ReleaseOffer(version: "1.2.3", kind: .available).title == "Доступна версия 1.2.3 - установить")
        #expect(ReleaseOffer(version: "1.2.3", kind: .scheduled).title == "Версия 1.2.3 установится после звонка")
        #expect(ReleaseOffer(version: "1.2.3", kind: .running).title == "Обновляю до версии 1.2.3…")
        #expect(ReleaseOffer(version: "1.2.3", kind: .failed).title == "Не удалось обновить. Текущая версия продолжает работать. Повторить")
        InterfaceLanguage.current = .english
        #expect(ReleaseOffer(version: "1.2.3", kind: .failed).title == "Could not update. The current version keeps working. Try again")
    }
}
