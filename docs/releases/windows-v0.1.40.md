# MeetOnTrack 0.1.40 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- When the sources you connected mention the people in a meeting but give
  nothing to prepare from, Home says nothing was found instead of showing a
  failed memo (MEETONTRACK-201). If the meeting already had a memo, that memo
  stays. A reply from the AI that cannot be read is still retried once.

Everything from 0.1.38 is included. The Capture recorder is rebuilt from the
same `windows/` sources (see Build identity). The other two fixes of this
release, keeping a recording going when the other side's audio drops out
mid-call and naming speakers who share one voice line by line
(MEETONTRACK-207, 206), rely on the Mac recorder's audio-loss signal and
call-window pictures and change nothing on Windows yet.

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

On 0.1.26 to 0.1.38, use the Install button. Otherwise finish the call and close
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

Application source: `b49530d90e86615b373994776d591ed692961bfd`.
Native recorder: built from this repository's `windows/` at `30fa6da36b7f124fdf362c612bd4ce11b1b234be`
(unchanged since; [windows-candidate run 45973003597](https://github.com/AIAgentLbs/meetontrack/actions/runs/45973003597),
`managed.zip` SHA-256 `86667074616b4ef73868c81d7d77a79b7c529bb69358099bfc73cbe0d66e68b7`).
ZIP SHA-256: `2d12085e826117d5e9bb4816bff80f7c649ebc775a04dacc5e9f6da9d0865334`.
The integrated package version is 0.1.40 (`0.1.40-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The memo change was checked by tests, not on a real
Windows machine. Test a short call and inspect both sides before relying on a
long recording. Memos and fact checks come from the AI you chose; open the
source before relying on them. Local PDF/Office extraction and optional screen
OCR dependencies are not included. Speaker labels may need correction.
