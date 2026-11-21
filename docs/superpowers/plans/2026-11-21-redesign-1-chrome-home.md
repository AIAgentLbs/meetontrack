# Redesign 1: app chrome and Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the toolbar of the web UI with a top bar (Home, Past calls, one call status with one control, Menu) and open the app on a Home view that answers "what is my next call and what do I need to know", while the existing transcript and board stay usable as the Call and After views.

**Architecture:** Three new front-end files (`shell.js`, `home.js`, `screens.css`) render on top of the existing `/api/state` poll and the 60 s `/api/agenda` poll in `app.js`. `body[data-view]` (`home`, `call`, `after`) picks what is visible; `call` and `after` show today's `.workspace` unchanged. The server gains `GET /api/permissions`, `POST /api/permissions/open`, `POST /api/agenda/skip-recording` and three agenda fields, all in new small modules so plan 2 (memo writer, editing `call_plan.py`) does not collide. Native changes are one window size, one `permissions` CLI subcommand on macOS, and the "do not record" honour on both recorders (may slip).

**Tech Stack:** plain JS (no build), CSS, Python 3 stdlib (`http.server`, `winreg`), Playwright `.cjs` checks run with `node`, Swift (ArgumentParser, XCTest), C# (.NET, xUnit).

**Spec:** `docs/superpowers/specs/2026-11-20-call-flow-redesign-design.md` (sections Home, App chrome, eighth-critique Home lines). **Contract (binding):** `docs/superpowers/plans/2026-11-21-redesign-contract.md`. **Look:** `/Users/m/Documents/ai-jam-2026-11-26/mockup/screens.html` `#s1`, outside the repo; port its CSS, never its text or data.

## Global Constraints

- Every rule in the contract's "Global rules" applies: invented generic fixture data only ("Anna Petrova", "Example LLC", "Pilot review"); no provider or model in code; one settings store; every string in `translations.ru` and `translations.en` (in `app.js`); no inline styles or scripts (CSP in `server.py:2903-2907`); no confirmation dialog; no new dependency.
- UI strings: no em-dash, no "ё", no exclamation marks. RU wording from the mockup; EN in the same plain register.
- One quiet text-link style (`.ql`: text colour, underline in `--line-strong`). Accent colour only for the recording dot, primary buttons and status marks.
- Key labels (`<kbd>`) on secondary controls are hidden under 1100 px window width; primary buttons keep theirs; the menu lists every shortcut.
- Home reflows to one column under 700 px; nothing is clipped and there is no horizontal scroll at 400 px.
- `screens.css` reuses the token names of `styles.css:1-19` (`--page`, `--surface`, `--line`, `--line-strong`, `--text`, `--muted`, `--accent`, `--accent-strong`, `--accent-soft`, `--danger`); it adds only `--on-accent` and `--danger-soft` (values from the mockup, both themes).
- Python suite: `python3 -m unittest discover -s copilot/web -p 'test_*.py'` stays green after every task. Every existing `scripts/test-*-ui.cjs` and `scripts/check-note-ui.cjs` stays green (run with `node`, `PLAYWRIGHT_MODULE` as in `docs/MEETING_LIBRARY.md:57`).
- Commit messages in English, reference MEETONTRACK-165 or -161, end with the trailer the contract's Global rules give.
- Branch `redesign-call-flow`, worktree per the contract. Do not touch `call_plan.py` (plan 2 owns it).

## Review Focus

1. **App opened the morning after a call.** `transcript.status` is still `finished` from yesterday; the person expects Home, not After. Test: `viewFor` returns `home` when the finished call's `latest_at` is older than 2 h (Task 1).
2. **Calendar meeting the person does not attend.** Two minutes after its start the top bar says "Not recording"; it must disappear when the event ends and never appear for a skipped call. Test in Task 8 (`not_recording` only while `start + 120 s <= now < end`, never with `skip_recording`).
3. **Recorder too old to know a subcommand or the skip file.** `permissions` exits non-zero or prints usage; the person expects no microphone warning and no "Do not record" control, not an error. Tests in Tasks 3 and 5.
4. **Typing in a field while Home is visible.** Enter in the language select, a settings input or the ask field must not open a memo; the record shortcut must not fire inside a text field. Test in Task 8.
5. **Event with no `event_id` (before plan 2) and two events at the same start.** "Do not record" on one must not mark the other. Test in Task 5 (key falls back to `start + title`).

---

### Task 1: Shell files, static routes and view switching

**Files:**
- Create: `copilot/web/shell.js`, `copilot/web/home.js`, `copilot/web/screens.css`, `scripts/test-shell-ui.cjs`
- Modify: `copilot/web/index.html` (add `<link href="/screens.css">` after `styles.css`, `<section id="home" class="home" aria-labelledby="home-heading" hidden>` before `<main class="workspace">`, scripts `/shell.js` and `/home.js` with `defer` after `/app.js`), `copilot/web/server.py:2955-2973` (three `_static` routes), `copilot/web/app.js` (`state()` at :3104: after a successful response set `window.appState = data` and call `window.renderShell?.()`)
- Test: `copilot/web/test_home_api.py`

