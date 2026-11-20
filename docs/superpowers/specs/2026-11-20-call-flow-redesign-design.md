# Call flow redesign: before, during and after a call

Status: draft for owner approval, 2026-11-20. Tracker: MEETONTRACK-161 (home),
162 (call screen), 163 (after the call), 164 (the app writes the memo),
165 (app chrome). Target: all five accepted by 2026-11-24.

## Intent

MeetOnTrack helps a person run a conversation, not only record it. Today the
web UI does not show that. It opens on a board that is empty until a call
starts, the pre-call memo sits in a tab, the call screen has no sign that
speech is being heard, and the report leaves without showing who receives it.
An audit of 0.1.32 scored the UI 24/40 on the Impeccable critique (minimalism
1 of 4) with five P1 problems, all in the chrome. The owner's bar is a very
clean, clear interface: every screen at 30/40 or more.

The redesign follows the three moments of a call. Before: what is coming and
what to remember. During: one thing to say next. After: what was agreed and
who gets it.

## Goals

- The first screen answers "what is my next call and what do I need to know".
- During a call one hint is readable at a glance while speaking.
- The person can always see that both sides are being heard.
- The memo appears by itself; nobody asks for it.
- The report shows its recipients before it leaves, without adding a
  confirmation step.
- Every screen scores 30/40 or more on the Impeccable critique, with a strong
  minimalism score, in both themes and both UI languages.

## Non-goals

- No native recorder changes. The heartbeat uses signals the web server
  already has.
- No floating always-on-top hint window.
- No search across the archive of past transcripts.
- No sending of the memo to Telegram or e-mail in this cut (see "Later").
- No change to speech, AI provider or delivery adapters.

## Anti-goals

- A confirmation dialog on any routine action (start, end, send).
- A memo or a "check against the memo" line with no source behind it.
- A fixed AI provider, model or mode anywhere in code.
- Any real meeting title, person or client name in the repository, tests,
  fixtures or screenshots.

## Constraints

- AI work goes through `AIService` and the one `ai.choice`
  (`copilot/web/ai_providers.py`). A new task is a new entry in `PURPOSES`;
  when the choice cannot do it, the UI shows the reason.
- One settings store: `~/.config/meeting-copilot/config.json`. Generated data
  is not a setting and stays in the existing data files.
- Web UI is shared by Mac and Windows; nothing here is platform specific.
- UI strings live in `translations.ru` / `translations.en` (`app.js`); the page
  CSP forbids inline styles.
- Keep what the audit said must survive: the four-column board, the transcript
  with inline translation, the delivery-error block, the palette in both
  themes, text labels on controls, the speaker editor.

## Approaches

1. **Restyle the current two-pane layout.** Keep tabs and panes, clean the
   chrome. Cheapest. It leaves the call screen as four columns of small text,
   which is the part nobody can read while speaking, so it cannot reach the
   bar.
2. **Three views over the same data, switched by call state.** Home when no
   call is live, a single feed during a call, the board after it. Same
   endpoints, same polling, new rendering and a small amount of new server
   work. **Chosen** (owner decisions of 2026-11-20: single feed during the
   call with the board after it; the app writes the memo; the check against
   the memo is built now).
3. **A separate compact hint window.** Closest to the "coach" products, but it
   needs native work on two platforms and cannot land by 2026-11-24.

## The three views

The view follows state: no live call shows Home; a live call shows Call; a
call that ended shows After until the person leaves it. The person can open
any of them by hand.

### Home (MEETONTRACK-161)

```
Today
  14:00  Title of the meeting              Counterpart name, company
  in 40 min
         Goal of the call, one line.
         - Question to ask
         - Question to ask
         - Question to ask
         One line of background.           Open memo   3 sources
                                           Do not record this call
  16:30  Title of the meeting              Counterpart name
         Memo is being prepared...
Tomorrow
  10:00  Title of the meeting              Nothing about this contact in
                                           your sources yet
```

- Source: `GET /api/agenda` (today and tomorrow) and the plan payload
  (`memo_markdown`, `has_memo`). `renderAgenda` and `memoNodes` already exist
  in the Preparation tab and move here.
- Each row shows time, title, the attendees other than the user, and one of:
  the memo digest with a source count, "being prepared", "nothing found", or
  the reason the memo could not be made.
