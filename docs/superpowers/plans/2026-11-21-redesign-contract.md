# Call flow redesign: shared contract between tracks

Spec: `docs/superpowers/specs/2026-11-20-call-flow-redesign-design.md` (approved
2026-11-21). This file fixes the names that more than one plan relies on, so
the tracks can be built in parallel. A plan may add fields; it may not rename
or drop one listed here without changing this file in the same commit.

## Tracks and plans

| Plan | Issues | Owns |
|---|---|---|
| `2026-11-21-redesign-1-chrome-home.md` | MEETONTRACK-165, 161 | page shell, view switching, Home, permissions, "do not record" |
| `2026-11-21-redesign-2-memo-writer.md` | MEETONTRACK-164 | event ids, external-meeting detection, the memo loop, the memo block of the agenda |
| `2026-11-21-redesign-3-call.md` | MEETONTRACK-162 | Call view, stop and resume (the `record pause` verb in both recorders), heartbeat, hint selection, the heard question |
| `2026-11-21-redesign-4-after.md` (written after plan 3 lands) | MEETONTRACK-163 | After view, hold and send, edits, board removal, memo check, participants |

Branch: `redesign-call-flow`, one git worktree per plan in progress, merged
into the branch task by task. `main` receives the branch when a view passes
its critique. A release is a separate owner decision.

## Global rules (every plan inherits them)

- No real meeting title, person, company or client name in code, tests,
  fixtures, screenshots or commit messages. Fixtures use invented generic data
  ("Anna Petrova", "Example LLC", "Pilot review"). The approved mockup and
  its demo data live outside the repository and are never copied into it.
- No AI or speech provider, model, effort or mode in code. AI work goes
  through `AIService.run(purpose, ...)`; a new task is a new entry in
  `PURPOSES`. No chosen AI means the feature is unavailable with the reason.
- One settings store, `~/.config/meeting-copilot/config.json`, written with an
  atomic read-modify-write of the writer's own keys. Generated data goes to
  the app's data directory, not to settings.
- Every UI string exists in `translations.ru` and `translations.en`. The page
  CSP forbids inline styles and inline scripts.
- No confirmation dialog on start, stop or send.
- No new dependency, Python or JavaScript.
- Tests: `python3 -m unittest discover -s copilot/web -p 'test_*.py'` stays
  green. Browser checks are Playwright `.cjs` scripts in `scripts/`, run with
  `node`, against a fake local API, like the existing `scripts/test-*-ui.cjs`.
- Commit messages are in English, reference the issue, and end with the
  trailer lines of the session that does the work (`Co-Authored-By` with that
  session's model, `Claude-Session` with that session's link).

## Views

`document.body.dataset.view` is one of `home`, `call`, `after`. It is derived
from state by one function, `viewFor(state, manual)` in `shell.js`:

- a live recording gives `call`;
- a recording that ended, until the person leaves it, gives `after`;
- otherwise `home`;
- `manual` (set when the person opens a view by hand) wins until the call
  state changes.

Front-end files, all plain scripts in `copilot/web/` loaded by `index.html`:
`shell.js` (top bar, menu, view switching, shortcuts), `home.js`, `call.js`,
`after.js`, and one stylesheet `screens.css` for the three views and the
shell. `app.js` keeps state polling, translations and the existing
overlays; code that moves to a view file is deleted from `app.js`.
Each view file exposes one function: `renderHome(agenda, state)`,
`renderCall(state)`, `renderAfter(state)`.

## `GET /api/agenda`

Existing fields stay. Each item of `meetings` gains:

| Field | Type | Owner | Meaning |
|---|---|---|---|
| `event_id` | string | plan 2 | calendar event id, `""` when the calendar gives none |
| `external` | bool | plan 2 | at least one attendee outside the user's own e-mail domain |
| `skip_recording` | bool | plan 1 | the person chose "do not record this call" |
| `memo` | object | plan 2 | see below |

`memo`:

| Field | Type | Meaning |
|---|---|---|
| `state` | `"ready"`, `"preparing"`, `"nothing_found"`, `"failed"`, `"none"` | `none` = internal or solo event, no memo intended |
| `goal` | string | one line; empty unless `ready` |
| `questions` | list of string, at most 3 | questions to ask |
| `background` | string | at most one line |
| `source_count` | int | number of sources behind the memo |
| `plan_id` | string | id of the plan to open; empty unless `ready` |
| `written_by` | `"app"` or `"file"` | a picked-up `-prep.md` or `preparations.json` plan is `file` |
| `since` | ISO time or null | when `preparing` started |
| `reason` | `"ai_no_answer"`, `"ai_needs_choice"`, `"timeout"`, `"error"`, `""` | set when `failed` |
| `retry_at` | ISO time or null | the one automatic retry; null when none is planned |

`POST /api/memo/rebuild` with `{"event_id": "..."}` returns `{"ok": true}` and
puts the meeting into `preparing` (plan 2).

