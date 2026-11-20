# MeetOnTrack 0.1.33 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- The assistant's state refresh no longer slows down with many stored
  meetings (MEETONTRACK-160): stored speaker screen readings are matched once
  per meeting and speaker instead of on every refresh. The slowdown was seen
  with Zoom speaker readings on the Mac; the same web service ships here.
- Call memo before and after the call (MEETONTRACK-159). The Preparation tab
  shows the full pre-call memo as plain text and an "Open memo document" link
  when the memo has one. Preparation notes named `*-prep.md` are picked up
  when they are dated by `call_date:`, `date:` or the date at the start of the
  file name. Between calls the tab lists today's and tomorrow's calendar
  meetings with their memo, or "No memo". In the library a meeting shows its
  memo and, when its report was delivered to Google Drive, links to the Drive
  folder and the report files. The screens keep their current layout; the
  redesigned memo screens come in a later release.

Everything from 0.1.32 is included. The Capture recorder is rebuilt from this
revision; its sources are unchanged since 0.1.32.

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

On 0.1.26 to 0.1.32, use the Install button. Otherwise finish the call and close
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

Application source: `06cd585466a7fc6b597ce44fd0015c09206efc3f`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 44804542573](https://github.com/AIAgentLbs/meetontrack/actions/runs/44804542573),
`managed.zip` SHA-256 `74fd746fb117e486626373ea60602acabc7de2ef2c28136d2f4dbe557861248e`).
ZIP SHA-256: `27a97f325c97636ce9a87b5edeee6b3909616d54ab71a182218334d0bcd761ad`.
The integrated package version is 0.1.33 (`0.1.33-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The memo display and the faster state refresh were
checked by tests and on the Mac build, not on a real Windows machine. Test a
short call and inspect both sides before relying on a long recording. Fact
checks come from the AI you chose; open the source before relying on a
verdict. Local PDF/Office extraction and optional screen OCR dependencies are
not included. Speaker labels may need correction.
