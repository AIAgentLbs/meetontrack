import Foundation
import Testing

@testable import meetingcopilot

/// When an automatic recording is thrown away instead of kept.
///
/// The rule is arithmetic, and the arithmetic was wrong for as long as it was
/// only ever evaluated inside the method that stops a session: every stop
/// reason has to wait out a quiet period before it can fire, so a recording
/// compared whole against the minimum was always longer than the minimum and
/// nothing was ever discarded (`.issues/008`). These are the cases that were
/// measured on real calls, plus one floor per reason.
struct AutoRecordTests {
    private let settings = Config.AutoRecordSettings()

    @Test("Automatic meeting minimum defaults to five minutes")
    func fiveMinuteDefault() {
        #expect(settings.minDuration == 300)
    }

    /// The case from the issue: nineteen seconds of Zoom, then ninety seconds
    /// of meetingcopilot waiting to be sure the call was over, kept as a 99-second
    /// recording with 29 MB of audio and nothing in it.
    ///
    /// The wait it was measured under is written here rather than taken from
    /// the defaults, which are now fifteen seconds: the point of the case is the
    /// arithmetic, and it should keep failing the way it failed then no matter
    /// what the default becomes.
    @Test("A nineteen-second join is thrown away despite the wait that follows it")
    func shortJoinIsDiscarded() {
        var measured = settings
        measured.stopDelay = 90

        #expect(AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "call-ended", duration: 99, settings: measured))
    }

    @Test("A real meeting is kept")
    func realMeetingIsKept() {
        #expect(!AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "call-ended", duration: 45 * 60, settings: settings))
    }

    /// If you pressed the button, nine seconds of it were nine seconds you
    /// meant. The guard is on the trigger, not on the reason, so it holds even
    /// when a manual recording happens to be stopped by one of the auto rules.
    @Test("A nine-second manual recording is kept")
    func manualIsNeverDiscarded() {
        #expect(!AutoRecordController.shouldDiscard(
            trigger: .manual, reason: "manual", duration: 9, settings: settings))
        #expect(!AutoRecordController.shouldDiscard(
            trigger: .manual, reason: "call-ended", duration: 9, settings: settings))
    }

    /// Each stop reason waits out a different quiet period, and each of those
    /// waits used to be enough on its own to push the recording past the
    /// minimum. One case per reason, at ten seconds of actual meeting.
    @Test("Every reason that ends by itself has its own wait taken out")
    func everyReasonHasItsFloorRemoved() {
        #expect(AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "call-ended",
            duration: settings.stopDelay + 10, settings: settings))
        #expect(AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "silence",
            duration: settings.silenceStop + 10, settings: settings))
        #expect(AutoRecordController.shouldDiscard(
            trigger: .calendar, reason: "calendar-event-ended",
            duration: AutoRecordController.calendarEndQuiet + 10, settings: settings))
    }

    /// The same three waits, with a meeting long enough to keep on the other
    /// side of them — so the subtraction cannot be mistaken for "discard
    /// anything that ended by itself".
    @Test("A long enough meeting survives every reason")
    func longEnoughMeetingsSurviveEveryReason() {
        #expect(!AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "call-ended",
            duration: settings.stopDelay + 20 * 60, settings: settings))
        #expect(!AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "silence",
            duration: settings.silenceStop + 20 * 60, settings: settings))
        #expect(!AutoRecordController.shouldDiscard(
            trigger: .calendar, reason: "calendar-event-ended",
            duration: AutoRecordController.calendarEndQuiet + 20 * 60, settings: settings))
    }

    /// "Shorter than" is what the setting says, so a meeting of exactly the
    /// minimum is kept and one second less is not.
    @Test("The minimum itself is kept and a second under it is not")
    func boundaryIsExclusive() {
        #expect(!AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "call-ended",
            duration: settings.stopDelay + settings.minDuration, settings: settings))
        #expect(AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "call-ended",
            duration: settings.stopDelay + settings.minDuration - 1, settings: settings))
    }

    /// "app-quit" and "max-duration" say only that we stopped the recording,
    /// which is no evidence about whether a meeting was happening. Discarding
    /// on those threw away the first fifteen seconds of a genuine call that
    /// started while meetingcopilot was being reinstalled.
    @Test("A recording we ended ourselves is never discarded")
    func reasonsWeChoseAreKept() {
        for reason in ["app-quit", "max-duration", "manual", "no-call-audio"] {
            #expect(!AutoRecordController.shouldDiscard(
                trigger: .micActivity, reason: reason, duration: 5, settings: settings))
        }
    }

    /// The waits are settings, not constants, so someone who lengthens the
    /// stop delay does not thereby start keeping short joins again.
    @Test("A tuned stop delay comes out of the length in the same way")
    func waitsFollowTheSettings() {
        var patient = Config.AutoRecordSettings()
        patient.stopDelay = 300

        #expect(AutoRecordController.shouldDiscard(
            trigger: .micActivity, reason: "call-ended", duration: 310, settings: patient))
        #expect(AutoRecordController.trailingQuiet(for: "call-ended", settings: patient) == 300)
        #expect(AutoRecordController.trailingQuiet(for: "app-quit", settings: patient) == nil)
    }
}