`POST /api/agenda/skip-recording` with
`{"event_id": "...", "start": ISO, "end": ISO, "title": "...", "skip": true}`
returns `{"ok": true}`, or 409 when the recorder cannot honour it (plan 1):
`recorder_cannot_skip`, or `recording_active` while any recording runs (ruling R32; an
undo, `"skip": false`, is still accepted).
The choice is stored in `skip-recording.json` in the app data directory and
matched by the recorders by time window.

The response also gains two top-level fields (plan 1): `calendar_state`
(`"connected"`, `"not_connected"`, `"tool_missing"`) and
`skip_recording_supported` (bool; when false the UI shows no "do not record"
control).

Until plan 2 lands, plan 1 renders from a fake API that returns these fields;
against the real server a missing `memo` is derived in the front end from the
existing `plans[]` (`has_memo`), so Home works with either.

## `GET /api/permissions` (plan 1)

```
{"microphone": "granted" | "denied" | "unknown",
 "call_audio": "granted" | "denied" | "unknown",
 "recorder": "running" | "stopped" | "unknown"}
```

`unknown` means the platform cannot tell; the UI then shows nothing.
`POST /api/permissions/open` with `{"which": "microphone" | "call_audio" | "sound_output"}`
opens the system settings page for that permission.

## Recording control (plan 3)

After `record stop` there is nothing to resume, so Stop pauses first and stops
for good after the undo window. `record resume` unpauses and restarts
recognition; `record relisten` only restarts recognition of a running,
unpaused recording. The server's recognition watchdog sends `relisten`, and
nothing at all while a stop is pending, so only an explicit Resume unpauses
(fix wave A1). A paused capture publishes `status: "paused"` in the live file
on both platforms.

- Every command is bound to the recorder's own live session: the live file it
  writes (`meeting_id` and `started_at`, not finished), read when the command
  runs. Stop stores that session with the pending stop; Resume and the
  deferred stop act only while it is still the live one, else they clear the
  pending stop and act on nothing (Resume answers `meeting_changed`), so a
  new call that began meanwhile is never muted (fix wave A2).
- The server passes that session to the recorder: `record pause|resume|stop
  --session <meeting_id>`. The recorder compares it with its own live session
  (macOS on the main actor, Windows against the exporter's id) and refuses a
  mismatch with exit code 3, which the server reads as "that recording is
  over". Without `--session` the commands act as before (fix wave J1).
- `POST /api/recording/stop` with `{"meeting_id": "..."}` pauses the recorder
  at once (`record pause`) and answers
  `{"ok": true, "stopped_at": ISO, "until": ISO | null}`; the server sends
  `record stop` at `until` (`stopped_at` + 30 s). A recorder that cannot pause
  is stopped at once and `until` is null. A `meeting_id` other than the live
  one answers 409 `{"ok": false, "error": "meeting_changed"}`.
- `POST /api/recording/resume` with `{"meeting_id": "..."}` before `until`
  sends `record resume` and cancels the pending stop, `{"ok": true}`;
  otherwise 409 `{"ok": false, "error": "too_late"}`. A `meeting_id` other
  than the live one answers 409 `meeting_changed`, and no recorder command
  runs.
- A deferred `record stop` the recorder does not acknowledge stays pending
  with `failed: n` and is sent again every 5 s; `last_stop` is set only once a
  stop succeeds. While `failed` is set the bar says the recording did not stop
  and offers Open the recorder and Stop, which tries the stop at once; Resume
  answers `too_late` (fix wave A3).
- A failed recorder command answers 500 `{"ok": false, "error":
  "stop_failed" | "resume_failed"}`; a failed resume keeps the pending stop.
  The cleared pending stop is written before `record resume` runs, so a
  restart never stops a resumed call. A state file that cannot be written
  never shows OS text: a resume answers `resume_failed` and sends nothing; a
  stop ends the recording at once (`until` null), since a pending stop a
  restart would forget leaves the recorder paused.
- `/api/state` gains `recording_control`:
  `{"stopping": {"meeting_id", "stopped_at", "until"} | null,
  "last_stop": {"meeting_id", "stopped_at"} | null}`. Plan 4 reads
  `last_stop` for "the recording stopped at".
- A stop with no undo window (a recorder that cannot pause) leaves `stopping`
  null and sets `last_stop`; the page shows "Recording stopped" from
  `last_stop` while the recorder still reports the call live.
- `/api/state` gains `heard_question`: `{"text", "speaker", "at"} | null`, a
  question from the other side not yet taken up by the analysis.
- Journal items of category `INCOMING_QUESTION` may carry `reply` (string): a
  line the person can say back.
- `POST /api/permissions/open` also accepts `"which": "sound_output"` (the
  system's sound output settings).

The undo window is 30 s, a builder timing the spec leaves open (spec "Left to
the builder"); the spec's "10 s" wording is kept with `{n}`. The `record pause`
verb (plan 3 Task 3) is the minimum native change the spec's own Resume needs,
despite the spec's non-goal "No native recorder changes".
