# MeetOnTrack 0.1.28 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Released together with the Mac fix for updating from inside the app
  (MEETONTRACK-142). Nothing changes for Windows users: updating with the
  Install button already worked from 0.1.26 to 0.1.27. On 0.1.27 the header
  shows "Version 0.1.28 available" with an Install button.

Everything from 0.1.27 is included. The Capture recorder is rebuilt from this
revision; its sources are unchanged since 0.1.26.

Known: on Windows the assistant still needs its usual local address to be
free. If another program already uses it, the assistant does not start and
says so; the Mac app resolves this itself since 0.1.22, Windows does not yet
(MEETONTRACK-131). The assistant window is a browser window, not part of the
Capture recorder itself as on the Mac (MEETONTRACK-113). A final transcript
that never arrives stops being flagged after three days (MEETONTRACK-118).
Whether the Windows recorder can use Antigravity for its own tasks has not
been checked yet (MEETONTRACK-106). Telegram delivery cannot be set up on
Windows yet (MEETONTRACK-135).

The speech recognition choice from the Mac release is not available on Windows
yet (MEETONTRACK-69). Getting started says so, and the Windows recorder keeps
transcribing with its local speech models as before.

Fact checking sends the checked statement and matching knowledge base excerpts
to the AI you chose.

On 0.1.26 or 0.1.27, use the Install button. Otherwise finish the call and close
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

Application source: `03d0bf5d21f34889d530db01a76b4d1a02c39d51`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 42790096646](https://github.com/AIAgentLbs/meetontrack/actions/runs/42790096646),
`managed.zip` SHA-256 `f1f1d914efffa3a1f3604ee343eea761b2c23cf67e17d5bf0a198f129efaf2b1`).
ZIP SHA-256: `47de4af8c3d26f3063901b59fd3624f9f49cda0b31bfe602208a96cb4bd8c753`.
The integrated package version is 0.1.28 (`0.1.28-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release; the in-app update was checked by unit tests and the
packaged installation check on a Windows build machine, not on a real
desktop. Installing this version from 0.1.27 with the Install button is its
real check. Making
the report PDF with Chrome and with Edge was checked on a Windows build machine
with a sample meeting, not on a real call. Test a short call and inspect both
sides before relying on a long recording. Fact checks come from the AI you
chose; open the source before relying on a verdict. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