/// 2026.11.08: a browser kept the mic after a call, room noise kept the mic
/// track "speaking", and an empty room was recorded for 4.8 hours. No call
/// audio for the silence window ends an automatic recording on its own.
struct NoCallAudioStopTests {
    private let settings = Config.AutoRecordSettings()
    private var window: TimeInterval { settings.silenceStop }

    @Test("Mic noise with silent call audio stops an automatic recording")
    func roomNoiseStops() {
        for trigger in [RecordingSession.Trigger.micActivity, .calendar] {
            #expect(AutoRecordController.backstopStop(
                trigger: trigger, levelsMeasurable: true,
                micQuietFor: 1, farEndQuietFor: window + 1, settings: settings) == "no-call-audio")
            #expect(AutoRecordController.backstopStop(
                trigger: trigger, levelsMeasurable: true,
                micQuietFor: 1, farEndQuietFor: window - 1, settings: settings) == nil)
        }
    }

    @Test("A paused automatic recording is not stopped for missing call audio")
    func pausedKeepsGoing() {
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, paused: true,
            micQuietFor: 1, farEndQuietFor: window + 1, settings: settings) == nil)
    }

    @Test("A manual recording is never stopped for missing call audio")
    func manualNeverStops() {
        #expect(AutoRecordController.backstopStop(
            trigger: .manual, levelsMeasurable: true,
            micQuietFor: 1, farEndQuietFor: 5 * 3600, settings: settings) == nil)
    }

    @Test("Call audio keeps an automatic recording running")
    func callAudioKeepsRunning() {
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true,
            micQuietFor: 5 * 3600, farEndQuietFor: 1, settings: settings) == nil)
    }

    @Test("A stalled call-audio capture is an outage, not the end of the call")
    func stalledCaptureDoesNotStop() {
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callTrackStalled: true,
            micQuietFor: 1, farEndQuietFor: 5 * 3600, settings: settings) == nil)
    }

    /// MEETONTRACK-138: a browser holds a silent output stream open after the
    /// call. Running output buys a recovery window, not the duration ceiling.
    @Test("Call-app output without sound defers the stop by one window, not forever")
    func lingeringOutputIsBounded() {
        // A short glitch within the bound: the tap may be recovering.
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true,
            micQuietFor: 1, farEndQuietFor: window + 1, settings: settings) == nil)
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true,
            micQuietFor: 1, farEndQuietFor: 2 * window, settings: settings) == nil)
        // Past the bound the open stream no longer counts as evidence.
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true,
            micQuietFor: 1, farEndQuietFor: 2 * window + 1, settings: settings) == "no-call-audio")
        // Manual and paused recordings stay untouched past the bound.
        #expect(AutoRecordController.backstopStop(
            trigger: .manual, levelsMeasurable: true, callAppHasOutput: true,
            micQuietFor: 1, farEndQuietFor: 5 * 3600, settings: settings) == nil)
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true, paused: true,
            micQuietFor: 1, farEndQuietFor: 5 * 3600, settings: settings) == nil)
    }

    /// MEETONTRACK-207: the call-audio track went silent mid-call while the
    /// call app kept playing and you kept presenting; the recording stopped
    /// as "no call audio" with you mid-sentence.
    @Test("A far end lost mid-call does not stop a recording while you are still speaking")
    func farEndLostWhileSpeaking() {
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true,
            micSpeechQuietFor: 5, micQuietFor: 1, farEndQuietFor: 2 * window + 180,
            settings: settings) == nil)
        // Once you stop speaking the usual rule applies again.
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true,
            micSpeechQuietFor: window + 1, micQuietFor: 1, farEndQuietFor: 2 * window + 180,
            settings: settings) == "no-call-audio")
        // Room noise is level without words: it holds nothing (MEETONTRACK-137).
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true,
            micSpeechQuietFor: nil, micQuietFor: 1, farEndQuietFor: 2 * window + 1,
            settings: settings) == "no-call-audio")
        // Without the call app playing, your words alone do not hold it.
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true,
            micSpeechQuietFor: 5, micQuietFor: 1, farEndQuietFor: window + 1,
            settings: settings) == "no-call-audio")
        // Silence on both tracks still ends it.
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true, callAppHasOutput: true,
            micSpeechQuietFor: 5, micQuietFor: window + 1, farEndQuietFor: window + 1,
            settings: settings) == "silence")
    }

    @Test("A new or growing microphone line counts as speech; a repeat does not")
    @MainActor
    func liveMicSpeechMark() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let session = try RecordingSession(root: root, trigger: .micActivity)
        let t0 = Date(timeIntervalSince1970: 1_000)
        session.noteLiveMicSpeech(nil, now: t0)
        #expect(session.lastMicSpeechAt == nil)
        session.noteLiveMicSpeech("10|hello", now: t0)
        session.noteLiveMicSpeech("10|hello", now: t0.addingTimeInterval(60))
        #expect(session.lastMicSpeechAt == t0)
        session.noteLiveMicSpeech("10|hello there", now: t0.addingTimeInterval(90))
        #expect(session.lastMicSpeechAt == t0.addingTimeInterval(90))
    }

    @Test("Both tracks silent is still reported as silence, and unmeasurable levels stop nothing")
    func silenceAndUnmeasurable() {
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: true,
            micQuietFor: window + 1, farEndQuietFor: window + 1, settings: settings) == "silence")
        #expect(AutoRecordController.backstopStop(
            trigger: .micActivity, levelsMeasurable: false,
            micQuietFor: window + 1, farEndQuietFor: window + 1, settings: settings) == nil)
    }

    /// The app that defeated "call-ended" still holds the mic after a backstop
    /// stop; the controller must not start the same recording again.
    @Test("A backstop stop does not restart while the app still holds the mic")
    @MainActor
    func backstopDoesNotRearm() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var session: RecordingSession? = try RecordingSession(root: root, trigger: .micActivity)
        var clock = Date()
        var stops: [String] = []
        var starts = 0
        var settings = Config.AutoRecordSettings()
        settings.startDelay = 0
        let controller = AutoRecordController(
            settings: settings, calendar: nil, loadSettings: { settings },
            checkMic: { _ in
                MicActivityMonitor.Result(
                    active: true, names: ["Google Chrome"], families: ["com.google.Chrome"],
                    allHolders: ["Google Chrome"])
            },
            now: { clock }, skips: { [] }, notifyMicrophoneMissing: {})
        controller.currentSession = { session }
        controller.stopRecording = { stops.append($0); session = nil }
        controller.startRecording = { _, _ in starts += 1 }

        controller.tick()
        clock.addTimeInterval(settings.silenceStop + 5)
        controller.tick()
        #expect(stops.count == 1)
        for _ in 0..<12 {
            clock.addTimeInterval(5)
            controller.tick()
        }
        #expect(starts == 0)
    }

    @Test("A solo calendar block at the same hour does not name a recording")
    func testSoloCalendarBlockDoesNotNameARecording() {
        func event(_ title: String, call: Bool) -> CalendarWatcher.Meeting {
            CalendarWatcher.Meeting(
                id: title, title: title, start: Date(), end: Date().addingTimeInterval(3600),
                attendees: [], remoteAttendees: [], link: nil, looksLikeCall: call)
        }
        let fixture = event("Home - Away [league]", call: false)
        #expect(CalendarWatcher.callEvent(among: [fixture]) == nil)
        #expect(
            CalendarWatcher.callEvent(among: [fixture, event("Weekly sync", call: true)])?.title
                == "Weekly sync")
        // A regional Zoom join link (us05web.zoom.com/j/...) is a call too.
        #expect(CalendarWatcher.conferenceMarkers.contains { "https://us05web.zoom.com/j/8812".contains($0) })
    }

    @Test("A call the person chose not to record does not start on its own")
    @MainActor
    func testSkippedCallDoesNotAutoStart() {
        for skip in [true, false] {
            var clock = Date(timeIntervalSince1970: 1_800_000_000)
            var starts = 0
            var settings = Config.AutoRecordSettings()
            settings.startDelay = 10
            let controller = AutoRecordController(
                settings: settings, calendar: nil, loadSettings: { settings },
                checkMic: { _ in
                    MicActivityMonitor.Result(
                        active: true, names: ["zoom.us"], families: ["us.zoom.xos"], allHolders: ["zoom.us"])
                },
                now: { clock },
                skips: { skip ? [SkipRecording.Call(start: clock, end: clock.addingTimeInterval(30 * 60))] : [] },
                notifyMicrophoneMissing: {})
            controller.startRecording = { _, _ in starts += 1 }

            controller.tick()
            clock.addTimeInterval(settings.startDelay + 5)
            controller.tick()

            #expect(starts == (skip ? 0 : 1))
            if skip {
                #expect(controller.lastDecision
                    == localised("skipped: chosen in MeetOnTrack", "пропуск: выбрано в MeetOnTrack"))
            }
        }
    }

    @Test("An automatic start without microphone access notifies once and still records")
    @MainActor
    func testDeniedMicrophoneNotifiesOnAutoStart() {
        for state in [SetupPermissions.State.denied, .granted] {
            var clock = Date(timeIntervalSince1970: 1_800_000_000)
            var starts = 0
            var notices = 0
            var settings = Config.AutoRecordSettings()
            settings.startDelay = 10
            let controller = AutoRecordController(
                settings: settings, calendar: nil, loadSettings: { settings },
                checkMic: { _ in
                    MicActivityMonitor.Result(
                        active: true, names: ["zoom.us"], families: ["us.zoom.xos"], allHolders: ["zoom.us"])
                },
                now: { clock },
                skips: { [] },
                microphone: { state },
                notifyMicrophoneMissing: { notices += 1 })
            controller.startRecording = { _, _ in starts += 1 }

            controller.tick()
            clock.addTimeInterval(settings.startDelay + 5)
            controller.tick()

            #expect(starts == 1)
            #expect(notices == (state == .denied ? 1 : 0))
        }
    }

    @Test("A skipped call stays skipped while it runs over, and the next hold records")
    @MainActor
    func testSkippedCallStaysSkippedWhileItRunsOver() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let end = start.addingTimeInterval(30 * 60)
        var clock = start.addingTimeInterval(-2 * 60)
        var active = true
        var starts = 0
        var settings = Config.AutoRecordSettings()
        settings.startDelay = 10
        settings.stopDelay = 15
        let controller = AutoRecordController(
            settings: settings, calendar: nil, loadSettings: { settings },
            checkMic: { _ in
                MicActivityMonitor.Result(
                    active: active, names: active ? ["zoom.us"] : [], families: active ? ["us.zoom.xos"] : [],
                    allHolders: active ? ["zoom.us"] : [])
            },
            now: { clock },
            skips: { [SkipRecording.Call(start: start, end: end)] },
            notifyMicrophoneMissing: {})
        controller.startRecording = { _, _ in starts += 1 }

        while clock <= end.addingTimeInterval(10 * 60) {
            controller.tick()
            clock.addTimeInterval(5)
        }
        #expect(starts == 0)

        active = false
        for _ in 0..<5 {
            controller.tick()
            clock.addTimeInterval(5)
        }
        active = true
        for _ in 0..<3 {  // held for exactly startDelay on the third tick; no session is faked, so stop there
            controller.tick()
            clock.addTimeInterval(5)
        }
        #expect(starts == 1)
    }

    @Test("Undo in MeetOnTrack lifts an active skip; a new end for the same call keeps it")
    @MainActor
    func testUndoLiftsActiveSkip() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        var clock = start.addingTimeInterval(-2 * 60)
        var stored: [SkipRecording.Call]? = [SkipRecording.Call(start: start, end: start.addingTimeInterval(30 * 60))]
        var starts = 0
        var settings = Config.AutoRecordSettings()
        settings.startDelay = 10
        let controller = AutoRecordController(
            settings: settings, calendar: nil, loadSettings: { settings },
            checkMic: { _ in
                MicActivityMonitor.Result(
                    active: true, names: ["zoom.us"], families: ["us.zoom.xos"], allHolders: ["zoom.us"])
            },
            now: { clock },
            skips: { stored },
            notifyMicrophoneMissing: {})
        controller.startRecording = { _, _ in starts += 1 }

        for _ in 0..<4 {
            controller.tick()
            clock.addTimeInterval(5)
        }
        #expect(starts == 0)
        // The server ends the skip earlier (a call booked after it): the same call, still skipped.
        stored = [SkipRecording.Call(start: start, end: clock)]
        controller.tick()
        clock.addTimeInterval(5)
        #expect(starts == 0)
        // The file cannot be read for a moment: that is not an Undo, the skip holds.
        stored = nil
        controller.tick()
        clock.addTimeInterval(5)
        #expect(starts == 0)
        // Undo removes the call from the file: the call app still holds the mic, and recording starts.
        stored = []
        controller.tick()
        #expect(starts == 1)
    }

    @Test("The skip file covers a call from five minutes before it starts until it ends")
    func testSkipFileWindow() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("skip-recording.json")
        // 09:00+01:00 is 08:00 UTC, the same instant as `start`.
        try Data(#"""
            {"version": 1, "calls": [{"key": "2027-01-15T09:00:00+01:00|Pilot review", "event_id": "",
              "start": "2027-01-15T09:00:00+01:00", "end": "2027-01-15T09:30:00+01:00"}]}
            """#.utf8).write(to: url)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        #expect(!SkipRecording.covers(start.addingTimeInterval(-6 * 60), at: url))
        #expect(SkipRecording.covers(start.addingTimeInterval(-4 * 60), at: url))
        #expect(SkipRecording.covers(start.addingTimeInterval(30 * 60 - 1), at: url))
        #expect(!SkipRecording.covers(start.addingTimeInterval(30 * 60), at: url))

        #expect(SkipRecording.calls(at: url) == [SkipRecording.Call(start: start, end: start.addingTimeInterval(30 * 60))])
        try Data("not json".utf8).write(to: url)
        #expect(!SkipRecording.covers(start, at: url))
        #expect(SkipRecording.calls(at: url) == nil)  // unreadable is not "no skips"
        #expect(!SkipRecording.covers(start, at: folder.appendingPathComponent("missing.json")))
        #expect(SkipRecording.calls(at: folder.appendingPathComponent("missing.json")) == [])
    }
}

@MainActor
struct ManualStopAutoRecordTests {
    private final class Clock {
        var date = Date(timeIntervalSince1970: 1_800_000_000)
    }

    private func controller(
        clock: Clock,
        micActive: @escaping () -> Bool,
        onStart: @escaping () -> Void
    ) -> AutoRecordController {
        var settings = Config.AutoRecordSettings()
        settings.startDelay = 0
        settings.stopDelay = 15
        let controller = AutoRecordController(
            settings: settings,
            calendar: nil,
            loadSettings: { settings },
            checkMic: { _ in
                MicActivityMonitor.Result(
                    active: micActive(),
                    names: micActive() ? ["zoom.us"] : [],
                    families: micActive() ? ["us.zoom.xos"] : [],
                    allHolders: micActive() ? ["zoom.us"] : []
                )
            },
            now: { clock.date },
            skips: { [] },
            notifyMicrophoneMissing: {}
        )
        controller.startRecording = { _, _ in onStart() }
        return controller
    }

    @Test("A manual stop does not expire while the same call stays active")
    func manualStopDoesNotExpireDuringCall() {
        let clock = Clock()
        var starts = 0
        let controller = controller(clock: clock, micActive: { true }) { starts += 1 }

        controller.noteManualStop()
        clock.date.addTimeInterval(60 * 60)
        controller.tick()

        #expect(starts == 0)
    }

    @Test("Automatic recording rearms after the manually stopped call ends")
    func manualStopRearmsAfterCallEnds() {
        let clock = Clock()
        var active = true
        var starts = 0
        let controller = controller(clock: clock, micActive: { active }) { starts += 1 }

        controller.noteManualStop()
        active = false
        controller.tick()
        clock.date.addTimeInterval(16)
        controller.tick()
        active = true
        controller.tick()

        #expect(starts == 1)
    }
}
