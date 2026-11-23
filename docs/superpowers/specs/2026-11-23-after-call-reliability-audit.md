# After-call chain reliability audit (MEETONTRACK-189)

Date: 2026-11-23. Scope: the whole chain from capture to the After screen: capture (auto-record, permissions, system audio tap, stop rules), transcription, summary, delivery (e-mail, Drive, Telegram, Twenty), the After screen and Home/menu-bar notices. This was a read-only audit of `main` at d44a1f0, using local evidence from `~/Recordings` and `~/.config/meeting-copilot`. MEETONTRACK-188 (memo e-mails arrive marked as read) is out of scope.

Severity:
- P0: a call or its report is lost, cut short or delivered wrong, with no visible sign.
- P1: a silent failure, or a failure that does not survive a restart.
- P2: the failure is visible, but there is no automatic retry or the message is confusing.
- P3: minor.

## What happened on 2026-11-23 (evidence)

All times are UTC. Folder names use local time (UTC+1).

- **`2026.11.23-1346 Google Chrome`**: the call was not over when the recording stopped; the recorder never captured Chrome's audio. Duration was 1203 s, `stop_reason: no-call-audio`, with three tap rebuilds at +31, +61 and +91 s.
  - The system channel of `audio.m4a` sat at -112 to -143 dB RMS for every 30 s block of the 20 minutes. That is consistent with a tap delivering digital zeros.
  - The mic channel carried speech from about 5:20 to the very last second. The transcript has a single speaker (mic), and in its last minute (19-20) it has 12 segments.
  - 1203 s equals 2 × `silence_stop` (default 10 min) plus one tick: the `callAppHasOutput` extension ran out and `no-call-audio` fired while the owner was still talking. The recorder then stood down for as long as Chrome held the mic, so the rest of the call was not recorded.
  - The report was still generated from the one-sided transcript and sent at about 13:09 by e-mail, Telegram and Drive. The Twenty step is waiting for a record choice ("needs_choice").
- **`2026.11.23-1235 Google Chrome`**: this is the hung start.
  - `system.caf` was created at 11:35:47 and `mic.caf` at 11:46:48, 11 minutes later. Both are header-only (4096 bytes).
  - The folder's mtime (marker removed) is 11:52:17. There is no `meta.json`.
  - Inside `MicRecorder.start`, the main thread was blocked for about 11 minutes before the mic file was created. The start then failed about 5.5 minutes later, so the app was frozen for roughly 16 minutes in total. The folder is left as invisible litter.
- **`2026.11.23-1253` and `-1514`** (manual tests, `system_audio: all`): `system.caf` peak is -inf (exact zeros) in both. At 14:14 `mic.caf` is also -inf. The log says "No speech was recognized ... retrying cannot change this" and "compression failed ... ExtAudioFileWrite -50" (mic at 96 kHz).
- **`setup.json`**: `system_audio_heard_at` is 2026-10-01, which is older than the 30-day memory, yet setup is complete. Nothing has re-tested system audio since the reinstall.
- **`delivery-health.json`**: Twenty is `needs_choice` for every call since 11-18 (4 calls), so no CRM note has been written. 28 archive meetings from Sep 16 to Oct 1 are stuck in "recording" with no report.

## Findings

### Capture

**P0-1. A dead system tap ends a live call at 20 minutes as "no-call-audio".**
- Where: `capture/Sources/meetingcopilot/Meetings/AutoRecordController.swift:336-346`, `RecordingSession.swift:267-283`. `SystemAudioRecorder.isDigitallySilent` (`Audio/SystemAudioRecorder.swift:90-111`) is never called outside tests.
- Scenario: the far-end track never carried a sample. `farEndQuietFor` counts from the session start, so after 2 × `silenceStop` the rule stops the recording mid-call and stands down until Chrome lets go of the mic.
- Fix: in `backstopStop`, return nil for `no-call-audio` when the far end was never heard this session (`lastSystemSoundAt == nil` or digitally silent) and the mic had sound within `silenceStop`. That is our capture failure, not the end of the call. `silence` and `max-duration` still apply. Add a unit case beside the existing `backstopStop` tests.