- The memo digest answers "what to remember" in five seconds: the goal of the
  call in one line, up to three questions to ask, and at most one line of
  background. Never a block of prose. The server returns it as its own
  fields. A memo the app wrote carries them explicitly; for a picked-up
  `-prep.md` the goal is the memo's goal paragraph (or its first summary
  line) and the questions are the first plan items of kind question
  (author's call, after the first critique found a 70-word block unreadable).
- The time left until the next call is prominent on its row.
- "Nothing found" is not a dead end: it offers Connect a source, which opens
  the Sources settings.
- The next call's row has a quiet "Do not record this call". Recording
  otherwise starts by itself.
- Empty states, each with one action at most: calendar not connected (Connect),
  calendar tool missing (how to get it), no meetings today or tomorrow.
- Past meetings stay one click away (the existing library).

### Call (MEETONTRACK-162)

```
  00:12:40   You: heard   Other side: heard                         End

      Question heard: "..."

      Ask who signs off on the budget this year.
      From the memo, question 2

  Earlier (4)                                   Transcript   Board
  [ Ask anything about this call...                              ]
```

- One current hint in 22-24 px type with one line saying where it comes from.
  Nothing else on the screen competes with it.
- The hint is something to say or ask, not a fact to interpret ("Ask: why
  X when your own estimate is Y?"), in one clause of eight words or fewer,
  readable in under two seconds while speaking. The reasoning and the quote go into the source
  line. This is a rule for the AI prompt and is enforced on output: a longer
  hint is cut to its first clause (author's call, after the first critique
  measured a 20-word hint at 4-5 s).
- The single slot is filled in this order: an answer to a question put to the
  user; a contradiction with the memo or a failed fact check; a risk or
  objection; the next memo question not yet covered. Data: `journal`,
  `call_plan.items`, `fact_checks`, `copilot.analysis` in `/api/state`.
- A "memo question" is a plan item of kind question in `call_plan.items`, with
  the live status the plan already tracks. Both picked-up and app-written
  memos produce such items (author's call).
- A hint stays about 20-30 s or until replaced, then moves to "Earlier".
- While an analysis is running after a question to the user, the screen says
  the question was heard, with the question text, before the answer arrives.
- Heartbeat: two labelled marks, "You" and "Other side". Each is derived from
  `recording_health.capture.tracks[]` (file growth per source) and the time of
  the last transcript segment per source. Silence is neutral; a track that
  stopped growing or a `system-audio-lost` warning is a visible problem with
  words, not only colour.
- The transcript and the four-column board open on demand and close back to
  the feed. No per-hint triage buttons.
- End sits at the far end of the top bar, away from the status marks. It
  stops the call at once and the bar shows "Call ended - Undo" for about
  10 s. No dialog.
- The recording mark is a filled dot in the accent colour with the words
  "Recording" in every layout; the error colour stays reserved for problems
  (author's call: one reviewer read grey as "off", another objected to error
  red). The timer shows minutes and seconds. One vocabulary for audio everywhere: heard, not heard.
- One vocabulary for the end of a call on every screen: the control is "End
  recording", the state after it is "Recording stopped" with "Resume
  recording" for those 10 s; the After view says when the recording stopped.
  This replaces "End" and "Call ended - Undo" above (author's call, after the
  second critique found three wordings for one event).
- Narrow window: at 480-600 px (the app beside a video call) the hint wraps
  and stays the largest thing, the status marks stack or shorten, and the
  dock is the ask field plus one "More" (past hints, transcript, board).
  Home and After reflow to one column under about 700 px; nothing is clipped
  at 400 px.
- The source line under the hint shows its first line only; the rest opens
  on demand.
- Quiet key hints on the ask field, "End recording" and Send. They are an aid
  for regular users, never the only way to reach a control.

### After (MEETONTRACK-163)

```
  Title of the meeting, 42 min              Report goes when it is ready  Hold
  To: e-mail address   Telegram chat   CRM record name

  Summary (editable)             Next steps (editable)

  Against the memo: 4 answered, 2 open, 1 differs

  Questions to ask   | Questions to me | Risks and objections | Fact check
  Open: ...          |                 |                      | Differs: ...
  Open: ...          |                 |                      |
  4 answered (show)  |                 |                      |
```

- The four-column board becomes the main view, with the summary and next
  steps editable in place.
- Recipients are shown per channel from the delivery settings before anything
  leaves. Sending stays automatic. Delivery waits on several things
  (`_ready_for_delivery`: final transcript, analysis rebuild, capture stopped,
  120 s after the end), so the screen shows a plain state, not a timer:
  "being prepared", "goes when the final transcript is ready", "sent".
  Edits made before sending are included; after sending, an edit offers Send
  again, which updates the existing CRM note instead of adding a second one.
  No confirmation dialog.
- The control is worded "Do not send", with the line "goes only when you press
  Send". It stops every channel of that one report until the person presses
  Send. It is stored with the report, survives a restart, and never sends by
  itself afterwards. Delivery retries skip a held report (author's call).
  States shown: waiting, held, sent per channel, edited after sending.
- The automatic send waits while a summary or next-steps field has focus and
  says so; it resumes when the field is left (author's call, after the
  second critique: a report must not leave mid-edit).
- Column names are generic, so they read right for any call: "Ask the other
  side", "Asked of you", "Risks and objections", "Fact check". A differing
  statement names the speaker and the meeting on both sides.
- Fewer frames: recipients are one line inside the send block with Change
  always present, the summary and next steps are frameless fields with one
  shared note, no side stripes anywhere, and board items are list rows separated
  by hairlines, not cards.
- "Against the memo" is not a separate list: nothing appears twice. One
  explaining line sits under the board heading ("what was said on the call,
  checked against the memo"); there is no line of counts, the status tags
  carry them. The summary holds facts only: questions live on the board and a
  deadline appears in one place. The "Questions to ask" column shows the
  memo questions with their status, open ones first and answered ones folded
  into one expandable line; statements that differ from earlier notes appear
  only in the fact-check column, under one word for that idea. Each answered
  or differing item carries a quote and a time. One AI run per
  meeting that has a memo, when the final transcript is ready, as a new task
  in `PURPOSES`; stored in `report.json` and included in the report. Without a
  memo the block is absent. The run happens while the report is created, with
  its own timeout; if it fails or runs out of time the report goes without the
  block and the screen says why. It is never a reason to delay delivery beyond
  that timeout (author's call).
- Calendar attendees of the matched event are written to the meeting's
  `participants.json` (read today by `archive.py`, written by nothing), so the
  report, the CRM note and later memos carry names.
- One-time backfill, no AI: for stored meetings of the last 90 days, when
  exactly one calendar event overlaps the recording, its attendees are written
  the same way. Ambiguous cases are left alone (author's call).

## The app writes the memo (MEETONTRACK-164)

- A background loop, in the style of the existing loops in `server.py`, looks
  at the agenda for today and tomorrow. For each meeting with at least one
  attendee outside the user's own e-mail domain and no memo, it prepares one.
  Internal and solo events are skipped. The user's domain comes from the
  `self` attendee. When it is a public mail domain, any other attendee counts
  as outside, and no company is derived from such a domain (author's call).
- A meeting is identified by its calendar event id, which the calendar read
  must start fetching (`calendar_meetings.py`). Each instance of a recurring
  event has its own id; a rescheduled event keeps its id and its memo.
- Timing: a meeting is prepared as soon as it is inside that window, so the
  day's memos are ready in the morning when the app has been running, and a
  call added later is prepared at once. About two hours before the start the
  sources are checked again and the memo is rebuilt only if they changed.
  A Rebuild control exists per meeting; nothing else is manual.
- Sources: connected folders (`LocalContext`), CRM reading (`TwentyContext`),
  the calendar history, and past reports matched by attendees. Search words
  come from the event itself (attendee names, company from the e-mail domain,
  title), not from an AI planner.
- No sources found means no AI run: the meeting says nothing is known yet.
- Output: a plan in the shape `CallPlans` already accepts (`_valid` in
  `call_plan.py`: items with ids and kinds, plus `memo_markdown`), keyed by
  the calendar event id, with the provider and model that wrote it, the time,
  and a signature of the sources. Three lines first, then questions to ask,
  then sources; every line names its source.
- Storage: the app's own file in its data directory, written atomically and
  read by `CallPlans` as a third source. `preparations.json` stays untouched:
  the app has never written it and other tools may (author's call).
- Past reports are matched by attendees when the meeting has
  `participants.json`, otherwise by title words.
- A `-prep.md` file or a `preparations.json` plan matched to the same meeting
  always wins; the app never overwrites either.
- Spend guard: one run per event and source signature, one run at a time,
  none while a call is live.

## App chrome (MEETONTRACK-165)

- Top bar: Home, the call status with its one control, and a menu. Everything
  else (settings, meeting context, getting started, updates, swap panels)
  goes into the menu. Refresh is removed if polling covers it.
- Settings, library and context open as overlays; the call never moves
  off-screen.
- One call status, from one source of truth.
- Settings grouped in plain words: AI, Speech, Sources, Delivery; developer
  terms go under Advanced, closed by default.
- Transcript speaker controls come after the main content in tab order;
  borders reach 3:1 contrast.

## Acceptance

- Each of Home, Call and After is reviewed by an independent Impeccable
  critique in a real browser render, both themes, RU and EN, and scores 30/40
  or more. Findings of P0 and P1 are fixed before the next view starts.
- Each view is shown to the owner as a real render with its score when it is
  ready, not at the end.
- New Python tests for: external-meeting detection, memo dedupe by event and
  signature, pickup precedence, `participants.json` writing, the "against the
  memo" record. New Playwright scripts for the agenda and memo states, the
  call feed states (hint, question heard, track lost) and the send countdown.
- The existing suite stays green.

## Order

165 and 161 first (the frame and the first screen), then 162, then 164, then
163. If time runs short, the "Earlier" drawer and the deeper regrouping of
settings are the first things to slip; the heartbeat and the single hint are
not.

## Later

- Sending the memo as a PDF to the user's Telegram at a set time (owner wish
  of 2026-11-20; his own pipeline already does this outside the app).
- Audio level per channel from the native recorder for a truer heartbeat.

## Left to the builder

Exact timings and thresholds, both languages' wording, the drawer and overlay
mechanics, and how the after-call view is left.
