# Redesign 3: the Call view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a live call the app shows one hint to say or ask next, a top bar that proves both sides are heard, and a Stop recording control with a short way back, replacing today's two panes of small text (MEETONTRACK-162).

**Architecture:** A new `call.js` renders `#call` (the feed and the dock) from the existing 2.5 s `/api/state` poll; pure functions pick the one hint, the heartbeat and the clock, so the browser checks test them directly. The transcript and the board stay the existing `.workspace` panes and open on demand as panels over the feed. The server gains a `RecordingControl` (stop pauses the recorder at once and stops it for good 30 s later, resume cancels), a `heard_question` field, a `reply` on questions put to the user, and a faster analysis right after such a question. Native work is one `record pause` verb on both recorders; without it Stop is immediate and offers no Resume.

**Tech Stack:** plain JS (no build), CSS, Python 3 stdlib (`unittest`, `http.server`), Playwright `.cjs` checks run with `node`, Swift (ArgumentParser, XCTest), C# (.NET, CI only).

**Spec:** `docs/superpowers/specs/2026-11-20-call-flow-redesign-design.md` (section "Call (MEETONTRACK-162)", the Call lines of "Carried into the build from the eighth critique", Acceptance, Order). **Contract (binding):** `docs/superpowers/plans/2026-11-21-redesign-contract.md`, edited by Task 1. **Look:** `/Users/m/Documents/ai-jam-2026-11-26/mockup/screens.html` `#s2` (classes `.call`, `.feed`, `.call-name`, `.say`, `.hint`, `.why`, `.why-acts`, `.heard-q`, `.heard-wait`, `.waiting`, `.problem`, `.dock`, `.dock-row`, `.ask`, `.ask-field`, `.ask-more`, `.pop`, `.recline`, `.timer`, `.beats`, `.beat`, `.bars`, `.beat.lost`, `.heard-line`, `.lbl-l`, `.lbl-s`); outside the repo, port its CSS, never its text or data. **Critique findings to meet:** `/Users/m/Documents/ai-jam-2026-11-26/mockup/critique8.md`, section 2.

## Global Constraints

