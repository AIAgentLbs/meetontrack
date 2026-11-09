# MeetOnTrack 0.1.25 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- The assistant opens in your default browser again (MEETONTRACK-140). Since
  0.1.23 it opened as a Microsoft Edge window, so Google sign-in and other
  links opened in Edge rather than in the browser where you are signed in. Now
  it opens as an app window of your default browser when that is Chrome, Edge,
  Brave, Vivaldi or Chromium, and as a normal tab of any other default
  browser. Edge is used only when Windows does not say which browser is the
  default.

Everything from 0.1.24 is included. The Capture recorder is rebuilt from this
revision.

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

Application source: `36c1d5304f1a83357c4f2b2dc5c19d8b004f74d7`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 42676493779](https://github.com/AIAgentLbs/meetontrack/actions/runs/42676493779),
`managed.zip` SHA-256 `d0e9f1d901b28088b2d426cb0b1a0eaa847828beeb5dbd0959685189d8f369f9`).
ZIP SHA-256: `aeb3fbd506635866fe3c1a7dec2eed88bf35097754f5c85f745398f1c183f143`.
The integrated package version is 0.1.25 (`0.1.25-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release; opening the assistant in the default browser was
checked by unit tests and the packaged installation check on a Windows build
machine, not on a real desktop. Making
the report PDF with Chrome and with Edge was checked on a Windows build machine
with a sample meeting, not on a real call. Test a short call and inspect both
sides before relying on a long recording. Fact checks come from the AI you
chose; open the source before relying on a verdict. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
