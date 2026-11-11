# MeetOnTrack 0.1.30 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Optional Twenty CRM integration (MEETONTRACK-146). In Settings → Report
  storage and delivery → Twenty CRM, enter the CRM address and an API key; the
  key is kept encrypted with Windows DPAPI. Until both are saved, nothing
  about the CRM appears in the app.
  - Before and during a call the AI sees the attendees' CRM records: person,
    company, open deals (stage, next step, close date, never the amount) and
    the last note titles. They stay in memory for 10 minutes and are not saved
    with the recording.
  - After the call one note per meeting goes to the matched open deal, company
    or person: decisions, agreements and open questions, not the transcript.
    The deal's `nextStep` is set from the agreements when the deal has that
    text field.
  - When the record is not clear (several deals, no match), the report asks
    you to choose one; nothing is written before that, and the choice is
    remembered for the same attendee, company domain or recurring meeting.
  - A stage change is only proposed ("Move to X") from your workspace's own
    stages and happens only on that click.
  - Amounts, prices, payment, contract and licence terms are left out of the
    note by default; a switch in the CRM settings turns this off. The note
    says how many lines were withheld.

Everything from 0.1.29 is included. The Capture recorder is rebuilt from this
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
to the AI you chose. The CRM, when set up, receives only the meeting note
described above.

On 0.1.26 to 0.1.29, use the Install button. Otherwise finish the call and close
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

Application source: `c7800ddf2999695e5cba25b97b5deec0be77a2e4`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 43077416951](https://github.com/AIAgentLbs/meetontrack/actions/runs/43077416951),
`managed.zip` SHA-256 `62d7b9820c04f72a56424d2d459e3cbc86cc86f7418683615bdec3be077bea32`).
ZIP SHA-256: `a81568631679b412275847a94a2ac83ea0ae5d5d02135f7bff902b21ce5f939a`.
The integrated package version is 0.1.30 (`0.1.30-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The CRM integration was checked by unit tests and
once against a live Twenty workspace, both on a Mac; it shares the code with
the Mac app but has not been used from Windows yet. Making
the report PDF with Chrome and with Edge was checked on a Windows build machine
with a sample meeting, not on a real call. Test a short call and inspect both
sides before relying on a long recording. Fact checks come from the AI you
chose; open the source before relying on a verdict. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
