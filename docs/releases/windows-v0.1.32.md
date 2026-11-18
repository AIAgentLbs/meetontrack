# MeetOnTrack 0.1.32 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- The Capture window has an "Open MeetOnTrack assistant" button; until now
  the assistant opened only from the tray menu or the Start menu shortcut.
- Settings has its own Install button next to the release offer, with the
  install progress, even when the notice at the top was dismissed or muted;
  the PowerShell command is folded below it (MEETONTRACK-156).
- Report delivery: two delivery libraries were updated to fix five published
  security advisories (oauthlib 4.0.1, pyasn1 0.6.5).

Everything from 0.1.31 is included. The Capture recorder is rebuilt from this
revision; its sources changed since 0.1.31.

Known: the assistant window is a browser window, not part of the Capture
recorder itself as on the Mac (MEETONTRACK-113). The Windows recorder does not
use your AI choice for its own tasks yet, so Antigravity is not available to
it (MEETONTRACK-106). Telegram delivery cannot be set up on Windows yet
(MEETONTRACK-135).

The speech recognition choice from the Mac release is not available on Windows
yet (MEETONTRACK-69). Getting started says so, and the Windows recorder keeps
transcribing with its local speech models as before.

Fact checking sends the checked statement to the AI you chose; knowledge base
excerpts go only to its call without web access. The CRM, when set up,
receives only the meeting note.

On 0.1.26 to 0.1.31, use the Install button. Otherwise finish the call and close
Capture before installing or updating:

```powershell
irm https://meetontrack.com/install.ps1 | iex
```

Version 0.1.10 and 0.1.11 do not show this update in the app: the project's
GitHub address changed, and those versions reject release pages at the new
address. Run the command above once. Version 0.1.12 and later check the new
address.

Recordings, model data and settings live outside the versioned app directory.
The installer verifies the package checksum. Nothing installs by itself: the
Install button or the command above starts it.

## Build identity

Application source: `107f2c7d3e80b75e2df3041fe97083640e6175e5`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 44335346073](https://github.com/AIAgentLbs/meetontrack/actions/runs/44335346073),
`managed.zip` SHA-256 `f9e89f3ca00213256b701cda7c492fa9c319e370c69a138718dea9557c59d528`).
ZIP SHA-256: `478c96f2ebcdc416b922f2c0c57f1730a4f085a31ffa60c1b78c38afb1a9c06f`.
The integrated package version is 0.1.32 (`0.1.32-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The Open MeetOnTrack assistant button and the
Settings Install button were checked by build and tests only, not on a real
Windows machine. Making the report PDF with Chrome and with Edge
was checked on a Windows build machine with a sample meeting, not on a real
call. Test a short call and inspect both sides before relying on a long
recording. Fact checks come from the AI you chose; open the source before
relying on a verdict. Local PDF/Office extraction and optional screen OCR
dependencies are not included. Speaker labels may need correction.
