# Meeting Copilot by AI Agent Labs

Private, bot-free live meeting intelligence for macOS. Meeting Copilot captures
your microphone and system audio, keeps a live transcript on your Mac, and lets
Codex check what is being said against the Git repositories and documents you
already have locally.

> Beta. macOS 15+, Apple Silicon. The transcript and repository access remain
> local by default. Codex usage follows the authentication and policy of your
> installed Codex CLI.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/AIAgentLbs/meeting-copilot/main/install.sh | bash
```

Then approve **Microphone** and **Screen & System Audio Recording** when macOS
asks, and run:

```sh
meeting-copilot
```

The local interface opens at `http://127.0.0.1:43121`.

## What it does

- captures meetings without adding a bot to Zoom or Google Meet;
- updates a local near-live transcript with speaker separation where available;
- detects mixed meeting languages and shows an English translation next to
  non-Russian/non-English speech while preserving the original;
- searches up to 15 selected local GitHub or GitLab checkouts without cloning,
  pulling, or modifying them;
- surfaces facts, contradictions, history, risks, commitments, decisions and
  useful questions with file and commit provenance;
- saves manual notes with meeting timecodes, chat, links, services and frames;
- opens a private call map with preparation links and a live questions/risks/objections checklist when a scheduled call starts;
- produces local HTML/PDF meeting reports; optional Google Drive, email and
  Telegram delivery is retried after transient failures, and the UI shows
  recent unsent email reports. Email can include the PDF even if Drive fails.

## Privacy model

The web server binds only to `127.0.0.1`. Meeting media, transcript snapshots,
frames and reports are stored under `~/.local/share/meeting-copilot`; settings
and repository manifests are stored under `~/.config/meeting-copilot`. The
installer neither uploads repositories nor runs `git pull`, `fetch`, `clone`,
`checkout`, `reset`, `clean`, `commit` or `push`.
Language detection runs on the Mac. Translation sends only the relevant text
fragments through your authenticated Codex CLI, not raw audio.

## Call preparation

Copilot reads dated Markdown preparations directly from the selected active
repositories. A document needs `call_date: YYYY-MM-DD` near the top, a `#`
title, and a `## Опросник` or `## Questions` section with numbered questions.
It also extracts objections from `## Ответы на вопросы и возражения` and open
risks from unchecked boxes in `## Проверка перед встречей`. The source stays
in its repository: the product repository does not copy client material.
Copilot matches the preparation to the meeting date plus its title, attendee,
or meeting link. When the recorder exposes only a generic application title,
it can also read the primary Google Calendar through an existing authenticated
`gws` CLI session and match a single current event to the dated preparation.
That match is marked tentative in the UI; no calendar content is persisted by
the lookup. A relevant edit to the source is reflected on the next UI refresh.
If no matching preparation exists, the call proceeds without a map.

For calls whose capture title is generic (for example a browser helper), an
optional private schedule hint lives in
`~/.config/meeting-copilot/preparations.json` (mode `0600`). It can point to
the existing `source_file` under an active repository and add only missing
items or links. Example with synthetic data:

```json
{"version":1,"plans":[{"id":"sample-call","starts_at":"2026-10-01T10:00:00+02:00","title_aliases":["Sample demo"],"attendee_aliases":["Alex Sample"],"source_file":"/path/to/selected/repository/SALES_KIT.md","items":[{"id":"r1","kind":"risk","text":"Confirm access to the demo"}]}]}
```

For a scheduled hint, the map opens when a recording starts within two hours
of the scheduled time and the title or attendee matches. If capture only
reports a generic browser title and no attendee, a unique call within ten
minutes is shown as a **tentative time-only match** if calendar lookup is
unavailable or inconclusive. Each question, risk, and
objection has an open, resolved, or needs-clarification state. The progress
counter is resolved items divided by all items, not a subjective quality
rating. Automatic status changes require a direct quotation from the current
non-provisional transcript; manual changes take precedence. Statuses are
saved locally per recording, so ending a call does not clear its map.
Automatic updates run with live analysis while the interface is open.

## Repository layout

- `capture/` — native macOS audio capture and transcription application.
- `copilot/` — loopback-only UI, repository search and meeting archive.
- `docs/` — product site published with GitHub Pages.
- `install.sh` — idempotent macOS installer.

## Development

```sh
python3 copilot/web/server.py --self-test
swift build -c release --package-path capture
```

The AppKit UI test suite additionally requires a logged-in macOS GUI session.
Building the native app requires the macOS 26 SDK; the resulting app keeps a
macOS 15 deployment target.

The release package is built with `scripts/package-release.sh`. Never commit
recordings, transcripts, OAuth profiles, delivery credentials or repository
manifests.

## License

MIT. See [LICENSE](LICENSE) and [capture/THIRD-PARTY-NOTICES.md](capture/THIRD-PARTY-NOTICES.md).
