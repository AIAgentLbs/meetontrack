# MeetOnTrack 0.1.18 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Signing in to an AI tool no longer needs a command. When Codex, Claude Code
  or Antigravity is installed but signed out, or rejected its saved sign-in,
  Getting started and the red banner show "Sign in to <tool>" ("Войти в
  <tool>"). Codex and Claude Code open their sign-in in the browser;
  Antigravity opens it in its own console window. The app notices when the
  sign-in is done, even while that console is still open, and checks the AI
  again. When a provider rejects its saved sign-in, the message now says so
  ("needs a new sign-in: it rejected the saved one") instead of showing the
  provider's raw error.
- Antigravity can now be chosen as the AI. It runs with its own strict
  settings: no files, no commands, web pages only for tasks that search the
  web. It cannot search Git repositories or read screenshots.
- If the AI fails during a meeting (for example, its sign-in expired), the
  meeting's analysis is no longer lost. Once the AI works again, MeetOnTrack
  builds the missing analysis from the stored transcript by itself, never
  while a call is being recorded. It retries after 5 minutes, then waits
  longer each time, up to 2 hours, and tries at once after Check AI. A past
  meeting in the archive also has a "Rebuild analysis" ("Построить разбор")
  button. Long meetings are analysed in parts of the same size as during the
  call, parts already analysed are not sent again, and a rebuild does not
  create a report or send email. If the transcript changes later, the button
  is offered again.
- Fixes found in review: Antigravity refuses to answer while its sign-in link
  still points to a previous Google account; a call waiting for another
  Antigravity call counts that wait against its own time limit.

Everything from 0.1.17 is included. Whether the Windows recorder can use
Antigravity for its own tasks has not been checked yet (MEETONTRACK-106).

The speech recognition choice from the Mac release is not available on Windows
yet (MEETONTRACK-69). Getting started says so, and the Windows recorder keeps
transcribing with its local speech models as before.

Fact checking sends the checked statement and matching knowledge base excerpts
to the AI you chose.

Finish the call and close Capture before installing or updating:

```powershell
irm https://meetontrack.com/install.ps1 | iex
```

Version 0.1.10 and 0.1.11 do not show this update in the app: the project's
GitHub address changed, and those versions reject release pages at the new
address. Run the command above once. Version 0.1.12 and later check the new
address.

Recordings, model data and settings live outside the versioned app directory.
The installer verifies the package checksum. No automatic installer is enabled.

## Build identity

Application source: `805b4d55d13564cce9e2500b6e51d810a781d97c`.
Native source: `50e7448c880538ab96b57e093b4f7214a7a51de0`
([recorder run 39649348946](https://github.com/AIAgentLbs/meetontrack-recorder/actions/runs/39649348946)).
The recorder files are byte-identical to the 0.1.17 package.
ZIP SHA-256: `5c905c0626b1e70c55d450deae4ae8079bb0ac6be13bdb506fb07b3de01eef53`.
The integrated package version is 0.1.18 (`0.1.18-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. Test a short call and inspect both sides before
relying on a long recording. Fact checks come from the AI you chose; open the
source before relying on a verdict. Local PDF/Office extraction and optional
screen OCR dependencies are not included. Speaker labels may need correction.