**Interfaces:**
- Produces (`shell.js`, globals):
  - `callKey(state) -> string`: `` `${live}:${state.transcript?.meeting_id || ""}` `` where `live = state.recording_health?.capture?.audio_recording === true || state.transcript?.live === true`.
  - `viewFor(state, manual) -> "home" | "call" | "after"`: live gives `call`; else `transcript.status === "finished"` with a `meeting_id` and `latest_at` within 2 h of now gives `after`; else `home`. `manual` is `{view, key}` or null and wins while `manual.key === callKey(state)`.
  - `openView(view)`: stores `{view, key: callKey(window.appState)}` in `localStorage["meetontrack-view"]` (try/catch), then `renderShell()`.
  - `renderShell()`: sets `document.body.dataset.view`, toggles `#home.hidden`, calls `renderHome(window.agendaData, window.appState)`. Called by `app.js` after each state poll and once at the end of `shell.js`.
- Produces (`home.js`): `renderHome(agenda, state)` (stub in this task: heading only).
- Produces (`app.js`): `window.agendaData` set in `refreshAgenda` (:1966), which also calls `window.renderShell?.()`.

- [ ] **Step 1: Write the failing tests.** `test_home_api.py::StaticFilesTests.test_shell_files_served_with_csp`: GET `/shell.js`, `/home.js` (`text/javascript; charset=utf-8`) and `/screens.css` (`text/css; charset=utf-8`) each return 200 with the `Content-Security-Policy` header (server pattern of `test_context_sources_api.py:20-24`). `scripts/test-shell-ui.cjs` (fake API pattern of `scripts/test-call-overview-ui.cjs:36-49`): `viewFor` table via `page.evaluate`: live → `call`; finished 10 min ago → `after`; finished 3 h ago → `home`; no transcript → `home`; `manual {view:'home', key}` with matching key over a finished call → `home`; same manual after the key changes to a live call → `call`. Page with a live fake state: `body.dataset.view === 'call'`, `.workspace` visible, `#home` hidden; with an idle state: `#home` visible, `.workspace` hidden.
- [ ] **Step 2: Run them, expect FAIL** (`python3 -m unittest copilot/web/test_home_api.py`, 404; `node scripts/test-shell-ui.cjs`, `viewFor is not defined`).
- [ ] **Step 3: Implement.** `screens.css`: `body[data-view="home"] .workspace, body[data-view="home"] .meeting-boundary-bar { display: none; }`. Nothing else visual yet.
- [ ] **Step 4: Run both tests and the whole suite, expect PASS.** Existing UI scripts whose fake state is idle now land on Home: give their fake state `live: true` or call `openView('call')` in the script, nothing else.
- [ ] **Step 5: Commit** `MEETONTRACK-165: shell files and view switching`.

### Task 2: Top bar and menu

**Files:**
- Modify: `copilot/web/index.html:15-34` (header), `:200-215` (transcript header), `copilot/web/shell.js`, `copilot/web/screens.css`, `copilot/web/styles.css:8` (`--line-strong`) and its dark block (:61), `copilot/web/app.js` (delete Refresh: element :64, handler :3351-3358, key `common.refresh` if no other use), `copilot/web/server.py:3461-3463` (delete `/api/refresh` if `grep -rn "api/refresh"` finds no other caller), `copilot/web/test_style_contrast.py`, `scripts/test-shell-ui.cjs`, existing scripts that click moved controls (`check-note-ui.cjs:60-64`, `test-fact-check-ui.cjs:90`, `test-library-ui.cjs:80-126`, `test-preferences-ui.cjs`, `test-update-ui.cjs:45-83`).

**Interfaces:**
- Produces DOM (ids later tasks use): `#nav-home` (button, `aria-current="page"` on Home), `#archive-button` (kept id, label `shell.past_calls`), `#call-status` (`<div class="status">` holding `#call-status-text` and `#call-status-action`), `#menu-button` (`aria-expanded`, `aria-controls="app-menu"`), `#app-menu` (`role="menu"`, hidden), `#delivery-alert` (stays in the bar).
- Moved into `#app-menu` with their ids unchanged, so `app.js`, `delivery.js`, `getting-started.js`, `updates.js` handlers keep working: `#settings-open`, `#repo-button`, `#getting-started-open`, `#updates-notice`, `#updates-install`, `#new-meeting-button`, `#transcript-show`, `#swap-panels`. Menu also holds `#menu-nav-home` and `#menu-past-calls` (shown under 700 px only), `#menu-notes` and `#menu-shortcuts` (Task 8 fills them), and the brand line "MeetOnTrack by aiagentlbs.com" at the bottom.
- Moved into the transcript pane header (Call/After only): `#meeting-title`, `#live-status`, `#capture-status`.
- Produces (`shell.js`): `toggleMenu(open: boolean)`. Escape and a click outside close it; focus returns to `#menu-button`; arrow keys move between items.

