# MeetOnTrack 0.1.23 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- The assistant now has one window of its own (MEETONTRACK-133). Opening it
  from the Start menu shortcut, the tray menu or after setup brings an open
  assistant window forward, restoring it when it was minimized, instead of
  adding a new browser tab each time. When none is open, it opens in a
  Microsoft Edge app window without a tab strip; without Edge it opens in your
  default browser as before. The page now shows the MeetOnTrack icon. After an
  update the open page reloads itself to the new version, unless you have
  typed something in it; then reload it yourself when you are done.
- A terminal window no longer flashes up every few minutes (MEETONTRACK-134).
  The programs the assistant starts in the background, such as the AI tool's
  periodic check, now run without a window. The AI tool sign-in still opens
  its own window, as it needs your input.

Everything from 0.1.22 is included. The Capture recorder is rebuilt from this
revision.

Known: on Windows the assistant still needs its usual local address to be
free. If another program already uses it, the assistant does not start and
says so; the Mac app resolves this itself since 0.1.22, Windows does not yet
(MEETONTRACK-131). The assistant window is an Edge window, not part of the
Capture recorder itself as on the Mac (MEETONTRACK-113). A final transcript
that never arrives stops being flagged after three days (MEETONTRACK-118).
Whether the Windows recorder can use Antigravity for its own tasks has not
been checked yet (MEETONTRACK-106).

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

Application source: `0c65e7ae67d1b190bc756d2b247bf1f11747f37b`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 42625266256](https://github.com/AIAgentLbs/meetontrack/actions/runs/42625266256),
`managed.zip` SHA-256 `4e163408d5631e86337853388d67928b5e14664385e77f611b8d68a639fe97e3`).
ZIP SHA-256: `932405f4d17c6ad4bee807951629d7f2422b9bc058520852fcbece795f5f4404`.
The integrated package version is 0.1.23 (`0.1.23-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release; the one-window behavior and the hidden helper
windows were checked by unit tests and the packaged installation check on a
Windows build machine, not on a real desktop. Making the report PDF with Chrome
and with Edge was checked on a Windows build machine with a sample meeting, not
on a real call. Test a short call and inspect both sides before relying on a
long recording. Fact checks come from the AI you chose; open the source before
relying on a verdict. Local PDF/Office extraction and optional screen OCR
dependencies are not included. Speaker labels may need correction.