**P0-2. A far end that was never heard produces no warning in the call.**
- Where: `Transcription/LiveTranscriptionCoordinator.swift:419` (a warning needs `lastSystemSignal != nil`) and `RecordingSession.swift:569-596`. The second path is a single macOS notification, and its app-scope text asks a non-technical user to edit `system_audio` in a config file.
- Scenario: the tap is dead from the first buffer. `capture_warnings` stays empty, so `call.js:174` and `app.js:2016` show nothing. The notification is lost if notification permission is missing.
- Fix:
  - Treat a nil `lastSystemSignal` as the epoch start once the mic has carried speech, so the existing 45-second rule fires.
  - In addition, when `isDigitallySilent()` becomes true after 10 s, add a `capture_warnings` entry with `reason: "system_audio_permission"`. Post a banner whose click opens `Privacy_ScreenCapture`, with no config advice.

**P0-3. Auto-record never starts while the calendar permission prompt is open.**
- Where: `MeetingCopilot.swift:684-687` awaits `CalendarWatcher.requestAccess()` (`Meetings/CalendarWatcher.swift:47-48`), and only then calls `autoRecord.start()`.
- Scenario: a reinstall resets grants, so calendar access is `.notDetermined`. The system prompt waits for an answer, and until someone answers it the auto-record ticker does not exist. Chrome holds the mic and nothing records. This matches symptom 1.
- Fix: call `autoRecord.start()` first, then request calendar access in its own Task. The calendar trigger already tolerates "not authorized yet".

**P0-4. Starting a recording runs synchronously on the main thread with no timeout.**
- Where: `MeetingCopilot.swift:793-797`, `RecordingSession.swift:143-153`, `Audio/MicRecorder.swift:268-273` and `370-455` (`engine.inputNode`, `outputFormat` and `engine.start()` on the main thread).
- Scenario: the mic grant is missing or pending, or CoreAudio stalls. The whole app freezes: the menu, the ticker and Stop. The 1235 folder shows a block of about 11 minutes and then a failure about 5.5 minutes later. This matches symptom 1 ("manual start, no mic file, hang").
- Fix:
  - Preflight `AVCaptureDevice.authorizationStatus(for: .audio)`. On `.notDetermined`, await `requestAccess` before building the engine. On `.denied`, record the far end only and show the existing "no microphone" banner.
  - Start the mic engine behind a 10 s watchdog. On timeout, fail the mic half visibly and keep the system track.

**P1-5. Lost macOS grants are not re-verified after an install.**
- Where: `Setup/Permissions.swift:121-135`, `Setup/SetupState.swift:54-65` (the proof is a date), and `MeetingCopilot.swift:614-617` (setup is not reopened).
- Scenario: a reinstall resets the grants, setup still counts as complete, and the first call records zeros. The tests at 11:53 and 14:14 recorded exact zeros. The designated requirement is pinned to a self-signed leaf certificate (`capture/Packaging/designated-requirement.txt`). If release builds are signed with a different certificate than the one that holds the grants, every install resets them. This is unconfirmed: compare `codesign -dr -` across the 0.1.34 and 0.1.35 artifacts.
- Fix: on the first launch after the bundle version or cdhash changes, run the silent tone test and check the mic status. If either fails, reopen only the failing setup row. Treat the first recording's `isDigitallySilent` as the same failure.

**P2-6. AAC archive fails whenever the mic runs at 96 kHz.**
- Where: `Audio/TrackCompressor.swift:210` (`rate = max(source rates)`) and `233-240`.
- Scenario: the Insta360 runs at 96 kHz on built-in speakers, so the AAC writer returns -50 and the uncompressed CAFs pile up (about 1.3 GB per hour).
- Fix: clamp `rate` to 48 000.

**P3-7. A failed start leaves a folder of empty CAFs and no marker.**
- Where: `RecordingSession.swift:149-158`.
- Scenario: the folder is invisible litter (see 1235).
- Fix: delete the folder when both files are header-only.

### Transcription and summary

**P1-8. "No speech recognized" hides a capture failure.**
- Where: `Transcription/TranscriptionCoordinator.swift:315-318` (`EmptyTranscript` is permanent) and `284-298`.
- Scenario: both tracks are exact zeros because a grant is missing. The session is retired with "retrying cannot change this", which is wrong once the grant is restored.
- Fix: check the peak level before STT. If it is zero, record `transcription_failed = "no_audio_captured"` with the permission that is missing, and show that on Home.