- [ ] **Step 1: Write the failing tests.** `test_style_contrast.py::test_border_token_reaches_3_to_1`: `--line-strong` against `--page`, `--surface`, `--surface-strong` is at least 3.0 in both themes. `test-shell-ui.cjs` adds: header has exactly four visible top-level controls (`#nav-home`, `#archive-button`, `#call-status`, `#menu-button`) plus `#delivery-alert` only when it has a problem; `#refresh-button` count is 0; `#menu-button` click opens `#app-menu`, Escape closes it and focus is on `#menu-button`; clicking `#settings-open` inside the menu shows `#settings-panel` as an overlay (its bounding box overlaps the workspace, the workspace's top does not move); `#speaker-edit` comes after `#transcript` in tab order (`compareDocumentPosition`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `--line-strong` becomes `#7f7b73` light and the mockup dark value `#737a73`. `.settings-panel` and `.getting-started` become fixed overlays under the bar in `screens.css` (`position: fixed; top: var(--bar-h); right: 0; width: min(720px, 100%); max-height: calc(100dvh - var(--bar-h)); overflow: auto; z-index: 20`). Move `#copy-dialog` and `#speaker-edit` into a `.transcript-footer` placed after `#frames`. Top-bar CSS from the mockup (`.topbar`, `.navs`, `.nav`, `.status`, `.tools`, `button`, `button.primary`, `.ql`, `kbd`, `.menu`, `.menu .mi`, `.menu small`, `.menu hr`), with `@media (max-width: 1100px)` hiding `.topbar kbd, .home button:not(.primary) kbd` and `@media (max-width: 700px)` hiding `.navs` and showing `#menu-nav-home, #menu-past-calls`. Use `@media` on the viewport, not container queries: the window is the viewport here.
- [ ] **Step 4: Update the existing scripts** to open `#menu-button` before clicking a moved control; replace the Refresh steps in `test-library-ui.cjs` with waiting for the next poll. Run every `scripts/*.cjs`, the Python suite and `test-shell-ui.cjs`; expect PASS.
- [ ] **Step 5: Commit** `MEETONTRACK-165: top bar with one status and a menu`.

### Task 3: Permissions API

**Files:**
- Create: `copilot/web/permissions.py`, `copilot/web/test_permissions.py`
- Modify: `copilot/web/server.py` (`do_GET`: `/api/permissions`; `do_POST`: `/api/permissions/open`; module global `PERMISSIONS = RecorderProbe(RECOGNITION_GUARD.binary)` beside the other globals near :2469)

**Interfaces:**
- Produces:
  - `class RecorderProbe(binary: Path, run=subprocess.run, os_name: str = os.name, read_registry=None, ttl: float = 30)`
  - `RecorderProbe.snapshot() -> dict`: `{"microphone": "granted"|"denied"|"unknown", "call_audio": same, "skip_recording": bool}`, cached `ttl` seconds.
    - macOS: runs `[binary, "permissions"]` (timeout 5). Exit 0 with a JSON object: take `microphone`, `call_audio` (any other value becomes `unknown`), `skip_recording is True`. Any other outcome (missing binary, non-zero exit, usage text, timeout): all `unknown`, `skip_recording` false.
    - Windows: microphone from `HKCU`/`HKLM` `Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone` `Value`, the same rule as `windows/src/Amanu.App/Access.cs:80-94` (`Deny` in HKLM or HKCU store, or in HKCU `\NonPackaged`, gives `denied`; no HKCU value gives `unknown`; else `granted`). `call_audio` is `unknown` (loopback needs no permission). `skip_recording` from `[binary, "record", "status"]` stdout JSON key `skip_recording is True`.
  - `open_settings(which: str, os_name: str = os.name, opener=None) -> None`: macOS `/usr/bin/open` with `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` (`microphone`) or `...?Privacy_ScreenCapture` (`call_audio`); Windows `os.startfile("ms-settings:privacy-microphone")` for `microphone`. Any other `which`, or `call_audio` on Windows, raises `ValueError` (route answers 400).
  - `GET /api/permissions` -> `{"ok": true, "microphone", "call_audio", "recorder": "running"|"stopped"|"unknown"}` (`recorder` from `recorder_running()`, :2782). `POST /api/permissions/open` `{"which"}` -> `{"ok": true}`.

- [ ] **Step 1: Write the failing tests** (`test_permissions.py`): `test_macos_reads_recorder_json` (fake run prints `{"microphone":"denied","call_audio":"granted","skip_recording":true}` → same dict); `test_macos_old_recorder_is_unknown` (exit 64 with usage text → all `unknown`, `skip_recording` False); `test_macos_odd_value_is_unknown` (`"microphone":"notAsked"` → `unknown`); `test_windows_registry_rules` (four registry cases from Access.cs → `denied`, `denied`, `unknown`, `granted`); `test_snapshot_is_cached` (two calls within ttl → one run); `test_open_rejects_unknown_which` (`"camera"` and Windows `call_audio` raise `ValueError`); `test_routes` (server pattern: GET returns the four fields; POST from a foreign Origin → 403; bad `which` → 400).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `MEETONTRACK-161: permissions API`.

### Task 4: macOS `permissions` subcommand (native)

**Files:**
- Create: `capture/Sources/meetingcopilot/Setup/PermissionsCommand.swift`, `capture/Tests/meetingcopilotTests/PermissionsCommandTests.swift`
- Modify: `capture/Sources/meetingcopilot/MeetingCopilot.swift:11-14` (add `PermissionsCommand.self` to `subcommands`)

**Interfaces:**
- Produces: `struct PermissionsCommand: ParsableCommand` (`commandName: "permissions"`), printing one JSON line. `static func report(microphone: SetupPermissions.State, heardAt: Date?, now: Date) -> [String: String]`: microphone `.granted` → `granted`, `.denied` → `denied`, `.notAsked`/`.unknown` → `unknown` (auto-record raises the system prompt itself); `call_audio` is `granted` when `SetupPermissions.rememberedSystemAudio(heardAt:now:) == .heard` (`Setup/Permissions.swift:127`, tone heard within 30 days, from `SetupState.systemAudioHeardAt()`), else `unknown` (macOS has no API that reads it; never `denied`). The command runs on the main actor like `Record.run` (`Sessions/RecordCommand.swift:20-21`). It is the bundled binary started by `server.py`, which the app launches (`LocalServer.swift:318`), so the microphone answer is the app's own grant.

- [ ] **Step 1: Write the failing test** `PermissionsCommandTests.testReportMapsStates`: the four microphone states map as above; `heardAt` 3 days ago → `call_audio` `granted`; 40 days ago or nil → `unknown`.
- [ ] **Step 2: Run** `cd capture && swift test --filter PermissionsCommandTests`, expect FAIL. **Step 3: Implement.** **Step 4: Run, expect PASS;** `swift build`, then `.build/debug/meetingcopilot permissions` prints valid JSON.
- [ ] **Step 5: Commit** `MEETONTRACK-161: recorder reports permissions as JSON`.

### Task 5: Agenda additions and "do not record" storage

**Files:**
- Create: `copilot/web/skip_recording.py`
- Modify: `copilot/web/calendar_meetings.py` (one method), `copilot/web/server.py:3035-3037` (`/api/agenda` goes through `agenda_payload()`), `do_POST` (`/api/agenda/skip-recording`), `copilot/web/test_home_api.py`

**Interfaces:**
- Produces:
  - `CalendarMeetings.state() -> "connected" | "not_connected" | "tool_missing"`: no `executable` → `tool_missing`; `enabled` set and false → `not_connected`; else `connected`.
  - `class SkipRecording(path: Path)` with `path` = `skip-recording.json` in the app data directory, the one where the recorder writes `meeting-copilot-live.json` (`~/.local/share/meeting-copilot/` on macOS; the same directory the server already reads on Windows). It is generated data, so it does not go into `config.json` or the config directory. File shape, read by both recorders in Task 9: `{"version": 1, "calls": [{"key": str, "event_id": str, "start": ISO, "end": ISO}]}`.
    - `SkipRecording.key(meeting: dict) -> str`: `event_id` when non-empty, else `start + "|" + title`.
    - `SkipRecording.set(meeting: dict, skip: bool, now: datetime) -> None`: atomic write (temp file plus `os.replace`), drops calls whose `end` has passed, validates `start < end` as ISO times with a zone (else `ValueError`).
    - `SkipRecording.skipped(meeting: dict) -> bool`.
  - `agenda_payload(now=None) -> dict`: `PLANS.agenda(now)` plus top-level `calendar_state` (from `PLANS.calendar.state()`, `tool_missing` when there is no calendar object) and `skip_recording_supported` (`PERMISSIONS.snapshot()["skip_recording"]`), and per meeting `skip_recording` (`SKIPS.skipped(meeting)`).
  - `POST /api/agenda/skip-recording` `{"event_id", "start", "end", "title", "skip"}` -> `{"ok": true}` (contract fields plus `start`, `end`, `title`, so the file works before plan 2 supplies ids). It answers 409 `{"ok": false, "error": "..."}` when `skip_recording_supported` is false.

- [ ] **Step 1: Write the failing tests** (`test_home_api.py`): `test_calendar_state_three_cases`; `test_skip_set_and_clear_by_event_id`; `test_skip_key_falls_back_to_start_and_title` (two events at the same start, different titles: skipping one leaves the other `False`); `test_skip_prunes_ended_calls`; `test_skip_rejects_bad_times` (no zone, `end <= start`); `test_agenda_payload_fields` (patched `PLANS`, `SKIPS`, `PERMISSIONS`: `calendar_state`, `skip_recording_supported`, per-meeting `skip_recording`); `test_skip_route_refuses_when_recorder_cannot_honour_it` (409, file unchanged).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `MEETONTRACK-161: agenda calendar state and do-not-record choice`.

### Task 6: Home rows

**Files:**
- Modify: `copilot/web/home.js`, `copilot/web/screens.css`, `copilot/web/app.js` (translations; delete `renderAgenda` :1975-2007 and the Preparation tab `#call-plan-tab` agenda path, keeping `memoNodes` :1955 and `memoDetails` which `home.js` calls; `renderCallPlan` keeps the live call's plan for the board)
- Create: `scripts/home-fixtures.cjs`, `scripts/test-home-ui.cjs`

**Interfaces:**
- Consumes: `window.agendaData` (contract `meetings[]` fields), `memoNodes(plan)` from `app.js`, `t()`.
- Produces (`home.js`):
  - `memoFromPlans(meeting) -> memo`: the contract `memo` object when the server sends none. A plan with `has_memo` gives `state: "ready"`, `goal` = first line of `memo_markdown` that is not a heading, list item or empty (markdown stripped, cut at 160 chars), `questions` = first three list or plain lines ending in `?`, `background: ""`, `source_count` = `links.length` (0 hides the link), `plan_id`, `written_by: "file"`; no such plan gives `state: "nothing_found"` when the meeting has attendees other than `self`, else `none`.
  - `nextMeeting(agenda, now) -> meeting | null`: first meeting with `end > now`.
  - `renderHome(agenda, state)`: groups by day (`home.today`, `home.tomorrow` with weekday and date), one `.row` per meeting (`time`, `.soon` time-left on the next meeting's row only, `.mtitle`, `.who` attendees other than `self`: name in `<b>`, then company or e-mail), then by `memo.state`:
    - `ready`: `.goal` (`home.goal`), `.asks` list, `.bg` with a `.ql` "Where this comes from" (`home.sources`, plural via `Intl.PluralRules`), `.actions`: on the next row `Open memo` (primary, `<kbd>↵</kbd>`), `Open the call link` (`.ql`, `meeting.link`, hidden when empty), `Do not record this call` (`button.quiet`, only when `agenda.skip_recording_supported`); other rows get `Open memo` as a normal button. Open memo toggles the full memo below the row from `memoNodes(plan)`.
    - `preparing`: `.state` with `<b>home.preparing_since</b> home.preparing_note`.
    - `nothing_found`: `.state` `home.nothing_found`, then muted `home.calendar_on`, then button `home.connect_sources`, which opens the sources dialog (`#repo-button` click, then `#google-context-settings.open = true`, as `getting-started.js:185` does).
    - `failed`: `.fail` line `home.failed` with the reason key; `home.retry_at` when `retry_at` is set and the reason is not `ai_needs_choice`; button `home.retry` (`POST /api/memo/rebuild {event_id}`, hidden when `event_id` is empty) and `.ql` `home.check_ai` (opens `#getting-started-open`).
    - `none`: no memo line.
    - `skip_recording` true: `.status-text` `home.skipped` plus `.ql` `home.unskip`; the skip and unskip controls call `POST /api/agenda/skip-recording` then `refreshAgenda()`.
  - Unscheduled plans keep a section under `plan.unscheduled` with title and Open memo.
  - Time left: `home.in_minutes` under 60 min, `home.in_hours` above, `home.now` while running; re-rendered every 30 s from the cached agenda.
- Produces (`scripts/home-fixtures.cjs`): `states` (name → `{agenda, state, permissions}` built relative to `Date.now()`), `route(context, fixture, origin)`, `open(browser, {fixture, width, scheme, lang}) -> page`.

i18n keys (RU from the mockup / EN): `home.today` "Сегодня, {date}" / "Today, {date}"; `home.tomorrow` "Завтра, {date}" / "Tomorrow, {date}"; `home.in_minutes` "через {n} мин" / "in {n} min"; `home.in_hours` "через {h} ч {m} мин" / "in {h} h {m} min"; `home.now` "идет сейчас" / "on now"; `home.goal` "Цель: {goal}" / "Goal: {goal}"; `home.sources.one|few|many|other` "Откуда это: {n} источник|источника|источников|источника" / "Where this comes from: {n} source|sources"; `home.open_memo` "Открыть мемо" / "Open memo"; `home.hide_memo` "Свернуть мемо" / "Hide memo"; `home.call_link` "Открыть ссылку на звонок" / "Open the call link"; `home.skip` "Не записывать этот звонок" / "Do not record this call"; `home.skipped` "Этот звонок не будет записан" / "This call will not be recorded"; `home.unskip` "Вернуть" / "Undo"; `home.preparing_since` "Мемо готовится с {time}," / "Memo in progress since {time},"; `home.preparing_note` "обычно 2-3 минуты. Появится здесь само." / "usually 2-3 minutes. It will appear here by itself."; `home.nothing_found` "О собеседнике в ваших источниках пока ничего нет." / "Nothing about this contact in your sources yet."; `home.calendar_on` "Календарь уже подключен." / "The calendar is already connected."; `home.connect_sources` "Подключить почту и папки с файлами" / "Connect mail and file folders"; `home.failed` "Мемо не получилось: {reason}." / "The memo could not be made: {reason}."; `home.reason.ai_no_answer` "ИИ не ответил" / "the AI did not answer"; `.ai_needs_choice` "не выбран ИИ" / "no AI is chosen"; `.timeout` "ИИ не успел" / "the AI ran out of time"; `.error` "ошибка при подготовке" / "something went wrong"; `home.retry_at` "Ничего делать не нужно, попробуем снова в {time}." / "Nothing to do, we will try again at {time}."; `home.retry` "Повторить" / "Retry"; `home.check_ai` "Проверить ИИ в настройках" / "Check the AI in settings".

- [ ] **Step 1: Write the failing tests** (`test-home-ui.cjs`, each fixture at 1440, 1024 and 400 px, light and dark (`colorScheme`), RU and EN, screenshot to `fs.mkdtempSync(os.tmpdir())`, printed at the end). Every run asserts: `document.documentElement.scrollWidth <= innerWidth` at every width; no `[ёЁ]` in RU text; no `—` in any text; no `pageerror` from `shell.js`/`home.js`. Per state: `ready` (goal, three `.asks li`, `.soon` text matches `/через 40 мин|in 40 min/`, `Open memo` click shows `.memo-details`); `preparing` (`/с \d\d:\d\d/` and `/since \d\d:\d\d/`); `nothing_found` (button text names mail and folders; click opens `#project-dialog`); `failed` (reason, `retry_at` time, `/Ничего делать не нужно|Nothing to do/`, Retry posts `/api/memo/rebuild`); `skipped` (`home.skipped` and Undo; Undo posts `skip: false`); `adapter` (agenda with plans and no `memo`: goal and questions taken from `memo_markdown`); `no_skip_support` (`skip_recording_supported: false` → no "Do not record" control anywhere).
- [ ] **Step 2: Run** `node scripts/test-home-ui.cjs`, expect FAIL. **Step 3: Implement** (row CSS from the mockup: `.home`, `.col`, `.day`, `.row`, `.row.next`, `.time`, `.soon`, `.mtitle`, `.who`, `.goal`, `.asks`, `.bg`, `.actions`, `.state`, `.fail`). **Step 4: Run, expect PASS;** run the Python suite and the other scripts.
- [ ] **Step 5: Commit** `MEETONTRACK-161: Home rows with memo digest`.

### Task 7: Empty states, narrow window

**Files:**
- Modify: `copilot/web/home.js`, `copilot/web/screens.css`, `copilot/web/app.js` (translations), `scripts/home-fixtures.cjs`, `scripts/test-home-ui.cjs`, `capture/Sources/meetingcopilot/UI/AssistantLink.swift:50` (`minSize` to `NSSize(width: 400, height: 480)`)

**Interfaces:** `renderHome` shows one `.empty` block, at most one action, chosen in this order: `calendar_state === "tool_missing"` (`home.tool_title`, `home.tool_text`, `.ql` `home.tool_link` to `https://github.com/AIAgentLbs/meetontrack/blob/main/docs/CONTEXT_SOURCES.md`); `"not_connected"` (`home.calendar_off_title`, `home.calendar_off_text`, primary `home.calendar_connect`, same opener as `connect_sources`); no meetings and no unscheduled plans (`home.empty_title`, `home.empty_text`, no action).

Keys: `home.tool_title` "Нет программы для чтения календаря" / "The calendar reader is not installed"; `home.tool_text` "MeetOnTrack читает Google Календарь через программу gws." / "MeetOnTrack reads Google Calendar through the gws tool."; `home.tool_link` "Как ее установить" / "How to install it"; `home.calendar_off_title` "Календарь не подключен" / "The calendar is not connected"; `home.calendar_off_text` "Звонки и мемо появятся после подключения." / "Calls and memos appear once it is connected."; `home.calendar_connect` "Подключить календарь" / "Connect the calendar"; `home.empty_title` "Сегодня и завтра звонков нет" / "No calls today or tomorrow"; `home.empty_text` "Прошедшие звонки открываются сверху." / "Past calls open from the top bar."

- [ ] **Step 1: Write the failing tests:** fixtures `calendar_off`, `tool_missing`, `no_meetings`, each with its title and exactly the one action (count of `.empty button, .empty a` is 1, 1, 0); at 400 px every fixture from Task 6 also has `.row` `grid-template-columns` of one column and the next row's title and time-left both visible (`boundingBox` inside the viewport).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** (`@media (max-width: 700px)` block of the mockup for `.col`, `.home`, `.row`, `.soon`, `.who`). Change the Swift `minSize`; `cd capture && swift build`. **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `MEETONTRACK-161: Home empty states and narrow window`.

### Task 8: One call status, permission pre-check, shortcuts

**Files:**
- Modify: `copilot/web/shell.js`, `copilot/web/app.js` (translations; `refreshAgenda` also fetches `/api/permissions` into `window.permissionsData`, plus on `visibilitychange` to visible), `copilot/web/screens.css`, `scripts/home-fixtures.cjs`, `scripts/test-home-ui.cjs`, `scripts/test-shell-ui.cjs`

**Interfaces:**
- Produces (`shell.js`):
  - `callStatus(state, agenda, permissions, now) -> {kind, text, action}` with `kind` one of `recording`, `mic_missing`, `not_recording`, `waiting`; `action` is `null` or `{id, label, primary}` with `id` one of `open_mic`, `open_call_audio`, `open_recorder`, `start`. Rules, first match wins (`next` = first meeting with `end > now` and not `skip_recording`):
    1. live (as in `callKey`) → `recording`, text `status.recording`, no action in this plan (plan 3 adds Stop recording).
    2. `next` running (`start + 120 s <= now < end`) → `not_recording`, `status.not_recording` with reason `mic` (microphone `denied`, action `open_mic` primary), `recorder` (`recorder === "stopped"`, action `open_recorder` primary), else `not_detected` (action `start` primary).
    3. `next` exists and microphone `denied` → `mic_missing`, `status.mic_missing` naming `next`'s time, action `open_mic` primary. Never `start`.
    4. `next` exists and `call_audio` `denied` → `mic_missing` kind with `status.call_audio_missing`, action `open_call_audio`.
    5. else `waiting`: `status.waiting_at` with `next`'s time, or `status.waiting` with none; action `start` (secondary, `<kbd>`).
  - Actions: `open_mic`/`open_call_audio` → `POST /api/permissions/open`; `open_recorder` → `POST /api/getting-started/open-recorder`; `start` → `POST /api/getting-started/start-recording`. A failure shows `plainError` in `#call-status-text` until the next poll.
  - `#call-status-text` of kind `recording` carries the accent dot (`.rec::before`); `mic_missing`/`not_recording` use `.fail`.
  - On Home, the next row repeats the fixing action first when `kind` is `not_recording` (as in the mockup: fix, then Start recording when allowed, then `.ql` `action.how_to_fix` to the getting-started overlay).
  - `shortcuts` table and one `keydown` listener on `document`, ignored when `event.target` is an `input`, `textarea`, `select`, `[contenteditable]`, a `button` (for Enter) or inside an open dialog or overlay: Enter → Open memo of the next meeting (Home only); `⌘⇧R` on macOS (`/Mac/.test(navigator.platform)`), `Alt+Shift+R` elsewhere (Ctrl+Shift+R reloads the page in the Windows app window), with `preventDefault` → `start` when `callStatus().action?.id === "start"`; `J` → Open the call link; `N` → Do not record (only when supported). `#menu-shortcuts` lists all four with their labels; menu items carry their `<kbd>`.
  - `#menu-notes` (`shell.notes` naming the current call's title) is shown only in Call/After and switches to the `notes` tab of the workspace (`[data-content-view="notes"]` click).
- Keys: `shell.home` "Главная" / "Home"; `shell.past_calls` "Прошедшие звонки" / "Past calls"; `shell.menu` "Меню" / "Menu"; `shell.settings` "Настройки" / "Settings" with `shell.settings_note` "ИИ, распознавание речи, источники, куда отправлять отчет" / "AI, speech recognition, sources, where the report goes"; `shell.sources` "Источники" / "Sources"; `shell.notes` "Заметки к звонку «{title}»" / "Notes for the call {title}" with `shell.notes_note` "ваш текст, который учтут подсказки" / "your text the hints take into account"; `shell.getting_started` "Начало работы" / "Getting started"; `shell.updates` "Обновления" / "Updates"; `shell.keys` "Клавиши" / "Keys"; `shell.key.memo` "Открыть мемо следующего звонка" / "Open the next call's memo"; `shell.key.join` "Открыть ссылку на звонок" / "Open the call link"; `shell.key.skip` "Не записывать следующий звонок" / "Do not record the next call"; `status.waiting` "Ждет звонка, запись включится сама" / "Waiting for a call, recording starts by itself"; `status.waiting_at` "Ждет звонка в {time}, запись включится сама" / "Waiting for the {time} call, recording starts by itself"; `status.recording` "Запись" / "Recording"; `status.mic_missing` "Нет доступа к микрофону: запись в {time} не включится" / "No microphone access: the {time} call will not be recorded"; `status.call_audio_missing` "Нет доступа к звуку звонка: запись в {time} будет без собеседника" / "No access to call audio: the {time} call will be recorded without the other side"; `status.not_recording` "Запись не идет: {reason}" / "Not recording: {reason}"; `status.reason.mic` "нет доступа к микрофону" / "no microphone access"; `status.reason.recorder` "программа записи не запущена" / "the recorder is not running"; `status.reason.not_detected` "звонок не замечен" / "the call was not detected"; `action.start` "Начать запись" / "Start recording"; `action.open_mic` "Открыть настройки микрофона" / "Open microphone settings"; `action.open_call_audio` "Открыть настройки записи звука" / "Open audio recording settings"; `action.open_recorder` "Открыть программу записи" / "Open the recorder"; `action.how_to_fix` "Как исправить" / "How to fix".

- [ ] **Step 1: Write the failing tests.** `test-shell-ui.cjs`: `callStatus` table via `page.evaluate` for each rule, including: microphone `denied` with no meeting → `waiting` without the warning; `unknown` everywhere → `waiting`; running meeting with `skip_recording` → `waiting`; meeting ended → `waiting`; never an action `start` when microphone is `denied`. `test-home-ui.cjs` fixtures: `mic_missing` (bar names the call time, only `Open microphone settings`, no element with text `Начать запись`/`Start recording` anywhere on the page, click posts `/api/permissions/open {which:"microphone"}`); `not_recording` (bar `Запись не идет`/`Not recording`; next row: fix action first, then Start recording, then How to fix); `menu_open` (all items, `#menu-shortcuts` lists four shortcuts); `menu_narrow` at 400 px (menu holds Home and Past calls, `.navs` hidden, menu fits the viewport). Keyboard: Enter on body opens the memo; Enter with focus in `#interface-language` or `#question` does nothing on Home; `Meta+Shift+R` (`Alt+Shift+R` off Mac) posts `start-recording` in `waiting` and nothing in `mic_missing`; at 1440 px the bar's Start recording shows its `<kbd>`, at 1024 px it does not, and Open memo (primary) keeps its `<kbd>` at 1024 px.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run all scripts and the Python suite, expect PASS.**
- [ ] **Step 5: Commit** `MEETONTRACK-165: one call status with permission pre-check and shortcuts`.

### Task 9: Recorders honour "do not record" (native, may slip)

**Files:**
- Create: `capture/Sources/meetingcopilot/Meetings/SkipRecording.swift`, `windows/src/Amanu.Core/Recording/SkipRecording.cs`
- Modify: `capture/Sources/meetingcopilot/Meetings/AutoRecordController.swift:67-81` (init) and `:144-149` (`evaluateStart`), `capture/Sources/meetingcopilot/Setup/PermissionsCommand.swift` (`"skip_recording": true`), `windows/src/Amanu.Core/Recording/RecordingCoordinator.cs:39-43` (constructor) and `:94` (start guard), `windows/src/Amanu.App/AmanuRuntime.cs:71` (pass the reader), `windows/src/Amanu.App/CopilotControl.cs` (status reply gains `skip_recording=true`)
- Test: `capture/Tests/meetingcopilotTests/AutoRecordTests.swift`, `windows/tests/Amanu.Core.Tests/RecordingCoordinatorTests.cs`

**Interfaces:**
- Consumes: the file shape of Task 5, in the app data directory beside `meeting-copilot-live.json` on each platform.
- Produces: Swift `enum SkipRecording { static func covers(_ now: Date, at url: URL = path) -> Bool }`; C# `public static class SkipRecording { public static bool Covers(DateTimeOffset at, string? path = null) }`. Both: true when any call has `start - 5 min <= now < end`; a missing or unreadable file is false. Matching by time, not id: the recorders read EventKit or nothing, not Google event ids.
- `AutoRecordController(... skipped: @escaping (Date) -> Bool = { SkipRecording.covers($0) })`; `evaluateStart` returns early with `lastDecision` "skipped: chosen in MeetOnTrack" / "пропуск: выбрано в MeetOnTrack" before the calendar and microphone triggers. Manual starts are not affected.
- `RecordingCoordinator(..., Func<DateTimeOffset, bool>? skipped = null)`; the automatic start at :94 also requires `skipped?.Invoke(observation.At) != true`.
- What the person sees without this task: `skip_recording_supported` stays false, so Home shows no "Do not record" control and the route answers 409 (Tasks 5 and 6). Never a control that does nothing.

- [ ] **Step 1: Write the failing tests:** `AutoRecordTests.testSkippedCallDoesNotAutoStart` (mic held past `startDelay` with `skipped` true → `startRecording` not called; false → called); `testSkipFileWindow` (file with one call: 6 min before start false, 4 min before true, at end false). C# `RecordingCoordinatorTests.SkippedCallDoesNotAutoStart` and `SkipRecordingTests.CoversWindow` with the same cases.
- [ ] **Step 2: Run** `cd capture && swift test --filter AutoRecordTests` (and the Windows tests in `.github/workflows/windows-candidate.yml` CI), expect FAIL. **Step 3: Implement.** **Step 4: Run, expect PASS;** on a Mac with the bundled app, `meetingcopilot permissions` prints `"skip_recording": true` and Home shows the control.
- [ ] **Step 5: Commit** `MEETONTRACK-161: recorders skip a call the person chose not to record`.

### Task 10: System notification when recording fails at call time (native, may slip)

**Files:**
- Modify: `capture/Sources/meetingcopilot/Meetings/AutoRecordController.swift` (at the two `startRecording?` calls, :171 and :202), `capture/Sources/meetingcopilot/Notifications.swift` (one new banner kind), `windows/src/Amanu.App/AmanuRuntime.cs:93` (the existing "Couldn't start recording" banner)
- Test: `capture/Tests/meetingcopilotTests/AutoRecordTests.swift`

**Interfaces:**
- macOS: `AutoRecordController(... microphone: @escaping () -> SetupPermissions.State = SetupPermissions.microphone, notifyMicrophoneMissing: @escaping () -> Void = Notifications.microphoneMissing)`. When an automatic start happens and microphone is `.denied`, it calls `notifyMicrophoneMissing()` once per start and still starts (call audio is still worth recording). `Notifications.microphoneMissing()` posts "Not recording your voice: no microphone access" / "Ваш голос не записывается: нет доступа к микрофону"; a click opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`.
- Windows: when `MicrophoneAccess.Read()` is not `Allowed` or `Unknown`, the banner at :93 says the same and a click runs `MicrophoneAccess.OpenSettings()`.

- [ ] **Step 1: Write the failing test** `AutoRecordTests.testDeniedMicrophoneNotifiesOnAutoStart` (denied → one notify, start still called; granted → no notify).
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS;** check the Windows banner by hand on the candidate build.
- [ ] **Step 5: Commit** `MEETONTRACK-161: notify when a call starts without microphone access`.

### Task 11: Render for critique

**Files:**
- Create: `scripts/render-home-critique.cjs`

**Interfaces:**
- Consumes: `states`, `open` from `scripts/home-fixtures.cjs`.
- Produces: `node scripts/render-home-critique.cjs <out-dir>` writes `<out-dir>/<state>-<width>-<scheme>-<lang>.png` for every fixture (`ready`, `preparing`, `nothing_found`, `failed`, `calendar_off`, `tool_missing`, `no_meetings`, `skipped`, `mic_missing`, `not_recording`, `menu_open`, `menu_narrow`) at 1440, 1024 and 400 px, light and dark, RU and EN, full page, plus `<out-dir>/index.html` (relative `<img>` list with captions, no inline styles needed) and `manifest.json` (`[{state, width, scheme, lang, file}]`). It exits 1 if any page raised an error or scrolled horizontally. It does not run the critique.

- [ ] **Step 1:** Run it into a scratch dir; expect 144 PNG files and a manifest of 144 entries.
- [ ] **Step 2: Commit** `MEETONTRACK-161: render Home and chrome for critique`.

---

## Owner-side decisions taken on 2026-11-21

- After is shown only when the call ended within the last 2 hours; later the app opens on Home.
- A microphone permission that was never asked is `unknown` (recording raises the system prompt itself).
- The record shortcut is Alt+Shift+R on Windows.
- The brand line moves to the bottom of the menu.

## Not covered here, and why

- **Settings regrouped as AI, Speech, Sources, Delivery with Advanced closed** (spec, App chrome): the four groups live in three places today (getting-started overlay, sources dialog, settings panel); merging them is its own change and the spec's Order names it first to slip. This plan only names the groups in the Settings menu item.
- **Stop recording in the top bar during a call**: contract assigns `/api/recording/stop` to plan 3; in this plan the Recording status has no control.
- **Notes for a call before it starts**: notes attach to the live meeting id (`JOURNAL.manual_context`); the menu item appears only in Call and After.
- **Memo fields from the server** (`event_id`, real `memo` states, rebuild route): plan 2. Home uses the adapter until then; Retry stays hidden while `event_id` is empty.
