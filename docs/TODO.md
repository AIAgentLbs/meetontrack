# Meeting Copilot delivery follow-up

## Simultaneous live registers — 2026-09-30

- Installed default call overview: questions to ask, incoming/general meeting
  questions, and risks/objections are visible simultaneously. Desktop gives
  roughly 28% width to the transcript and 72% to the assistant. Each register
  scrolls independently and keeps its position during updates.
- Preparation joins the same registers. Open, clarification and closed states
  use traffic-light colors plus text; manual changes persist per meeting.
  Online updates require quoted current speech and preserve manual decisions.
- User questions to Copilot never become incoming meeting questions. Incoming
  questions require captured speech; unknown direction is explicitly general.
- Evidence/source details are collapsed for scanning; materials remain
  accessible. RU/EN, keyboard focus and narrow-screen priority are supported.
- Verified: 51 Python tests, server self-test, JS syntax, isolated browser
  status/RU/EN/desktop/mobile checks, inspected desktop/laptop/mobile renders.
  Impeccable's detector reported four pre-existing thick accent borders in
  legacy transcript/preparation/chat components; the new registers use thin
  separators and add no such accents. See `docs/live-call-map.md`.
- Automatic capture and closure run with the existing analysis cadence;
  a forced analysis of the last captured call produced one quoted general
  question, closed two ASK items and marked one risk for clarification.
  This proves the live integration path, not general classification accuracy.

## Meeting-scoped speaker editor — 2026-09-27

- Names opens a compact participant/utterance editor in the live view and
  archived meetings. Clicking a transcript speaker opens the same editor.
- Renaming a voice updates every existing and future turn with that stable
  voice ID in this meeting only. Manual names override screenshot/ASR names.
- Selected utterances can be reassigned to an existing participant or a new
  person. This fixes merged/wrong-channel turns without falsifying the source
  audio channel or rewriting the original words.
- User corrections overwrite speaker fields in the canonical private
  `meeting.json`. No separate correction file or edit history is stored.
  Capture refresh preserves those corrections and applies renamed voice IDs to
  new turns. Live view, filters, clipboard, archive, Copilot context and generated
  HTML/PDF all use this corrected original. Previously sent memos are not resent.
- Verified: 38 Python tests including real HTTP rename/reassignment,
  canonical-file readback, stale/live refresh and report refresh without memo
  delivery; source/installed self-tests and JavaScript syntax pass. Installed
  browser editor opens with 153 turns and no JavaScript errors. Real missing
  audio still requires manual assignment; the editor is not proof of automatic
  voice recovery.
- Real audio loss is not a voice ID. If local acoustic separation cannot
  distinguish people, those turns require explicit assignment rather than
  mapping every unknown turn to a fabricated common speaker. Screenshot names
  establish the roster, not the speaker of every utterance; 99% identity accuracy
  is not verified and must not be promised.

## Speaker attribution and compact transcript — 2026-09-27

- Installed: repeated name-chip evidence from Teams frames can name a single
  remote voice; unrelated browser tabs and conflicting names are rejected.
- Installed: transcript rows use 5 px vertical padding, 1.32 line height and
  timestamps in the speaker column, keeping more dialogue visible.
- Installed: bounded system-audio tap recovery for output-route changes,
  stalled callbacks and sustained digital silence while call output is active.
  Recording files stay open across recovery; route format changes are converted.
- Audio loss is preserved in live/archive metadata and shown in UI/reports.
  Microphone speech during the loss is marked unverified rather than confidently
  assigned to the owner. Missing remote audio cannot be recovered from text.
- Verification: Python regression tests, JavaScript syntax, server self-test,
  release build, installed app signature/permissions and real browser rendering.
  Standalone Swift health-policy checks pass (`scripts/capture-health-smoke.swift`).
- Remaining acceptance: a new live call with a mid-call output-device switch
  must prove both tracks continue and names stay correct. Existing captured
  audio proves the old failure, not successful live recovery. Full Swift tests
  are blocked by this Command Line Tools installation lacking the Testing module.

## Repository meeting history

Requested: after a meeting ends, identify the relevant selected GitHub/GitLab
repository and save a concise meeting history there.

Do not copy the same meeting to every active repository. The current fallback
scope means "search all selected repositories", not "publish to all". Some
meetings have no matching project alias; some projects map to multiple repos.

Acceptance criteria:

- Use the meeting's explicit project/repository choice first. Automatic routing
  is allowed only for one unambiguous project and explicitly permitted private
  destination repositories. Otherwise show a pending routing choice.
- Save a reviewed, project-specific brief under `docs/meetings/` with meeting ID,
  date, decisions, actions and links to the local full report. Never publish raw
  audio, screenshots, transcripts, chat, credentials or a report containing
  unrelated client details.
- Keep private deal economics out of repositories other than the allowlisted
  financial repositories. Do not infer or distribute private amounts.
- Make writes idempotent by meeting ID, show per-repository status in meeting
  history, and verify the remote GitHub/GitLab revision after push. Never claim
  completion from local Git state alone.
- Owner confirmed on 2026-09-25: automatic writes are permitted only to
  verified private repositories for an unambiguous project; ambiguous meetings
  stay pending for selection. The local GitHub and GitLab command-line clients
  currently lack push/API credentials, so unattended publication remains off
  until both the private-visibility check and a real remote push/readback pass.
- Evaluate [Laya](https://github.com/NandhaKishorM/laya) as an optional local
  candidate scorer for one or more repos. It must not independently authorize
  publication: validate on labelled meeting-to-repo examples, calibrate the
  multilingual model, then apply the private-repo and ambiguity gates above.

## Google delivery

The application retries unsent reports and shows recent failures in the UI.
`gog` OAuth is still absent, but the user's existing authorized `gws` client now
serves as a fallback for Gmail and Drive. A completed report from 2026-09-25
was uploaded and delivered through this path, including Telegram and Drive
links. Automatic retries are limited to the most recent three days; older
pending reports need a duplicate check against Sent mail before any backfill.