**P2-9. A transient transcription failure is retried only at launch or when the network changes.**
- Where: `TranscriptionCoordinator.swift:89-101` and `277-309`, `MeetingCopilot.swift:673-678`.
- Scenario: a local model crash leaves the call untranscribed until the next relaunch. The only alert is a notification.
- Fix: add a 15-minute `resumePending` timer while sessions with `transcription_attempts < 3` exist.

Quitting mid-transcription is safe: the claim holds the owner's pid and is reclaimed when that process is dead. Summary failures do not block the report, because Python builds its own report.

### Report and delivery

**P1-10. A report goes out one-sided with no mark.**
- Where: `copilot/web/archive.py:745` and `794`. Only `stop_reason` is read. `system_recoveries`, far-end silence and capture warnings never reach the report gate or the text.
- Scenario: the 1346 report went to e-mail, Telegram and Drive built from the owner's voice alone.
- Fix: Swift writes `capture_problems: ["far_end_not_recorded", ...]` into meta.json. Python prints one line at the top of the report and puts a banner on the After screen. Auto-send stays, per the fewest-clicks rule.

**P1-11. A stale `.recording.json` blocks every later report.**
- Where: `archive.py:1821-1824` (any marker counts as active) and `recording_health.py:100-102`. In Swift, `RecordingSession.swift:386-395` keeps the marker when no audio exists, and `368-376` keeps it when the marker is unreadable.
- Scenario: a kill between writing the marker and creating the files. From then on every report waits forever, with no signal. The trigger is rare, but nothing is delivered until a human finds the file.
- Fix:
  - Ignore markers whose pid is dead (`owner_alive`) and raise them as a health issue.
  - In Swift, remove the marker in the no-audio branch.

**P1-12. One unexpected exception in `deliver` aborts the whole retry scan.**
- Where: `archive.py:1489-1503` (try/finally, no except), `server.py:3134-3142`.
- Scenario: the same report throws first on every 60-second scan, so older reports are never retried. The only trace is a print.
- Fix: wrap each report in try/except, set `delivery_retry_at` to +15 min and `delivery_error`, and continue.

**P1-13. "Waiting" never escalates.**
- Where: `delivery_health.py:158-159` and `172`, `archive.py:1864-1870`.
- Scenario: the analysis rebuild keeps failing (for example, the AI is signed out), or a Hold is forgotten. The report stays "waiting_for_end" for 3 days, then retries stop, with nothing on Home.
- Fix: a report still waiting after 2 h becomes `action_required` with its reason (rebuild, final transcript or hold).

**P1-14. A meeting can stay "recording" forever.**
- Where: `archive.py:267`, `558` and `1555`.
- Scenario: the app quits before the exporter writes "finished", so the meeting gets no report and no flag. 28 meetings from Sep 16 to Oct 1 are in this state.
- Fix: treat the meeting as finished when its recording has a `meta.json`, or when it is stale and no marker is live.

**P1-15. The CRM is never written in practice.**
- Where: `archive.py:1456-1457` (`needs_choice` is never retried) and `2340-2368`.
- Scenario: Twenty auto-match failed for all 4 calls since 11-18. The note waits for a choice that is surfaced only in the web header pill. The cause of the match failure was not investigated.
- Fix:
  - Find why `_deliver_twenty` gets no unique match on these calls.
  - Match by attendee e-mail, then by domain.
  - Ask once on Home with the candidates.

**P2-16. Errors before the send are recorded as "unknown" and never retried automatically.**
- Where: `archive.py:2219-2222` (the SMTP connect error is caught with the send) and `telegram_delivery.py:78-79`.
- Fix: count errors raised before `send_message` or the upload as "failed".

**P2-17. A Drive list blip reads as "sign in again" and can duplicate folders.**
- Where: `archive.py:1966-1992`.
- Fix: `_gws_items` returns None on error, which maps to "failed". Create a folder only after a successful list.

**P2-18. Drive runs first and holds the archive lock for up to about 20 `gws` calls.**
- Where: `archive.py:1317` and `2111-2116`.
- Fix: send e-mail and Telegram before Drive, or give Drive one overall deadline.

