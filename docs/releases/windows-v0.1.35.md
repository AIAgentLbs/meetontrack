# MeetOnTrack 0.1.35 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Home shows your calendar through the app's own Google sign-in
  (MEETONTRACK-183). Until now Home, the memo writer and the call memo read
  the calendar only through a separately installed Google command-line tool,
  so with only the app's Google sign-in connected Home showed no meetings.
  Now the app's sign-in is used whenever it is connected; the command-line
  tool is used only when there is no app sign-in. When the app's sign-in
  needs reconnecting, Home asks you to reconnect instead of reading another
  account, and meetings shown for one account never appear after switching
  to another. A slow or interrupted Google answer leaves the day unavailable
  for a moment and is retried; it does not sign you out and does not slow the
  window down.

Everything from 0.1.34 is included. The Capture recorder is rebuilt from this
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

On 0.1.26 to 0.1.34, use the Install button. Otherwise finish the call and close
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

Application source: `1cef073b6c2b2b891dcd7a05ec7874094c998e71`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 45175391852](https://github.com/AIAgentLbs/meetontrack/actions/runs/45175391852),
`managed.zip` SHA-256 `cdb42821152064b4376bbecea37bae32ebf2847b01e0bf96b3defa2bafe9d382`).
ZIP SHA-256: `6f5e94de64e05d5c67fe58b9312b5bb0ba66b179c4b1e4d540da4fda8e6ce343`.
The integrated package version is 0.1.35 (`0.1.35-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The calendar change was checked by tests and on the
Mac build, not on a real Windows machine. Test a short call and inspect both
sides before relying on a long recording. Memos and fact checks come from the
AI you chose; open the source before relying on them. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
