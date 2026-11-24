# MeetOnTrack 0.1.38 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- A memo you send to your own address now arrives in your inbox as unread,
  with the usual notification (MEETONTRACK-188). Gmail used to file it as
  already read, so it was easy to miss. The app's own Google sign-in now
  also asks for permission to change labels; until you sign in again, such
  a memo is still sent but may arrive as read.
- A memo e-mail that fails to send is sent again automatically, up to 3
  times. Only if that still fails does Home name the meeting, say what went
  wrong and offer Send again (MEETONTRACK-189). One memo that keeps failing
  no longer holds the others back.
- After you stop a recording while the calendar event is still running,
  the app no longer shows a false red "not recording" alarm
  (MEETONTRACK-191). If a new recording starts in the same event and then
  goes quiet, the warning still appears.

Everything from 0.1.36 is included. The Capture recorder is rebuilt from this
revision. The recording safeguards of this release (the microphone watchdog,
the warning when the other side is silent, the menu bar alerts and the
automatic second transcription) are in the Mac recorder only.

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

On 0.1.26 to 0.1.36, use the Install button. Otherwise finish the call and close
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

Application source: `0ae06b1396effa5767af77af91c1cd0ebea751af`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 45276666570](https://github.com/AIAgentLbs/meetontrack/actions/runs/45276666570),
`managed.zip` SHA-256 `de861b52d3e2f4858ef5d7a02efedcaaa998d936c1d12f7f1e4ee170ae91e929`).
ZIP SHA-256: `93416abe18300b251c655349bebb2bddbb3987410cf0870762cbdd00fddcb37a`.
The integrated package version is 0.1.38 (`0.1.38-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The memo e-mail changes were checked by tests,
not on a real Windows machine. Test a short call and inspect both
sides before relying on a long recording. Memos and fact checks come from the
AI you chose; open the source before relying on them. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