**P2-19. A manual Retry or Send again that throws leaves channels at "unknown".**
- Where: `delivery_retry.py:91-114`.
- Fix: on error, restore the channels `deliver` never reached.

**P2-20. The installer waits for a recording but not for a report being sent.**
- Where: `install.sh:28-39`.
- Scenario: a quit mid-send turns that channel into "unknown", which is never resent.
- Fix: the updater also waits while `/api/delivery/health` reports a send in flight.

### Notices (Home, menu bar, After)

**P2-21. Every capture failure and all delivery health reach the user only through macOS banners or the web header pill.**
- Where: `capture/Sources/meetingcopilot/Notifications.swift:52-64` (silently dropped when notification permission is missing, which a reinstall can reset). Neither `home.js` nor the Swift menu bar reads `/api/delivery/health` (`server.py:3397`).
- Fix: the menu bar polls the delivery health and the live `capture_warnings`, and shows a red state plus one line. This needs no notification permission.

**P3-22. Other minor items:**
- A Drive copy rebuilt after the delivery window stays stale (`delivery_health.py:120-121`, seen on 11.19-1603).
- Empty manual tests may show "final transcript missing" on Home for 3 days (`archive.py:1550-1563`).
- No code writes to repos or context folders after a call. `repo_preparations.py`, `local_context.py` and `config/refresh-repos.py` only read before or during calls. If the owner expects an after-call repo update, that is a missing feature, not a reliability bug.

## Ordered fix plan (smallest set that makes the chain durable and visible)

1. P0-3: start auto-record before the calendar prompt. This is a one-line reorder.
2. P0-4: preflight mic consent and run the mic start behind a 10 s watchdog. A failed start removes its empty folder (P3-7).
3. P0-1 + P0-2 + P1-10: add one signal, "far end never heard / digitally silent", computed in `SystemAudioRecorder`. It feeds three consumers:
   - a veto on `no-call-audio`;
   - a live `capture_warnings` entry plus a banner opening the System Audio pane;
   - `capture_problems` in meta.json, which Python prints on the report and the After screen.
4. P1-5 + P1-8: after an install, re-run the tone test and the mic check. Report a zero-audio session as "no audio captured (permission)" rather than "no speech".
5. P1-11 + P1-12: skip dead markers, and catch errors per report in the retry scan.
6. P2-21: a menu-bar state fed by delivery health and capture warnings, so nothing depends on notification permission.

Then, in order: P1-13, P1-14, P1-15, P2-6, and the P2 delivery items.

### End-to-end check for the release gate

Run it on the Mac after installing the candidate, with `silence_stop_minutes: 1`.

1. `tccutil reset All com.aiagentlbs.meetingcopilot.capture`, then install. Leave the calendar prompt unanswered.
2. Open a Chrome tab that holds the mic. Pass if a mic-activity recording starts within `start_delay + 10 s`.
3. Deny System Audio Recording and speak with `say` for 3 minutes. Pass if:
   - `capture_warnings` appears in the live file within 60 s;
   - the recording does not stop with `no-call-audio`.
4. Grant System Audio and stop. Repeat with a known WAV playing in the Chrome tab plus `say` into the mic.
5. Pass if, within 5 minutes of the stop:
   - both tracks have a non-zero peak;
   - the transcript has two speakers;
   - `meta.json` has no `capture_problems`;
   - the report's mail, Telegram and Drive statuses are `sent`/`uploaded`;
   - `delivery-health.json` has no new open issue.

Script it as one `scripts/` gate that prints PASS/FAIL per step.

## What matters for the live demo on 2026-11-26

- P0-3, P0-4 and P1-5 decide whether recording starts at all after the last install. Do not install a new build after the final rehearsal. If one is installed, open the app, answer the calendar and mic prompts, and run the system audio tone test before the demo.
- P0-1 and P0-2 decide whether the far end is recorded and whether anyone notices in time. A demo call longer than 20 minutes with a dead tap gets cut off.
- P1-10: without the fix, a one-sided report goes out looking complete.
- P1-15 matters only if the demo shows the CRM step.
- The delivery-side P1/P2 items (P1-11 to P1-14, P2-16 to P2-20) are unlikely to show in a single demo run.
