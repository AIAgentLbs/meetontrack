# Install MeetOnTrack

Download and installation: https://meetontrack.com/.
Russian page: https://meetontrack.com/ru/.

## Mac

Apple Silicon, macOS 15 or later. Capture, Python and helper executables are
included in the package. No compiler, SDK or separate Python is required.

```sh
curl -fsSL https://meetontrack.com/install.sh | bash
```

The command installs the checksum-pinned v0.1.30 archive. Read
[install.sh](install.sh) before running it if desired. An existing installation
must finish its call and quit Capture first. The installer checks again before
replacement and puts the previous version back if replacing the files fails.

1. On first launch, confirm the interface language. It is preselected from your
   Mac: Russian when macOS's first preferred language is Russian, English
   otherwise. Switch it there with one click, or later in Settings.
2. Approve Microphone and Screen & System Audio Recording for MeetOnTrack in
   macOS settings. Existing installation paths keep the legacy Capture filename.
3. Complete local speech-model setup. Recording and transcription need no paid
   AI key or AI tool account.
4. MeetOnTrack is one app. It runs its local assistant service itself and shows
   the assistant in its own window, not in a browser. Completing setup opens it.
   Reopen it anytime with **Open MeetOnTrack assistant** at the top of the
   recorder window or in the MeetOnTrack menu-bar menu. Closing the window keeps
   recording and analysis running from the menu bar; quitting the app stops
   both. Links to other sites (sign-in pages, Google Drive, PDFs) open in your
   browser. No second terminal command is required.
5. Make a short test call and check both sides in the transcript before relying
   on a long meeting. Speaker names can need correction.

The package is a technical beta, ad-hoc signed and not Apple-notarized. If macOS
blocks it, review the exact app in Privacy & Security. Keep Gatekeeper enabled.
Google Chrome, Microsoft Edge or Chromium makes the PDF report; without one, the report is sent as an HTML file.

## Windows

Windows 11 24H2 or later, x64. Use PowerShell:

```powershell
irm https://meetontrack.com/install.ps1 | iex
```

The ready-to-run archive includes Capture, .NET, Python and the web assistant.
No compiler or SDK is required. The first setup downloads checksum-verified
local speech models (approximately 1.5 GB). Keep SmartScreen and antivirus
enabled. Finish the call and close Capture before reinstalling.

## Optional AI and context

AI answers use an AI tool you already have: Codex, Claude Code or a local
Ollama. In Getting started, choose the tool, model, effort and speed once;
every AI task uses that choice. The options are read from the installed tool
and your plan, and nothing is preselected. Check AI runs a short test for each
task with that choice. A task the chosen model cannot do is shown unavailable
with the reason, and the other tasks keep working: screenshots are analysed
only when the model accepts images. Relevant
conversation and connected-source excerpts are sent to the chosen AI service. Capture
and local transcription work independently of the AI account.
Git repository search works only with Codex or Claude Code; Ollama cannot read
repositories. Antigravity runs with its own strict settings (no files, no
commands), so it cannot read repositories or screenshots either, and the
recorder cannot use it yet for meeting summaries and speaker names.

Connect local folders in Context sources; Git is optional. Current local formats
are UTF-8 text, Markdown, CSV and source code. Google context is optional and
configured separately in Settings. General local PDF/Office retrieval is not
included in this release.

## Optional report delivery

Settings lets you enable email reports, Google Drive and each delivery channel
separately. Leave them off to keep reports locally.

- SMTP: enter your provider's host, TLS mode, username and app password. Check
  the connection, choose the recipient, enable email and save.
- Google: create your own Desktop OAuth client in your Google Cloud project,
  enable the APIs you need and import its downloaded JSON in Settings. Follow
  the in-app instructions, then sign in to your account. MeetOnTrack does not
  provide a shared Google OAuth application. Connecting does not enable delivery.

Secrets are kept in macOS Keychain or Windows DPAPI. Native usage statistics
have been removed. Delivery errors and manual retry actions are shown in the
assistant. See [delivery setup](docs/DELIVERY.md) for detailed instructions.

## Update

A newer published version shows "Version X available" with an **Install** button.
It installs that release from GitHub and reopens MeetOnTrack; during a call it
waits until the call ends. Checks run at startup and every 15 minutes while
online; they can be disabled. The installer preserves recordings, settings and
model data. If the button fails, Settings has the installation command as a
fallback: finish the call, quit Capture and run it. An unexpected
filesystem/permission failure during replacement may require the
preserved backup. See [updates](docs/UPDATES.md).

## Local files and support

Mac settings: `~/.config/meeting-copilot`. Recordings, reports and the service
log (`server.log`): `~/.local/share/meeting-copilot`. Python and the web
assistant are inside the app. Updating from 0.1.20 or earlier removes the old
background service and its separate Python/web copies; recordings, archive,
models and settings are kept. The installer never modifies connected repositories.

Windows application versions: `%LOCALAPPDATA%/MeetingCopilot/versions`.
User settings and recordings are outside that application version directory.

For no-audio failures, check permissions on the actual installed application
and selected devices, then reopen Capture. For no PDF, check Chrome or Edge. If you
report a problem, include OS, version and a redacted error at
https://github.com/AIAgentLbs/meetontrack/issues. Do not upload private
recordings, transcripts, OAuth JSON or delivery credentials.
