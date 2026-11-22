# MeetOnTrack 0.1.34 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

The assistant is redesigned around one call: Home before it, the Call view
during it and the After view once it ends.

- Home (MEETONTRACK-161). Today's and tomorrow's calendar meetings, each with
  two or three lines of its memo and where they came from. When the calendar
  is not connected, there are no meetings or a memo is not ready yet, Home
  says so instead of showing an empty page.
- The app writes the memo itself (MEETONTRACK-164). For meetings today and
  tomorrow with people from outside your own mail domain, the AI you chose
  prepares the pre-call memo ahead of time from the sources you connected:
  local folders, past reports, earlier calendar meetings and the CRM. A
  button rebuilds it. Without a chosen AI, Home asks you to choose one.
- The Call view (MEETONTRACK-162). One feed with a single large hint, "heard"
  or "not heard" for each side of the call, hints that fade with the earlier
  ones in a drawer, a "question heard" state, and the transcript behind a
  toggle. Stop recording (Alt+Shift+E) pauses at once and ends the recording
  for good after 30 seconds; Resume recording within those 30 seconds
  continues the same recording.
- The After view (MEETONTRACK-163). Before the report leaves you see who gets
  it on each channel, can edit the summary and next steps, hold it or send it
  now, and see the call checked against its memo. The report carries your
  edits and is sent 30 seconds after it appears or after your last change,
  unless you hold it.
- Calmer app chrome (MEETONTRACK-165): at most three controls in the top bar
  plus a menu, panels open over the page, one call status, Settings regrouped,
  keyboard order and border contrast fixed.
- When an automatic start fails and microphone access is denied, the banner
  says the recording did not start; a click opens the microphone privacy
  page.

Everything from 0.1.33 is included. The Capture recorder is rebuilt from this
revision; its sources changed since 0.1.33 so that Stop and Resume work for
one call at a time. The new assistant needs this recorder, and both are in
this package.

Known: the Windows recorder does not report per-side audio activity yet, so
"heard" relies on the transcript; silence is never shown as "not heard". The
assistant window is a browser window, not part of the Capture recorder itself
as on the Mac (MEETONTRACK-113). The Windows recorder does not use your AI
choice for its own tasks yet, so Antigravity is not available to it
(MEETONTRACK-106). Telegram delivery cannot be set up on Windows yet
(MEETONTRACK-135). Calendar attendee names do not reach the report yet, and
there is no preview of how recipients will see the report (MEETONTRACK-179,
180).

The speech recognition choice from the Mac release is not available on Windows
yet (MEETONTRACK-69). Getting started says so, and the Windows recorder keeps
transcribing with its local speech models as before.

The memo is written from the meeting's calendar details and matching
excerpts of the sources you connected; the check after the call sends the
transcript and the memo. Both go only to the AI you chose, without web
access. Fact checking sends the checked statement to the AI you chose;
knowledge base excerpts go only to its call without web access. The CRM, when
set up, receives only the meeting note.

On 0.1.26 to 0.1.33, use the Install button. Otherwise finish the call and close
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

Application source: `194b48c5e95be3d7eb572c332f24304868dc8359`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 45064826795](https://github.com/AIAgentLbs/meetontrack/actions/runs/45064826795),
`managed.zip` SHA-256 `9a885e4cb51c2a3f0b6d76caf6d2424c32ffca56392115fd7940655893b8b01b`).
ZIP SHA-256: `6225b9711a4ccc5505fac276baa6a06c2733b7b3b28ec24331a447b0688893e2`.
The integrated package version is 0.1.34 (`0.1.34-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The new screens were checked by tests and on the
Mac build; the recorder's Stop and Resume by its own tests and the packaged
install check, not on a real Windows machine. Test a short call and inspect
both sides before relying on a long recording. Fact checks and memos come from
the AI you chose; open the source before relying on them. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