- Every rule of the contract's "Global rules" applies: invented fixture data only ("Anna Petrova" / "Анна Петрова", "Example LLC" / "ООО Пример", "Pilot review" / "Обзор пилота", `example.com`); no AI or speech provider, model, effort or mode in code (prompt text stays provider-neutral); one settings store; no new dependency; no confirmation dialog on stop or resume.
- Every UI string exists in `translations.ru` and `translations.en` in `app.js`, with no "ё", no em-dash and no exclamation mark. No inline styles or scripts (page CSP).
- The Call view never offers "Do not record" (`SKIP_RECORDING_ENABLED = False`, MEETONTRACK-173).
- No per-hint triage buttons: no Skip, no status select in the feed (spec). The board keeps its own controls.
- One audio vocabulary: "heard" / "not heard" (RU "слышно" / "не слышно"). One end-of-call vocabulary: "Stop recording", "Recording stopped", "Resume recording". "How to fix" is the `.ql` look of `#call-status-help` everywhere.
- The hint is 22-24 px and the largest text in the view at every width; the error colour only marks problems; the recording dot is the accent colour.
- `screens.css` reuses the tokens of `styles.css` and the two of plan 1 (`--on-accent`, `--danger-soft`); no new colour token.
- Key labels on secondary controls are hidden under 1100 px (plan 1 rule); every shortcut is listed in the menu (`renderShortcuts`).
- Suite stays green: `python3.14 -m unittest discover -s copilot/web -p 'test_*.py'`; every `scripts/*.cjs` check stays green, run as `PLAYWRIGHT_MODULE=/Users/m/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright node scripts/<x>.cjs`.
- Commits in English, reference MEETONTRACK-162, end with the trailer lines of the session that does the work (this session: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JUJz1s89rdKHsbrEhg4qCF`); Task 1 updates the contract's trailer line to match (F21). Do not touch `call_plan.py` or `memo_writer.py` (plan 2) or `home.js` beyond what a task names.

## Review Focus

1. **A stale tab presses Stop after the call changed.** The person expects nothing to stop but their own call; a Stop for another `meeting_id` is refused with 409 `meeting_changed` and no recorder command runs (Task 2 `test_stale_meeting_refused`).
2. **The window is closed or the server restarts inside the 30 s after Stop.** The recorder is paused, and nobody is polling; the person expects the recording to end anyway. The pending stop is on disk and a 1 s loop sends it (Task 2 `test_restart_finishes_due_stop`).
3. **A recorder build without `record pause`** (an old Windows build, or Task 3 slipping). The person expects Stop to stop; it stops at once and no Resume is offered (Task 2 `test_old_recorder_stops_at_once`, Task 3 no-acknowledgement exit, Task 7 `stopped_final` built from `last_stop`).
4. **The recording ends by itself inside the 30 s and the next call starts recording.** The deferred stop must not end the new call (Task 2 `test_deferred_stop_skips_new_meeting`).
5. **A recorder that writes no capture marker (Windows today), or a quiet partner.** Silence must never read as "not heard"; only a stalled track or a lost call-audio warning does, in words (Task 5 heartbeat cases `windows_no_tracks`, `silent_partner`).

---

## File Structure

New: `copilot/web/recording_control.py` (stop, resume, the deferred stop), `copilot/web/call_feed.py` (the heard question and the prompt rule for short lines), `copilot/web/call.js` (the Call view), tests `copilot/web/test_recording_control.py`, `copilot/web/test_call_feed.py`, browser files `scripts/call-fixtures.cjs`, `scripts/test-call-ui.cjs`, `scripts/render-call-critique.cjs`.
Edited: the contract, `server.py`, `permissions.py`, `app.js` (translations, analysis trigger, one `window.callAsk` hook), `shell.js` (status, Stop, shortcuts, view switch), `index.html`, `screens.css`, `capture/Sources/meetingcopilot/Sessions/RecordCommand.swift`, `capture/Sources/meetingcopilot/MeetingCopilot.swift`, `windows/src/Amanu.App/CopilotControl.cs`, and existing `scripts/*.cjs` that need the board or transcript open during a live call.

### Task 1: Contract update

**Files:**
- Modify: `docs/superpowers/plans/2026-11-21-redesign-contract.md` (section "Recording control (plan 3)", plus the table row of plan 3)

Reason, one line in the contract: `record resume` only restarts live recognition of a running recording (`MeetingCopilot.swift:718`, `CopilotControl.cs:40`); after `record stop` there is nothing to resume, so Stop pauses first and stops for good after the undo window.

- [ ] **Step 1: Replace the section** with:
  - `POST /api/recording/stop` `{"meeting_id": "..."}` pauses the recorder at once (`record pause`) and answers `{"ok": true, "stopped_at": ISO, "until": ISO | null}`; the server sends `record stop` at `until` (`stopped_at` + 30 s). A recorder that cannot pause is stopped at once and `until` is null. A `meeting_id` other than the live one answers 409 `{"ok": false, "error": "meeting_changed"}`.
  - `POST /api/recording/resume` before `until` sends `record resume` and cancels the pending stop, `{"ok": true}`; otherwise 409 `{"ok": false, "error": "too_late"}`.
  - `/api/state` gains `recording_control`: `{"stopping": {"meeting_id", "stopped_at", "until"} | null, "last_stop": {"meeting_id", "stopped_at"} | null}`. Plan 4 reads `last_stop` for "the recording stopped at".
  - `/api/state` gains `heard_question`: `{"text", "speaker", "at"} | null`, a question from the other side not yet taken up by the analysis.
  - Journal items of category `INCOMING_QUESTION` may carry `reply` (string): a line the person can say back.
  - `POST /api/permissions/open` also accepts `"which": "sound_output"` (the system's sound output settings).
  - A stop with no undo window (a recorder that cannot pause) leaves `stopping` null and sets `last_stop`; the page shows "Recording stopped" from `last_stop` while the recorder still reports the call live (F1).
  - In "Global rules", the trailer line becomes: commits end with the trailer lines of the session that does the work (F21).
  - One line under the section: the undo window is 30 s, a builder timing the spec leaves open (spec "Left to the builder"); the spec's "10 s" wording is kept with `{n}` (F10). The `record pause` verb (plan 3 Task 3) is the minimum native change the spec's own Resume needs, despite the non-goal "No native recorder changes" (F9).
- [ ] **Step 2: Commit** `MEETONTRACK-162: contract, stop pauses first and resume cancels`. The final summary to the owner names the native change and the 30 s window as spec deviations (F9, F10).

### Task 2: Recording control on the server

**Files:**
- Create: `copilot/web/recording_control.py`, `copilot/web/test_recording_control.py`
- Modify: `copilot/web/server.py` (global `RECORDING_CONTROL` beside `SKIPS` near :2478; `RECORDING_STOP_FILE = TRANSCRIPT_FILE.with_name("recording-stop.json")` beside `SKIP_RECORDING_FILE` :89; `do_POST` routes `/api/recording/stop` and `/api/recording/resume`; `/api/state` field `recording_control`; a daemon thread `RECORDING_CONTROL.loop(TRANSCRIPT.stop)` started beside the fact-check thread :3946)

**Interfaces:**
- Produces:
  - `class RecordingControl(binary: Path, path: Path, current_meeting: Callable[[], str], run=subprocess.run, clock=time.time, grace: float = 30.0)`. It reads `path` on construction. File shape `{"version": 1, "stopping": {...} | null, "last_stop": {...} | null}`, written atomically with mode 0600 (`private_dir`, temp file plus `os.replace`, as `RecognitionGuard._save`).
  - `stop(meeting_id: str) -> dict` returning `{"stopped_at": ISO, "until": ISO | None}`. `meeting_id != current_meeting()` raises `ValueError("meeting_changed")` before any command. A pending stop for the same meeting returns it unchanged (no second command). Runs `[binary, "record", "pause"]` (`capture_output=True, text=True, timeout=10, check=False`); exit 0 stores `stopping`; any other outcome runs `[binary, "record", "stop"]` at once, stores `last_stop`, returns `until: None`; if that fails too, raises `RuntimeError("stop_failed")` and stores nothing.
  - `resume() -> None`: no `stopping`, or `clock() >= until`, raises `ValueError("too_late")`; else runs `[binary, "record", "resume"]` and clears `stopping` (non-zero exit raises `RuntimeError("resume_failed")` and keeps `stopping`).
  - `tick() -> None`: when `stopping` is due, clears it, stores `last_stop`, and runs `record stop` only if `current_meeting()` still equals its `meeting_id`. Command errors are swallowed (the recording may have ended by itself).
  - `loop(stop_event: threading.Event) -> None`: `tick()` every 1 s until the event is set.
  - `snapshot() -> {"stopping": ..., "last_stop": ...}`.
  - One `threading.Lock` covers every check-and-clear of `stopping` and the file write in `stop`, `resume` and `tick`, so at the window's edge exactly one of resume and the deferred stop wins (F8). `stop` and `resume` are called on HTTP threads, `tick` on the loop thread.
  - Routes: `/api/recording/stop` reads `meeting_id` (string, at most 1024 chars, else 400); `ValueError` answers 409 with its text as `error` (the route catches it itself: the global handler would answer 400, `server.py:3666`); `RuntimeError` answers 500 `{"ok": false, "error": "stop_failed"}`. `/api/recording/resume` the same with `too_late` / `resume_failed`. `current_meeting` is `lambda: annotated_snapshot()["meeting_id"]`, the id the page shows in `/api/state` (a logical id after a boundary split).

- [ ] **Step 1: Write the failing tests** (`test_recording_control.py`, fake `run` recording argv and returning `SimpleNamespace(returncode=...)`, fake `clock`):
  - `test_stop_pauses_and_schedules`: `stop("m1")` runs exactly `record pause`; `until` = `stopped_at` + 30 s; `snapshot()["stopping"]["meeting_id"] == "m1"`; the file holds the same.
  - `test_tick_sends_stop_when_due`: at +29 s `tick()` runs nothing; at +31 s it runs `record stop`, `stopping` is None, `last_stop == {"meeting_id": "m1", "stopped_at": ...}`.
  - `test_resume_within_window`: `resume()` at +10 s runs `record resume`; a `tick()` at +40 s runs nothing.
  - `test_resume_too_late`: `resume()` at +31 s raises `ValueError("too_late")`; with nothing pending also.
  - `test_old_recorder_stops_at_once`: `pause` exits 64 → `record stop` runs in the same call, `until is None`, `last_stop` set, then `resume()` raises `too_late`.
  - `test_stop_failed_stores_nothing`: both commands exit 1 → `RuntimeError`, snapshot unchanged.
  - `test_stale_meeting_refused`: `current_meeting` gives `"m2"`; `stop("m1")` raises `ValueError("meeting_changed")`, no command ran.
  - `test_double_stop_is_one_pause`: two `stop("m1")` calls → one `pause`, the same `until`.
  - `test_restart_finishes_due_stop`: a file with `until` in the past; a new `RecordingControl` on it and one `tick()` → `record stop`.
  - `test_resume_and_tick_race`: with a `run` fake that blocks on an `Event` during `record resume`, a `tick()` at the window's edge on another thread does not send `record stop` once resume has taken the pending stop (and the reverse: a tick that took it first makes `resume()` raise `too_late`).
  - `test_deferred_stop_skips_new_meeting`: pending for `m1`, `current_meeting` gives `"m2"` at the tick → no `record stop`; `stopping` cleared; `last_stop.meeting_id == "m1"`.
  - `test_routes` (server pattern of `test_context_sources_api.py:20-24`, `server.RECORDING_CONTROL` patched with a fake): POST `/api/recording/stop {"meeting_id": "m1"}` → 200 with `stopped_at`; the fake raising `ValueError("meeting_changed")` → 409 with that `error`; a foreign `Origin` → 403; `/api/recording/resume` → 200; GET `/api/state` has `recording_control`.
- [ ] **Step 2: Run** `python3.14 -m unittest copilot/web/test_recording_control.py`, expect FAIL (`ModuleNotFoundError`).
- [ ] **Step 3: Implement** `recording_control.py` and the server wiring.
- [ ] **Step 4: Run** the file, then the whole suite, expect PASS.
- [ ] **Step 5: Commit** `MEETONTRACK-162: stop pauses the recorder, resume cancels, the stop lands 30 s later`.

### Task 3: `record pause` on both recorders (native, may slip)

**Files:**
- Modify: `capture/Sources/meetingcopilot/Sessions/RecordCommand.swift:33-38` (`case pause`), `:17` (help text "start, stop, toggle, pause, or resume"), `:20-27` (no-acknowledgement exit), `capture/Sources/meetingcopilot/MeetingCopilot.swift:713-727` (`perform`), `windows/src/Amanu.App/CopilotControl.cs:31-45`
- Test: `capture/Tests/meetingcopilotTests/Sessions/RecordRequestTests.swift` (new)

**Interfaces:**
- macOS `perform(.pause)`: `guard let session, !session.isPaused else { return }`, `session.pause()`, `tick()`. `.resume` already un-pauses (`MeetingCopilot.swift:720`). The auto-record backstop never stops a paused session (`AutoRecordController.swift:339-340`), and `RecognitionGuard` never sends `resume` to it (it needs `audio_recording`, which is false while paused).
- Windows: `case "pause"`: not recording throws; recording and not paused → `runtime.TogglePauseAsync()`. `case "resume"`: also `TogglePauseAsync()` first when `runtime.State.IsPaused`, then `ResumeRecognitionAsync()` as today.
- No acknowledgement means failure (F7): when `askRunningApp` returns false, `Record.run` prints the same message to stderr and then `throw ExitCode.failure` (today `CleanExit.message` exits 0). So a not-running app, or an app process older than the installed CLI that ignores the unknown verb, makes `record pause` exit non-zero and the server falls back to an immediate stop. This also makes `/api/getting-started/start-recording` and the recognition guard's `record resume` report a missing app truthfully.
- Without this task the server's fallback in Task 2 applies: Stop is immediate, no Resume. This task is the minimum the spec's own Resume needs, despite its non-goal "No native recorder changes" (F9).

- [ ] **Step 1: Write the failing tests** `RecordRequestTests.testPauseIsAVerb`: `RecordRequest.Action(rawValue: "pause") == .pause` and `Record.parse(["pause"]).action == .pause`. `testNoAnswerIsFailure`: with the acknowledgement wait injected to return false (make `run()` take the asker as a static seam, `static var ask: @MainActor (RecordRequest.Action) -> Bool = { RecordRequest.askRunningApp($0) }`), `Record.parse(["pause"]).run()` throws `ExitCode.failure`.
- [ ] **Step 2: Run** `cd capture && swift test --filter RecordRequestTests` with the README CLT flags (`capture/README.md:31-38`), expect FAIL.
- [ ] **Step 3: Implement** Swift and C#.
- [ ] **Step 4: Run** the test, expect PASS; `swift build`; by hand on a Mac with a recording running: `.build/debug/meetingcopilot record pause` makes the live file's `status` `paused`, `record resume` brings `recording` back. The C# change builds in `.github/workflows/windows-candidate.yml`.
- [ ] **Step 5: Commit** `MEETONTRACK-162: recorders accept record pause`.

### Task 4: Heard question, reply, short lines, faster answer, sound settings

**Files:**
- Create: `copilot/web/call_feed.py`, `copilot/web/test_call_feed.py`
- Modify: `copilot/web/server.py` (`analysis_question` :2716, `MeetingJournal.add` :851 and `capture_questions` :921, `CodexSession.should_analyze` :2446, `/api/analyze` :3562-3564, `/api/state` :3180-3195), `copilot/web/permissions.py:13-17`, `copilot/web/app.js` (`state()` :3320-3331 and `analyze()` :3418)

**Interfaces:**
- Produces (`call_feed.py`):
  - `heard_question(segments: list[dict], journal: list[dict], *, analysis_started_at: float, busy: bool, now: float) -> dict | None`: the newest segment with `source == "system"`, not `provisional`, text ending in `?` after stripping, `useful_question(text)` true, `timestamp` within 120 s of `now`; returns `{"text", "speaker", "at"}` (`at` = its `timestamp`, kept an ISO string in the payload; the page formats it with `localTime`). The function parses `at` to epoch seconds for the 120 s check and for the comparison with the float `analysis_started_at` (F13). None when a journal item of category `INCOMING_QUESTION` or `OPEN_QUESTION` has the same words (`question_quality`-style word match: casefolded `\w+` words of one contain the other's), or when an analysis started after it and has finished (`analysis_started_at > at` and not `busy`).
  - `SPEAKABLE_RULE: str` (Russian, like the rest of the analysis question): every ASK, RISK, OBJECTION and CONTRADICTION starts with one line the user can say aloud as it stands, about eight words, readable in two seconds; reasoning, quote and source go on the next lines. For a QUESTION_CAPTURE with `direction` `incoming`, add `"reply"`: one such line the user can answer with now, from the call, the memo or the sources only; no `reply` when nothing supports one.
- Produces (`server.py`):
  - `analysis_question` appends `SPEAKABLE_RULE` once and extends the QUESTION_CAPTURE example with `"reply":"..."`.
  - `MeetingJournal.add(..., reply: str = "")` stores `reply` (stripped, cut at 200 chars) when non-empty; `capture_questions` passes `question.get("reply")` for `incoming` only.
  - `CodexSession.should_analyze(transcript, force, urgent: bool = False)`: with `urgent` the minimum gap is 15 s instead of 90 (300 after an error stays 300).
  - `/api/analyze` reads `urgent = payload.get("urgent") is True`.
  - Accepted gap (F18): `should_analyze` stamps `last_analyzed_at` before `busy` goes true, so one poll may show no heard question between them; the next poll shows the wait state or the answer. No fix.
  - `/api/state` adds `"heard_question": heard_question(transcript["segments"], journal, analysis_started_at=COPILOT.last_analyzed_at, busy=COPILOT.busy, now=time.time())`, reusing the journal list it already builds.
- Produces (`permissions.py`): `SETTINGS[("posix", "sound_output")] = "x-apple.systempreferences:com.apple.Sound-Settings.extension"`, `SETTINGS[("nt", "sound_output")] = "ms-settings:sound"`.
- Produces (`app.js`): `analyze(force, urgent = false)` posts `{force, urgent}`; `state()` passes `urgent = Boolean(data.heard_question)`.

- [ ] **Step 1: Write the failing tests** (`test_call_feed.py`, segment timestamps as ISO, `now` fixed):
  - `test_heard_question_is_newest_other_side_question`: segments system "Anna Petrova" "What budget is set for the pilot this year?" at now-5 s and an older one → the newer, with `speaker` and `at`.
  - `test_own_provisional_and_noise_are_not_heard`: the same text from `source: "microphone"`, a `provisional` one, "Can you hear me?" → None each.
  - `test_captured_question_is_not_heard`: a journal `INCOMING_QUESTION` with the same words → None.
  - `test_heard_question_ends`: age 121 s → None; `analysis_started_at` after it and `busy=False` → None; the same with `busy=True` → returned.
  - `test_capture_keeps_reply`: `MeetingJournal.capture_questions` with `QUESTION_CAPTURE: {"kind":"substantive","direction":"incoming","evidence":"...","reply":"The pilot budget is set in January."}` (segment by `speaker_id` `remote-1`, as `test_call_board.py:15`) → the item has that `reply`; a 300-char reply is cut to 200; a `general` capture keeps no `reply`.
  - `test_analysis_question_has_rule`: with `server.JOURNAL`, `server.FACT_CHECKS`, `server.PLANS` patched to empty fakes, `analysis_question(snap, "")[0]` contains `SPEAKABLE_RULE` and `"reply"`.
  - `test_urgent_analysis_gap`: `CodexSession(None)` with `server.time.time` patched: first `should_analyze` True; +20 s non-urgent False; +20 s urgent True (new transcript text each time); +10 s urgent False.
  - `test_sound_output_settings`: `open_settings("sound_output", "posix", opener=calls.append)` and `"nt"` give the two URLs.
- [ ] **Step 2: Run** `python3.14 -m unittest copilot/web/test_call_feed.py`, expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and the whole suite, expect PASS.
- [ ] **Step 5: Commit** `MEETONTRACK-162: heard question, replies and short hint lines from the analysis`.

### Task 5: Call fixtures and the pure functions of `call.js`

**Files:**
- Create: `copilot/web/call.js`, `scripts/call-fixtures.cjs`, `scripts/test-call-ui.cjs`
- Modify: `copilot/web/index.html` (`<script src="/call.js" defer>` after `/home.js`, before `/shell.js`), `copilot/web/server.py` (static route for `/call.js`, as plan 1 did for `/home.js`), `copilot/web/test_home_api.py::StaticFilesTests` (add `/call.js`)

**Interfaces:**
- Produces (`call.js`, globals):
  - `HINT_FRESH_MS = 30000`, `OWN_FRESH_MS = 60000`.
  - `speakable(text: string) -> string`: the part before the first `\n` or `(Основание|Источник|Evidence|Source):` (the split of `app.js:2363`), trimmed; 12 words or fewer returns it; else cut at the first clause mark (`", "`, `"; "`, `": "`, `" - "`, `" — "`, `" – "`; the dashes because Russian model output uses them, F15) when that leaves 3 or more words, keeping a final `?` of the original; else the first 12 words plus `…`.
  - `hintCandidates(state) -> Hint[]` where `Hint = {kind: "own"|"answer"|"check"|"signal"|"memo", tier: number, at: number|null, label: string, question: string, text: string, source: string, detail: string[]}`:
    - `own` (tier 0): the last assistant message of `state.copilot.messages` whose previous message is the user's; `question` is that user text, `text` the full answer, `at` its `at`.
    - `answer` (tier 1): journal `INCOMING_QUESTION` with a `reply`, status not `resolved`; `question` = its text, `text = speakable(reply)`, label `call.asks` with its `speaker`.
    - `check` (tier 2): journal `CONTRADICTION`, and `fact_checks.items` with status `refuted` (`text = speakable(item.fact)`, `source` = speaker and the quoted claim, `at` = `checked_at`).
    - `signal` (tier 3): journal `ASK`, `RISK`, `OBJECTION`, status not `resolved`.
    - `memo` (tier 4, `at: null`): the first `call_plan.items` entry of kind `question` whose status is not `resolved`; `source` = `call.from_memo` with its 1-based number among question items; `detail` = `[call_plan.source_label]`.
    - For journal items: `text = speakable(item.text)`, `source` = first non-empty line after the hint line, else `item.evidence`; `detail` = remaining lines, `item.evidence`, `item.speaker`. `at` = `created_at`.
    - Labels: `call.ask` when `text` ends in `?`, `call.say` otherwise, `call.clarify` for `check`, `call.own` for `own`; each event label carries ` · HH:MM` of `at` (`call.at`).
  - `pickHint(state, now) -> {current: Hint|null, earlier: Hint[]}`: fresh = `own` within `OWN_FRESH_MS`, other events within `HINT_FRESH_MS`; `current` = the fresh one with the lowest `tier`, newest first among equals; else the `memo` candidate; else null. `earlier` = every event candidate except `current` (no `memo`), newest first, at most 20.
  - `heartbeat(state, now) -> {you: Mark, other: Mark}`, `Mark = {state: "heard"|"not_heard"|"checking"|"unknown", since: number|null, speaking: boolean}`. Track `mic` is You, `system` is the other side (`recording_health.capture.tracks[]`). `stalled` → `not_heard`, `since = now - last_growth_age_seconds*1000` (null when that is null); for the other side an open `state.transcript.capture_warnings[]` entry (they live on the transcript, `server.py:1273`, not in `recording_health`; fixtures put them there, F14) with `reason: "system-audio-lost"` and no `ended_at` also gives `not_heard`, `since` = its `started_at`; `recording` → `heard`; `verifying` → `checking`. No track for that side → `heard` when a segment of that source (`microphone` / `system`) is newer than 120 s, else `unknown`. `speaking` = a segment of that source newer than 10 s.
  - `callClock(startIso: string, now: number) -> string`: `MM:SS` under an hour, `H:MM:SS` above; start = `recording_health.capture.started_at || transcript.started_at`.
  - `lastPhrase(state) -> string`: text of the last segment (provisional included), the last 90 chars with a leading `…` when longer; `""` with no segments.
- Produces (`scripts/call-fixtures.cjs`): `states` (name → `{state, agenda, permissions}`, times relative to now, data in EN and RU like `home-fixtures.cjs` `TEXT`), `open(browser, {fixture, width, scheme, lang, data, at}) -> page` (reuses `route` from `home-fixtures.cjs`; `page.api`, `page.errors` as there). Fixtures: `hint`, `answer`, `heard`, `memo_question`, `waiting`, `paused_ai`, `other_lost`, `you_lost`, `own_pending`, `own_answer`, `earlier_open`, `stopped`, `stopped_final`, `more_open`, `transcript_open`, `board_open`, `long_hint`, `windows_no_tracks`, `silent_partner`. Capture fixtures mirror `recording_health.py:169-174`: any stalled track makes `capture.state` `"stalled"` and `audio_recording` false (F19). `stopped` carries `recording_control.stopping` with `until` 20 s ahead; `stopped_final` carries `recording_control.last_stop` for `m1` with `stopping: null` while the call is still live (F1). All live: `transcript.live: true`, `status: "recording"`, `meeting_id: "m1"`, title "Pilot review" / "Обзор пилота", other side "Anna Petrova" / "Анна Петрова" of "Example LLC" / "ООО Пример".

- [ ] **Step 1: Write the failing tests** (`test-call-ui.cjs`, functions through `page.evaluate` on the `hint` page):
  - `speakable`: a 20-word Russian line whose first clause ends at " — " is cut there and shows no em-dash; an 8-word question unchanged; the 20-word "Why is the proposal 1,1 million, if your own estimate is 3,4 million and the contractor costs 700 thousand?" gives "Why is the proposal 1,1 million?"; a 20-word line with no clause mark gives 12 words plus `…`; "Ask who signs.\nОснование: ..." gives "Ask who signs."
  - `pickHint`: a RISK 5 s old, a refuted fact 10 s old, an INCOMING_QUESTION with `reply` 20 s old → `answer`; with the reply 31 s old → `check`; all older than 30 s, plan question 1 resolved and question 2 open → `memo` with source "From the memo, question 2" and `earlier` holding the three events newest first; an own answer 50 s old beats everything; the label of an ASK ending in `?` matches `/^Ask · \d\d:\d\d$/`, of a RISK statement `/^Say · /`.
  - `heartbeat`: both tracks `recording` and a microphone segment 3 s old → you `heard` speaking, other `heard` not speaking; system `stalled` with `last_growth_age_seconds: 40` → other `not_heard`, `since` 40 s ago; an open `system-audio-lost` warning → `not_heard` from its `started_at`; `windows_no_tracks` (`tracks: []`) with a system segment 30 s old → `heard`, and with none → `unknown`, never `not_heard`; `silent_partner` (system track `recording`, no system segment for 5 min) → `heard`, not speaking.
  - `callClock`: 760 s → `12:40`; 3725 s → `1:02:05`. `lastPhrase`: 200-char segment → 91 chars starting with `…`.
- [ ] **Step 2: Run** `node scripts/test-call-ui.cjs`, expect FAIL (`speakable is not defined`).
- [ ] **Step 3: Implement** the functions and the fixtures; `call.js` defines `renderCall(state)` as an empty stub.
- [ ] **Step 4: Run** it, the Python suite and `scripts/test-shell-ui.cjs`, expect PASS.
- [ ] **Step 5: Commit** `MEETONTRACK-162: hint selection, heartbeat and call fixtures`.

### Task 6: The feed, the dock and panels on demand

**Files:**
- Modify: `copilot/web/index.html` (`<section id="call" class="call" aria-labelledby="call-name" hidden>` after `#home`; `<button id="call-back" class="ql" type="button" hidden>` first inside `.workspace`), `copilot/web/call.js`, `copilot/web/shell.js` (`renderShell` :238-252), `copilot/web/screens.css`, `copilot/web/app.js` (translations; `window.callAsk = ask`; `ask()` :3367 returns a boolean, F4), `scripts/call-fixtures.cjs`, `scripts/test-call-ui.cjs`, existing checks that use the live board or transcript (`scripts/test-call-overview-ui.cjs`, `scripts/test-fact-check-ui.cjs`, `scripts/test-preferences-ui.cjs`, `scripts/test-library-ui.cjs`)

**Interfaces:**
- DOM in `#call`: `.feed > .col` holding `h2#call-name.call-name`, `#call-problem`, `#call-slot` (`aria-live="polite"`), `p#call-note.feed-note`, `section#call-earlier` (hidden, list of past hints); `.dock > .col` holding `.dock-row` (`#call-earlier-open` with `aria-expanded` and `aria-controls="call-earlier"`, spacer, `#call-transcript-open`, `#call-board-open`) and `form#call-ask.ask` (`.ask-field` with `input#call-question` (`maxlength="8000"`, `autocomplete="off"`, placeholder and label from `call.ask_placeholder` / `call.ask_label`) and `<kbd>/</kbd>`, `button#call-send` (type submit, `call.send`, `<kbd>↵</kbd>`), `button#call-more.ask-more` (`aria-expanded`, `aria-controls="call-more-menu"`, hidden until Task 8), `div#call-more-menu.menu` (`role="menu"`, hidden)).
- Produces (`call.js`):
  - `renderCall(state)`: `#call-name` = `transcript.display_meeting || transcript.meeting`. `#call-problem` holds one `.problem` block when `heartbeat` has a side `not_heard`, the other side first: heading `.fail` `call.other_lost` / `call.you_lost` with the `since` time (`localTime`), text `call.other_lost_text` / `call.you_lost_text`, `.actions` with primary `action.sound_output` (POST `/api/permissions/open {which: "sound_output"}`) or `action.open_mic` (`{which: "microphone"}`), then `.ql` `action.how_to_fix`, which calls `openGuideStep("startup-audio-heading", "startup-recorder")` exactly as the bar's How to fix does (`shell.js:307`), so How to fix has one target everywhere (F17). `#call-slot` by `pickHint(state, Date.now())` and the pending own question:
    - pending own question (set by submit, cleared once an `own` candidate is newer than it): `.say` `call.own`, `.heard-q` the question, `.heard-wait` `call.heard_wait`.
    - `current.kind === "own"`: `.say` label, `.heard-q` question, `.own-answer` (18 px, at most 6 lines by `line-clamp`), `.ql` `call.open_chat` → `openCallPanel("chat")`.
    - `current.kind === "answer"`: `.say` label (`{name} asks · HH:MM`), `.heard-q` the question in regular weight, `.hint` the reply.
    - `state.heard_question` and no `answer`/`own` current: `.say` `call.asks` with its speaker and time, `.heard-q`, `.heard-wait` `call.heard_wait`.
    - any other `current`: `.say` label, `.hint` text, `.why` source (one line, ellipsis), `.why-acts` with `button.ql` `call.where` (`aria-expanded`, toggles `.why-more` holding `detail`, label `call.where_hide` when open). The open state is kept per hint key across polls.
    - none: `.waiting` (`call.waiting_heard` when either side is `heard`, else `call.waiting`) and `.heard-wait` `call.waiting_help`.
    - `#call-note` (hidden otherwise): `copilot.analysis.state === "error"` gives `call.paused` with the time of `analysis.at` + 300 s, plus `.ql` `call.check_ai` (clicks `#getting-started-open`). `home.check_ai` does not exist; use the new key (F3).
    - `#call-earlier-open` text `call.earlier` with `earlier.length`; a click toggles `#call-earlier` (and its `aria-expanded`) inside the feed, under the slot; `#call-earlier` lists them (`.say`, hint text at body size, `.why`), `call.earlier_empty` when none.
    - Re-renders only when its signature (language, slot, problem, note, earlier, panel) changes, so focus and the open source line survive the poll.
  - `openCallPanel(panel: "transcript" | "board" | "chat" | "notes" | null)`: sets `document.body.dataset.callPanel` (deleted for null), clicks the matching `[data-content-view]` tab for `board`, `chat`, `notes`, shows `#call-back`, moves focus to the panel heading; null returns focus to the control that opened it. Escape (outside the menu and dialogs) and `#call-back` close it.
  - `ask(question)` in `app.js:3367` returns `true` when it sent the question and `false` when it returned early (empty text or `requestBusy`, which an auto-analysis holds during the whole `/api/analyze` call) (F4).
  - Submit of `#call-ask`: empty text does nothing; else calls `window.callAsk(text)` and, only when it returns `true`, stores the pending question and clears the field; on `false` the text stays in the field and no pending state shows (F4).
- Produces (`shell.js`): `renderShell` sets `$("call").hidden = view !== "call" || Boolean(document.body.dataset.callPanel)`, calls `renderCall(window.appState)` in the Call view, and deletes `dataset.callPanel` in any other view. `#menu-notes` calls `openCallPanel("notes")` in the Call view.
- CSS (`screens.css`): `body[data-view="call"] .workspace { display: none }` unless `body[data-call-panel]`; with `transcript` only `.transcript-pane` shows, with `board`/`chat`/`notes` only `.copilot-pane`, full width under the bar; `body[data-view="call"]:not([data-call-panel="notes"]):not([data-call-panel="chat"]) .composer-wrap { display: none }` (the dock is the one ask field over the feed; the Notes and Chat panels keep their composer, so a note can be saved and a follow-up asked there, F5); the `transcript` panel rule shows `.transcript-pane` even under `.workspace.transcript-hidden` (`styles.css:461`), so the `transcript_hidden` preference never leaves the panel empty (F12); feed and dock CSS ported from the mockup classes listed in the header, the hint at `font-size: 24px` (22 px under 600 px).
- i18n keys (RU / EN): `call.ask` "Спросите" / "Ask"; `call.say` "Скажите" / "Say"; `call.clarify` "Уточните" / "Clarify"; `call.asks` "{name} спрашивает" / "{name} asks"; `call.asks_plain` "Собеседник спрашивает" / "The other side asks"; `call.own` "Ответ на ваш вопрос" / "Answer to your question"; `call.at` "{label} · {time}"; `call.from_memo` "Из мемо, вопрос {n}" / "From the memo, question {n}"; `call.where` "Откуда подсказка" / "Where this comes from"; `call.where_hide` "Свернуть" / "Hide"; `call.heard_wait` "Ответ готовится, обычно несколько секунд. Появится здесь же." / "The answer is being prepared, usually a few seconds. It will appear here."; `call.waiting_heard` "Разговор слышно. Подсказка появится здесь, когда будет что сказать или спросить." / "The conversation is heard. A hint appears here when there is something to say or ask."; `call.waiting` "Запись идет. Подсказка появится здесь, когда будет что сказать или спросить." / "Recording. A hint appears here when there is something to say or ask."; `call.waiting_help` "Свой вопрос можно задать внизу. Весь разговор текстом в «Расшифровке», вопросы и риски на «Доске»." / "You can ask your own question below. The whole conversation is in Transcript, questions and risks are on the Board."; `call.paused` "Подсказки на паузе: ИИ не ответил. Запись идет, следующая попытка в {time}." / "Hints paused: the AI did not answer. Recording continues, next try at {time}."; `call.other_lost` "Собеседника не слышно с {time}" / "The other side is not heard since {time}"; `call.other_lost_text` "Вас слышно. Подсказки по словам собеседника вернутся, когда звук появится." / "You are heard. Hints on what the other side says come back once their sound does."; `call.you_lost` "Вас не слышно с {time}" / "You are not heard since {time}"; `call.you_lost_text` "Собеседника слышно. Ваши слова не попадут в расшифровку, пока микрофон не вернется." / "The other side is heard. Your words are not transcribed until the microphone is back."; `action.sound_output` "Выбрать, откуда слушать звонок" / "Choose where to listen to the call from"; `call.earlier` "Прошлые подсказки ({n})" / "Earlier hints ({n})"; `call.earlier_empty` "Прошлых подсказок пока нет." / "No earlier hints yet."; `call.transcript` "Расшифровка" / "Transcript"; `call.board` "Доска" / "Board"; `call.ask_placeholder` "Спросить про звонок" / "Ask about this call"; `call.ask_label` "Вопрос про этот звонок" / "A question about this call"; `call.send` "Спросить" / "Ask"; `call.open_chat` "Открыть в чате" / "Open in chat"; `call.back` "Вернуться к звонку" / "Back to the call"; `call.check_ai` "Проверить ИИ в настройках" / "Check the AI in settings" (F3).

- [ ] **Step 1: Write the failing tests** (`test-call-ui.cjs`). Generic checks on every fixture at 1440 and 400 px, light and dark, RU and EN: no horizontal scroll; no `[ёЁ]` in RU text, no `—` and no `!` in the visible text of `#call` and `.topbar`; no `pageerror`; no element in `#call` with text matching `/Пропустить|Skip|Не записывать|Do not record/`; `.hint`, when present, has a computed `font-size` of 22-24 px and is the largest font of any visible element in `#call`. Per-fixture interaction checks run at 1440 px only (under 700 px the dock buttons are hidden by Task 8, which repeats the open checks there through More, F2): `hint` (label `/Ask · \d\d:\d\d|Спросите · \d\d:\d\d/`, `.why` is one line, `call.where` toggles `.why-more` and survives the next poll open); `answer` (label names Anna Petrova, `.heard-q` `font-weight` 400, `.hint` is the reply); `heard` (`.heard-q` question, wait text `/обычно несколько секунд|usually a few seconds/`); `memo_question` (source "From the memo, question 2"); `waiting` (waiting and help text, no `.hint`); `paused_ai` (`#call-note` text has `\d\d:\d\d`, its link reads `call.check_ai` and opens `#getting-started`); `other_lost` (heading has the since time, primary button posts `/api/permissions/open {which: "sound_output"}`, How to fix opens `#getting-started` on the audio step, `#startup-audio-heading` in view); `you_lost` (posts `{which: "microphone"}`); `own_pending` (typing in `#call-question` and Enter posts `/api/chat {question}`, field empties, slot shows the question and the wait text; with `requestBusy` held by a pending `/api/analyze` the text stays in the field, nothing is posted and no wait text shows, F4); `notes` and `chat` panels show `#question` and `#note-button`, the other panels and the feed do not (F5); `transcript_open` with the `transcript_hidden` preference still shows `.transcript-pane` (F12); `own_answer` (answer text and Open in chat opens the chat panel); `earlier_open` (button text count equals list length); `transcript_open` / `board_open` (`#call-transcript-open` / `#call-board-open` click shows `.transcript-pane` / `#call-board`, `#call` is hidden, Escape returns to the feed with focus on the opener, `#call-back` does the same).
- [ ] **Step 2: Run** `node scripts/test-call-ui.cjs`, expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update the existing checks**: run every `scripts/*.cjs`; a check that fails because `.workspace` is hidden during a live call gets one `await page.evaluate(() => openCallPanel('board'))` (or `'transcript'`) before it uses the pane, nothing else. Run all scripts and the Python suite, expect PASS.
- [ ] **Step 5: Commit** `MEETONTRACK-162: Call feed with one hint, dock and panels on demand`.

### Task 7: The top bar during a call: heartbeat, Stop recording, stopped state

**Files:**
- Modify: `copilot/web/index.html` (inside `#call-status`, after `#call-status-text`: `<span class="call-live" id="call-live" hidden>` holding `span.timer#call-timer`, `span.beats#call-beats`, `span.heard-line#call-heard`; in `.tools` before `#menu-button`: `<button id="call-stop" type="button" hidden>` with `span.lbl-l`, `span.lbl-s`), `copilot/web/shell.js` (`callStatus` :58, `STATUS_POSTS` :93, `renderStatus` :134, `shortcuts` :185, the keydown handler :196), `copilot/web/call.js`, `copilot/web/screens.css`, `copilot/web/app.js` (translations), `scripts/call-fixtures.cjs`, `scripts/test-call-ui.cjs`, `scripts/test-shell-ui.cjs`

**Interfaces:**
- Produces (`shell.js`):
  - `callStatus` gains a first rule: `stopping = state.recording_control?.stopping` with `stopping.meeting_id === state.transcript?.meeting_id` → `{kind: "stopped", text: t("status.stopped", {time, n}), action: {id: "resume", label: t("action.resume"), primary: false}}` where `time` is `stopped_at` as HH:MM and `n = max(0, ceil((until - now) / 1000))`. Second rule (F1): `stopping` null, `isLive(state)` and `recording_control.last_stop.meeting_id === transcript.meeting_id` → `{kind: "stopped", text: t("status.stopped_final", {time}), action: null}`. The server never sends `stopping.until: null`; an immediate stop (recorder without pause) and the seconds between the deferred `record stop` and the recorder going inactive both reach the page as `last_stop`.
  - Live call and a single stalled track (F19): `notRecordingReason` counts `stalled` as not recording only when every entry of `capture.tracks` is `stalled`; one stalled side gives `recording` in the bar and is shown by its beat and the feed problem (one source of truth: the tracks). `renderStatus` treats `stopped` like `waiting` for colour (not `.fail`, not `.rec`).
  - `STATUS_POSTS.resume = ["/api/recording/resume", {}]`.
  - `#call-stop`: shown while `isLive(state)` and kind is not `stopped`; label `action.stop` (`.lbl-l`) and `action.stop_short` (`.lbl-s`, shown under 700 px), `<kbd>` `STOP_KEY` (`⌘⇧E` on Mac, `Alt+Shift+E` elsewhere). Click posts `/api/recording/stop {meeting_id: window.appState.transcript.meeting_id}` through the same busy-key and `statusError` path as `statusAction`, then `state()`. No dialog.
  - Server error codes are mapped before `statusError` is set (F6): `meeting_changed`, `too_late`, `stop_failed`, `resume_failed` become `status.error.<code>`; any other error goes through `plainError` as today.
  - `shortcuts` gains: Stop (`KeyE` with Shift and Meta on Mac or Alt elsewhere, `preventDefault` like the record key, control `#call-stop` when visible); `/` (matches `event.key === "/"` with Shift allowed, since several layouts need Shift for it; no Meta, Ctrl or Alt; control `#call-question` when `#call` is visible; it is focused, not clicked, with `preventDefault` so the `/` is not typed, F20). Both listed in `#menu-shortcuts` with `action.stop` and `call.ask_label`. The existing field filter keeps `/` typed inside any input.
- Produces (`call.js`): `renderCallBar(state, now)`: `#call-live` shown while live and not stopped; `#call-timer` `callClock`; `#call-beats` two `.beat` (`call.you` / `call.other`, then `<b>` `call.heard` / `call.not_heard` / `call.checking`, or no word for `unknown`), class `lost` for `not_heard`, bars `aria-hidden`, bars still when not `speaking` (class `quiet`); `#call-heard` `call.last_phrase` with `lastPhrase`, hidden when empty. `renderShell` calls `renderCallBar(window.appState, Date.now())` on every render, and it hides `#call-live` when not live (F16). A 1 s interval updates `#call-timer` and, while stopped, calls `renderShell()` for the countdown.
- i18n keys (RU / EN): `call.you` "Вы" / "You"; `call.other` "Собеседник" / "Other side"; `call.heard` "слышно" / "heard"; `call.not_heard` "не слышно" / "not heard"; `call.checking` "проверяю" / "checking"; `call.last_phrase` "Расшифровка: {text}" / "Transcript: {text}"; `action.stop` "Остановить запись" / "Stop recording"; `action.stop_short` "Остановить" / "Stop"; `action.resume` "Продолжить запись" / "Resume recording"; `status.stopped` "Запись остановлена в {time}. Через {n} с откроется отчет." / "Recording stopped at {time}. The report opens in {n} s."; `status.stopped_final` "Запись остановлена в {time}." / "Recording stopped at {time}."; `status.error.meeting_changed` "Звонок уже сменился, обновите страницу" / "The call has changed, reload the page"; `status.error.too_late` "Запись уже остановлена" / "The recording has already stopped"; `status.error.stop_failed` "Запись не остановилась, откройте программу записи" / "The recording did not stop, open the recorder"; `status.error.resume_failed` "Запись не продолжилась, откройте программу записи" / "The recording did not resume, open the recorder" (F6)

- [ ] **Step 1: Write the failing tests.** `test-shell-ui.cjs` `callStatus` table: stopping for `m1` with `until` 20 s ahead → `stopped`, text has the HH:MM and `20`, action `resume`; `stopping` null with `last_stop` for `m1` while `m1` is live → `stopped` with the `status.stopped_final` text and no action; `last_stop` for `m0` → `recording`; stopping for `m0` while `m1` is live → `recording`; live with one of two tracks `stalled` (`capture.state: "stalled"`) → `recording`, both stalled → `not_recording` (F19). `test-call-ui.cjs`: `hint` fixture: `#call-status-text` is "Запись" / "Recording" with `.rec`, `#call-timer` matches `/^\d\d:\d\d$/` and changes after `page.clock.runFor(1100)`, beats read "You: heard" and "Other side: heard"; `other_lost` beat reads "Other side: not heard" with class `lost`; `#call-heard` is one line and starts with "Transcript:"; `#call-stop` comes after `#call-status` and right before `#menu-button` in DOM order, its click posts `/api/recording/stop {meeting_id: "m1"}` and `dialog[open]` count stays 0; `Meta+Shift+E` (`Alt+Shift+E` off Mac) posts the same; `/` on the body focuses `#call-question` with an empty value, `/` typed in `#call-question` stays in it; at 1440 px `#call-stop` shows its `<kbd>`, at 1024 px not. `stopped`: bar matches `/Recording stopped at \d\d:\d\d\. The report opens in \d+ s\./`, the number falls after `runFor(2000)`, Resume posts `/api/recording/resume`, `#call-stop` and `#call-live` hidden. `stopped_final` (built from `last_stop`): bar reads "Recording stopped at HH:MM.", no Resume, `#call-stop` hidden. Resume answered 409 `too_late` shows "The recording has already stopped", never the raw code (F6). `hint` with Shift+`/` (a layout needing Shift) also focuses `#call-question` (F20). `windows_no_tracks` with no segments: beats show no "not heard".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (bar CSS from the mockup `.recline`, `.timer`, `.beats`, `.beat`, `.bars`, `.beat.lost`, `.heard-line`; bars animate only when `speaking`, and not under `prefers-reduced-motion`).
- [ ] **Step 4: Run** all scripts and the Python suite, expect PASS.
- [ ] **Step 5: Commit** `MEETONTRACK-162: heartbeat, Stop recording and the stopped state in the top bar`.

### Task 8: Narrow window and More

**Files:**
- Modify: `copilot/web/call.js`, `copilot/web/screens.css`, `copilot/web/index.html` (`#call-more-menu` items), `copilot/web/shell.js` (`toggleMenu` :262 and the menu key handler :273-286), `scripts/test-call-ui.cjs`

**Interfaces:**
- Under 700 px: `.dock-row` hidden, `#call-more` shown; `#call-more-menu` (`role="menu"`) holds `menuitem`s Earlier (with its count), Transcript (small `call.transcript_note` "весь разговор текстом" / "the whole conversation as text"), Board (small `call.board_note` "вопросы, риски и проверка фактов" / "questions, risks and fact checks"), Stop recording (clicks `#call-stop`, hidden when it is). Opens on its first item, arrows move, Escape or a click outside closes it and focus returns to `#call-more` through `toggleMenu(menu, button, open)`: `shell.js` generalises `toggleMenu` and its key handler (Escape, Tab, arrows, click outside) to take the menu and its button, and `#app-menu` / `#menu-button` keep their behaviour unchanged (F11).
- `.call-name` stays one line with an ellipsis at every width (critique P3).
- At 480-600 px: `#call-live` takes its own row under the record line, beats keep their words, `#call-heard` stays one line; the hint wraps and stays the largest text.

- [ ] **Step 1: Write the failing tests:** at 400 and 520 px for `hint`, `heard`, `other_lost`, `stopped`: `.dock-row` hidden and `#call-more` visible; `.call-name` visible with `clientHeight` of one line; the `.hint` (or `.heard-q`) box is inside the viewport at 900 px height without scrolling; `#call-stop` shows the short label. The open checks of Task 6 repeat here at 400 px through `#call-more`: Earlier shows `#call-earlier`, Transcript and Board open their panels, Escape returns to the feed (F2). `more_open` at 400 px: four items in order, Earlier shows the count, Board opens the board panel, Escape closes the menu with focus on `#call-more`, the menu fits the viewport.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run** all scripts, expect PASS.
- [ ] **Step 5: Commit** `MEETONTRACK-162: Call view in a narrow window`.

### Task 9: Render for critique

**Files:**
- Create: `scripts/render-call-critique.cjs`

**Interfaces:**
- Consumes: `states`, `open` from `scripts/call-fixtures.cjs`.
- Produces: `node scripts/render-call-critique.cjs <out-dir>` writes `<state>-<width>-<scheme>-<lang>.png` for the fixtures `hint`, `answer`, `heard`, `memo_question`, `waiting`, `paused_ai`, `other_lost`, `you_lost`, `own_answer`, `earlier_open`, `stopped`, `stopped_final`, `more_open`, `transcript_open`, `board_open`, `long_hint` at 1440, 1024 and 400 px, light and dark, RU and EN (fixture data in the page's language), full page, plus `index.html` and `manifest.json`, the shape of `scripts/render-home-critique.cjs`. Opened states are opened before each shot: `earlier_open`, `transcript_open`, `board_open` through the dock buttons above 700 px and through `#call-more` at 400 px; `more_open` is rendered at 400 px only (More does not show above 700 px), so it gives 4 files, not 12 (F2). Exits 1 on a page error or a horizontal scroll. It does not run the critique.

- [ ] **Step 1:** Run it into a scratch dir; expect 184 PNG files (15 fixtures x 12 plus `more_open` x 4; `stopped_final` added in the fix wave, F1) and a manifest of 184 entries, exit 0. The audio bars are still during shots (reduced motion); a page that fails to load is a manifest entry with `failed`, and the run exits 1 at the end (fix wave F2, F3).
- [ ] **Step 2: Commit** `MEETONTRACK-162: render the Call view for critique`.
- [ ] **Step 3:** The orchestrator hands `index.html` of that run to an independent Impeccable critique; the view passes at 30/40 or more with no P0 or P1. Findings go back as fix tasks against this plan.

---

## Decisions and spec conflicts resolved here

- **Resume after Stop.** The contract said resume wraps `record resume`, which only restarts recognition of a running recording. Stop now pauses at once and stops for good after the undo window (Task 1 edits the contract). Audio after Stop is never captured.
- **Undo window 30 s, not 10 s.** The spec leaves timings to the builder; critique 8 found 10 s tight mid-conversation.
- **No Skip under the hint.** The mockup has «Пропустить»; the spec says no per-hint triage buttons, and the spec wins.
- **Native change despite "No native recorder changes".** The spec's own Resume cannot exist without a pause verb (`record resume` only restarts recognition), so Task 3 is the minimum; without it Stop still works and the bar says "Recording stopped" from `last_stop` (F1, F9). The summary to the owner names this deviation and the 30 s window.
- **Slot order completed.** The spec's order has no place for the live ASK suggestions or the person's own question: ASK joins risks and objections, and an answer the person asked for comes first for 60 s.
- **The answer to a question put to the user** had no data source: the analysis now adds `reply` to an incoming QUESTION_CAPTURE, and a heard question asks for the next analysis after 15 s instead of 90.

## Deferred

- **Keys ⌘1-3 for Earlier, Transcript and Board** (mockup only): the spec asks key hints on the ask field, Stop and Send; the dock buttons and More cover the rest.
- **Audio level per channel** for a truer heartbeat: the spec puts it under "Later"; it needs the recorders to export levels.
- **Resume recording from the After view while the report has not gone** (critique 8, alternative fix): After is plan 4's; the 30 s window covers the mid-call slip.
- **A faster first hint in general**: only a heard question shortens the 90 s analysis gap; changing the cadence for every call is a cost decision outside this view.

## Rulings made during execution

Copied from the execution ledger on 2026-11-22, before the scratch workspace was deleted. Each ruling reads: what was decided, why, and what it costs if wrong.

- Task 5: review approved (4 Minor); Ruling: resolved CONTRADICTION never takes the hint slot — brief omitted the filter by oversight — cost if wrong: one-word revert. Fix round 1/5 3886b3a; scoped re-review p3-rev5.
- Ruling: hide 'Прошлые подсказки' while the count is 0 — owner bar is a very clean screen and an empty counter is noise; plan text mandated call.earlier_empty — cost if wrong: one-line revert.
- Ruling: stage-visible Minors 2 (past retry time), 5 (truncated hint unreachable), 6 (three names for the transcript panel), 7 (label repeats the verb) and the long_hint 'Скажите' label go into fix round 1 — they show on stage; cheap.
- Ruling: RU countdown uses a non-breaking space between the number and «с» — wrap mid-unit looks broken at 400 px; brief string differs only in whitespace — cost if wrong: none.
- Ruling: #call-live (beats, clock, heard sides) shows only when the bar kind is 'recording' — 'Not recording' beside 'You: heard' with moving bars contradicts itself; narrows the brief's 'live and not stopped' — cost if wrong: one-line revert; F19 single-stalled keeps its beat.
- Ruling: drop Stop from More (#call-more-stop) — duplicates the bar's Stop, adds no reach, and ArrowUp+Enter from the menu stops the recording with no dialog; overrides the brief — cost if wrong: re-add one menu item.
- Ruling: Task 9 (a render script, no product code) is reviewed inside the final whole-branch review instead of its own task review — mechanical, exit 0 with 172/172 and test-call-ui green — cost if wrong: a script defect found at the critique.
- Ruling: one fix wave covers final I1-I5, all Codex findings, critique P1/P2 and two pre-demo minors — list in fix-wave.md — cost if wrong: a large wave; mitigated by a scoped re-review and critique 2.
- Ruling: never cut a hint; show the AI's first line whole (wrap, one smaller type step) — a fragment can't be said aloud — cost if wrong: longer hint lines.
- Ruling: in Call, a panel shows only what it was opened for (Board = four columns, Transcript = one heading); Chat/Notes via Menu; scoped to Call — old UI inside the new screen cost the critique a P1 — cost if wrong: Chat/Notes one click further.
- Ruling: every time in Call is elapsed call time, the top-bar clock — two clocks in one format confused the critic — cost if wrong: clock time lost on hints.
- Ruling: during the undo window and after the final stop the hint slot hides and the feed says the recording is stopped; ask stays — the feed contradicted the bar — cost if wrong: a hint hidden 30 s early.
- Ruling: the ask button reads 'Отправить'/'Send' — 'Спросите' (to the client) beside 'Спросить' (to the AI) confused the critic — cost if wrong: one label.
- Ruling: RU countdown 'Через 20 сек' — 'с' reads as a preposition — cost if wrong: none.
- Ruling: Earlier shows 'Анна Петрова спросила: «…»' with our answer under 'Ответ' — the answer read as hers — cost if wrong: one label.
- Critique 2: 29/40, 1 P1 (critique-call-2.md). Ruling: one clock per job in Call (bar elapsed, feed ages, loss as duration, transcript elapsed) — three clocks cost the P1 twice — cost if wrong: clock time lost in Call. Ruling: stopped_final gets one button to the existing meeting results view, no plan-4 work — dead end flagged — cost if wrong: one link. Section G sent to p3-fixwave.
- Critique 3: 29/40, 1 P1 (critique-call-3.md). Ruling: stopping bar 'Запись остановлена. Продолжить можно еще N сек', feed 'Запись остановлена.' — P1 read as still recording — cost if wrong: copy only. Ruling: hint labels are verbs (Спросите/Скажите/Ответьте), own-question reply 'Ответ на ваш вопрос' — mixed labels — cost if wrong: labels. Ruling: hint and answer share a clamp() size up to ~36px — stage readability — cost if wrong: one token. Section H sent to p3-fixwave.
- Ruling: keep B1 (a hint is never cut) against the spec's 'first clause' — critique 1 scored a clause-cut fragment as unspeakable P1, critique 3 scores a whole long hint as P2; the P2 is cheaper on stage — cost if wrong: a long hint takes two lines.
- Critique 4: 30/40 but 1 P1 (board at 400 shows 2 of 4 columns). Ruling: current hint never older than Earlier; slot priority only within the latest analysis — feed read inverted — cost if wrong: an older answer drops to Earlier sooner. Sections K+L sent.
- Codex 2: 1 P1 (Windows session check outside the semaphore), 3 P2, 2 P3 -> section M. Ruling: on 'unknown verb' from an old recorder, retry the bare verb once — upgrade window — cost if wrong: an old recorder acts unscoped (pre-change behaviour).
- Critique 5: 30/40, 1 P1 (no single source component). Ruling: one 'Откуда это' disclosure on every slot item, unsourced items say 'Без источника - проверьте, прежде чем обещать' — cost if wrong: one muted line. Ruling: stopping has one countdown in the feed; bar shows frozen timer + Resume in Stop's place. Section N sent.
- Ruling: Earlier list items keep their inline source line (N1 covers the current-hint slot only) — Earlier is a compact read-back list, a disclosure per item adds clicks — cost if wrong: add the disclosure to Earlier items. Flaky: test-home-ui failed once under the parallel run, not reproduced in 4 solo runs — watch.
- Critique 6: 31/40, 0 P0/P1 — Call view PASSES the gate. Ruling: three cheap P2s (O1-O3) before merge; the rest of critique 6 P2/P3 deferred — cost if wrong: polish later.
- Codex final3: 1 P1 (Stop shortcut/double-click can resume), 5 P2, 1 P3 -> section P. Ruling: drop the M2 bare-verb retry; an old recorder gets 'Обновите программу записи' and the stop stays pending — Codex P2 showed the retry can hit a new call — cost if wrong: mixed-version installs can't stop from the page until the recorder updates.
