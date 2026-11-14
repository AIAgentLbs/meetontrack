# MeetOnTrack by AI Agent Labs

Private, bot-free live meeting intelligence for macOS. MeetOnTrack captures
your microphone and system audio, keeps a live transcript on your Mac, and lets
an AI tool you already have check what is being said against the Git
repositories and documents you already have locally.

> Technical beta. macOS 15+, Apple Silicon. Audio/transcript files are stored
> locally; AI analysis can send relevant dialogue and repository excerpts to
> the AI tool you chose for that task. Usage follows that tool's account, plan
> and policy.

## Install

Project page: [English](https://meetontrack.com/) ·
[Русский](https://meetontrack.com/ru/).
The command currently installs the checked, pinned **v0.1.31** package, not
unreleased features from `main`. It requires Apple Silicon, macOS 15+, no separate Python or Apple SDK. AI is optional; you choose the tool and model once, for every task. Google Chrome
(or Microsoft Edge or Chromium) makes the PDF reports; without one, reports are sent as HTML. Quit Capture before reinstalling.

v0.1.31 is one app: the Swift app (rebuilt for this release) with its Python and web payload inside, and a
source/hash manifest. It is ad-hoc signed, not notarized; update notifications are included. See [release notes](docs/releases/v0.1.31.md) for scope and gates.

```sh
curl -fsSL https://meetontrack.com/install.sh | bash
```

MeetOnTrack is one app: it carries its own Python and web assistant, runs the
local service itself and shows the assistant in its own window. The installer
opens it after checking that the service is ready. On first launch confirm the
interface language (preselected from your Mac: Russian for a Russian Mac,
English otherwise), approve **Microphone** and **Screen & System Audio
Recording** and finish model setup. No second terminal command is needed.
Reopen the assistant anytime with **Open MeetOnTrack assistant** at the top of
the recorder window or in its menu-bar menu.
See [INSTALL.md](INSTALL.md) for dependencies, first-run permissions, manual
updates and troubleshooting. From 0.1.26 an **Install** button
installs new releases in-app. Audio/transcription run locally; AI analysis can send relevant transcript
and repository excerpts to the AI tool you chose for that task.

## What it does

- uses an AI tool you already have - Codex, Claude Code or a local Ollama.
  In Getting started you choose the tool, model, reasoning effort and speed
  once, and every AI task uses that choice; the options are read from the
  installed tool and your plan, and nothing is preselected. A task the chosen
  model cannot do is shown unavailable with the reason, and nothing else is
  affected: screenshots are analysed only when the model accepts images, and
  Git repository search needs Codex or Claude Code (Ollama cannot read
  repositories). Antigravity runs with its own strict settings (no files, no
  commands): no repository search or screenshots. The Mac recorder uses it for
  meeting summaries and speaker names; the Windows recorder does not yet.
  Recording and local transcription work without any AI tool;
- captures meetings without adding a bot to Zoom or Google Meet;
- updates a local near-live transcript with speaker separation where available;
- detects mixed meeting languages and shows an English translation next to
  non-Russian/non-English speech while preserving the original;
- searches up to 15 selected local GitHub or GitLab checkouts without cloning,
  pulling, or modifying them;
- surfaces facts, contradictions, history, risks, commitments, decisions and
  useful questions with file and commit provenance;
- saves manual notes with meeting timecodes, chat, links, services and frames;
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
fragments to the AI tool you chose for live translation, not raw audio.

## Repository layout

Repository scope: end-user application software, installers/updates, tests and
user documentation. The website [meetontrack.com](https://meetontrack.com/),
analytics, SEO, comparisons and marketing are maintained in a separate website
repository. See `AGENTS.md` for the boundary.

- `capture/` — native macOS audio capture and transcription application.
- `windows/` — native Windows recorder (C#/.NET, derived from Amanu); built and
  accepted by `.github/workflows/windows-candidate.yml`.
- `copilot/` — loopback-only UI, repository search and meeting archive.
- `docs/` — application documentation, verification records and release notes.
- `install.sh` — idempotent macOS installer.
- `scripts/windows/install.ps1` — Windows installer used by packaging and CI.

Website pages, comparison/SEO research and analytics live only in the website
repository. The website keeps its published installer snapshot; application
installer development stays here.

## Development

```sh
python3 copilot/web/server.py --self-test
swift build -c release --package-path capture
```

The Windows recorder (on Windows, .NET 10 SDK):

```powershell
dotnet test windows/tests/Amanu.Core.Tests/Amanu.Core.Tests.csproj -c Release
dotnet publish windows/src/Amanu.App/Amanu.App.csproj -c Release -r win-x64 --self-contained true -o managed
```

The AppKit UI test suite additionally requires a logged-in macOS GUI session.
Building the native app requires the macOS 26 SDK; the resulting app keeps a
macOS 15 deployment target.

The release package is built with `scripts/package-release.sh`. Never commit
recordings, transcripts, OAuth profiles, delivery credentials or repository
manifests.

## License

MIT. See [LICENSE](LICENSE), [capture/THIRD-PARTY-NOTICES.md](capture/THIRD-PARTY-NOTICES.md)
and, for the Windows recorder, [windows/LICENSE](windows/LICENSE) and
[windows/THIRD-PARTY-NOTICES.md](windows/THIRD-PARTY-NOTICES.md).
