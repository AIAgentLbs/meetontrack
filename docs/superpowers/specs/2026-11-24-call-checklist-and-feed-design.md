# Call screen: checklist from the memo, timed feed, window kept on top

Status: direction chosen by the owner on 2026-11-24 (approach 1 below). Design
not yet approved: mockups come after the 2026-11-26 talk. Tracker:
MEETONTRACK-193. Builds on `2026-11-20-call-flow-redesign-design.md`.

## Intent

During a call the owner wants one narrow window beside the meeting app that
answers three things at a glance: what I planned to cover, what just came up,
and what is still open. Today the call screen shows one hint at a time. The
memo question appears only when nothing else is in the slot
(`copilot/web/call.js:131-141`), past hints hide under "Earlier" with a
relative age (`call.js:34`), the memo's risks are not on the call screen
before the call, and the window goes behind the meeting app.

## Goals

- Known before the call and heard during the call are two visibly separate
  things.
- The memo's questions and risks are a checklist that is on the call screen
  before recording starts and ticks itself as the call goes.
- What came up during the call is a feed stamped with the call minute, newest
  first, each item saying what to do about it.
- Two new nudges: "N questions still open" and "the talk left the agenda".
- The window can stay above other apps and is not visible to the other side
  in a screen share.
- One layout that works from 400 px wide (side window) to full width.
- 30/40 or more on the Impeccable critique in both themes and both languages.

## Non-goals

- No second window with its own UI. The side window is the call screen, narrow.
- No always-on-top or share-hiding on Windows in this cut (the web UI there
  runs in a browser; the layout change still applies).
- No change to the board after the call, the report, or delivery.
- No new AI provider or model choice.

## Anti-goals

- A feed that scrolls faster than a speaking person can read. Low-value hint
  kinds stay out, as today.
- A nudge with no evidence behind it, or a drift nudge that fires on small
  talk in the first minutes.
- A translucent window that hurts text contrast. "Semi-transparent" is a
  restrained window background, never see-through text.
- Any confirmation step, any new setting on the main or setup screen beyond
  one "keep on top" control.

## Constraints

- Same as the 2026-11-20 spec: AI work through `AIService`, strings in
  `translations.ru/en`, no inline styles (CSP), no real names in fixtures.
- Plan items already exist: `kind` in question, risk, objection and `status`
  in open, resolved, clarify (`copilot/web/call_plan.py:21-22`). Live analysis
  already closes them with `PLAN_UPDATE` (`copilot/web/server.py:2822-2834`).
  The checklist reads this; it does not add a second source of truth.
- The memo has at most 3 questions and 3 risks (`memo_writer.py:450-460`), so
  the checklist is at most 6 rows before anything is added by hand.
- The Mac window is a plain `NSWindow` with a `WKWebView`
  (`capture/Sources/meetingcopilot/UI/AssistantLink.swift:35-52`), minimum
  400 x 480, level never set.

## Approaches

1. **Rebuild the call screen as checklist plus feed; pin the same window on
   top.** One UI, narrow or wide. Native work is two window properties on the
   Mac. **Chosen by the owner 2026-11-24.**
2. **A separate small hint window next to the main one.** Two UIs showing the
   same data, twice the upkeep, and the reason approach 3 of the 2026-11-20
   spec was rejected.
3. **Add the checklist to today's screen, no pinning.** Cheapest, but the
   window still drops behind the meeting app, which is the owner's main
   complaint.

## Design

Top to bottom, single column, unchanged top bar (clock, "heard" indicators).

1. **Plan (known before the call).** Heading with a count, "Plan: 2 of 5
   open". Rows are the bound memo's questions, then risks, each with a status
   mark: open, covered, needs clarifying. A risk row is labelled as a risk and
   has no checkbox meaning "asked"; it is covered when the call addressed it.
   Covered rows collapse to one line at the bottom of the section. The owner
   can tick or untick a row by hand; a manual mark wins over the AI's.
   Shown as soon as a memo is bound to the next call, before recording.
2. **Now.** The current single hint slot with today's priority tiers
   (`call.js:83-157`), minus tier 4: the next memo question no longer needs the
   slot because the plan is always visible.
3. **Heard on this call.** The former "Earlier" list, open by default, each
   item prefixed with the call minute (mm:ss of the recording, not "2 min
   ago") and its kind. Same kinds as today plus the two nudges below. Capped
   at 20 items as today.

Nudges, both written into the feed and shown in "Now" once:

- **Still open.** Server-side, no AI call: when the scheduled end is 10
  minutes away (or at minute 20 when there is no end time) and plan questions
  are open, emit "N questions still open" listing them. Once per call.
- **Off the agenda.** A new optional line in the live analysis reply,
  `DRIFT {"minutes": n, "topic": "...", "evidence": "..."}`, allowed only when
  there is a plan, the call is past minute 5, and nothing from the plan or the
  goal was discussed for 5 minutes. At most one per 10 minutes. Thresholds are
  constants to tune after the first real calls.

Window (Mac): one control in the call screen's More menu, "Keep on top",
remembered in the config store. When on, the window level is floating while a
call is live and returns to normal after it. `sharingType = .none` is set
always, so the window is absent from screen shares and recordings of the
screen. Background uses the system's window material; text keeps full
contrast.

## Left to the builder

- Exact row and feed item layout, to be settled in mockups (narrow 400 px and
  wide), in both themes.
- Whether "Plan" collapses automatically when everything is covered.
- Wording of the two nudges in both languages.
- Whether `sharingType = .none` also hides the window from the app's own
  frame capture of the meeting window; if so, nothing changes, the app
  captures the meeting app's window, not its own.

## Review focus

- A call with no bound memo: no Plan section, feed and slot work as today.
- A memo bound after recording has started: Plan appears without a reload.
- AI marks a question covered, the owner unticks it: it must stay open.
- Long question text at 400 px wide, Russian and English.
- Keep-on-top with the meeting app in full screen on a second display.
