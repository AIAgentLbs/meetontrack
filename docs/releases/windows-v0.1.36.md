# MeetOnTrack 0.1.36 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Home shows your calendar again when Google is connected through a named
  Google profile (MEETONTRACK-186). In 0.1.35 the calendar used the
  Google command-line tool's default profile instead of the personal or work
  profile chosen in Settings, so Home said the calendar could not be read and
  showed no meetings. It now reads through the chosen profile, the same one
  reports are delivered with; if that profile's tool is missing, Home says so
  instead of reading another account. Without a chosen profile Home offers to
  connect Google, as before. The app's own Google sign-in from 0.1.35 is
  unchanged.

Everything from 0.1.35 is included. The Capture recorder is rebuilt from this
revision; its sources are unchanged since 0.1.34.

Known: a few calendar sign-in states are still worded loosely, for example a
hint about the command-line tool when no sign-in is connected
(MEETONTRACK-184). The Windows recorder does not report per-side audio
activity yet, so "heard" relies on the transcript. The assistant window is a
browser window, not part of the Capture recorder itself as on the Mac
(MEETONTRACK-113). The Windows recorder does not use your AI choice for its
own tasks yet, so Antigravity is not available to it (MEETONTRACK-106).
Telegram delivery cannot be set up on Windows yet (MEETONTRACK-135). Calendar
attendee names do not reach the report yet, and there is no preview of how
recipients will see the report (MEETONTRACK-179, 180).

The speech recognition choice from the Mac release is not available on Windows
yet (MEETONTRACK-69). Getting started says so, and the Windows recorder keeps
transcribing with its local speech models as before.

The calendar is read from Google with your own sign-in and stays on this
computer. The memo is written from the meeting's calendar details and
matching excerpts of the sources you connected; the check after the call
sends the transcript and the memo. Both go only to the AI you chose, without
web access. The CRM, when set up, receives only the meeting note.

On 0.1.26 to 0.1.35, use the Install button. Otherwise finish the call and close
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

Application source: `d44a1f0606074702915010ef2be3604db8cadc38`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 45188247464](https://github.com/AIAgentLbs/meetontrack/actions/runs/45188247464),
`managed.zip` SHA-256 `8cc2e7c3b626ec8aac35b0f7589dc66dcf30918b8205ffad6e97486813bf1163`).
ZIP SHA-256: `a40d6744dab10f0061265f632080fe28cfa767dd5e751f0f28f131d422f9339e`.
The integrated package version is 0.1.36 (`0.1.36-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The calendar fix was checked by tests and on the
Mac build, not on a real Windows machine. Test a short call and inspect both
sides before relying on a long recording. Memos and fact checks come from the
AI you chose; open the source before relying on them. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
