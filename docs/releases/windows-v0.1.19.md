# MeetOnTrack 0.1.19 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Meeting reports are now sent only from the final transcript. The quick
  transcript you see during the call is never sent. When a call ends, the
  report waits until the recorder has finished the final transcript of the
  whole call, then it is made and sent once. This also applies to automatic
  retries and to "Send again" ("Отправить снова"): a report printed earlier
  from the quick transcript is printed again from the final one first.
- If the final transcript is still missing an hour after the call, the
  meeting and the delivery header say so ("waits for the final transcript",
  "ждет итоговую расшифровку") and ask you to check that the recorder is
  running. Nothing is sent from the quick transcript; the report goes out by
  itself once the final transcript arrives.
- A recording split into several meetings now gives each meeting its own
  part of the final transcript, so each of them gets its report.
- Speakers you correct during the call carry over to the final transcript.
  Before, a correction made before the final transcript arrived kept the final
  transcript from being applied, and that report was never sent. Now the final
  transcript is always applied and each correction moves to the lines spoken
  at the same time. If some corrections cannot be placed with confidence, the
  meeting asks you to check the speakers ("check the speakers", "проверьте
  спикеров") and names how many lines.
- Fixes found in review: a report whose text changed after it was printed
  (for example after a late fact check) is printed again instead of waiting
  forever; a send whose result is unknown is never repeated without your
  confirmation.

Everything from 0.1.18 is included. The Capture recorder's code is unchanged;
it is now built together with the rest of MeetOnTrack and includes a newer
.NET 10 runtime update.

Known: a few rare cases of carrying speaker corrections are still open
(MEETONTRACK-119), and a final transcript that never arrives stops being
flagged after three days (MEETONTRACK-118). Whether the Windows recorder can
use Antigravity for its own tasks has not been checked yet (MEETONTRACK-106).

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

Application source: `cfcca5841ff0d4f2d8460a55fae03496c03641bf`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 41842727295](https://github.com/AIAgentLbs/meetontrack/actions/runs/41842727295),
`managed.zip` SHA-256 `b9be625f644357409ecce878e81b841db7110760eb184305d12c6674c05c0659`).
Its sources match the previous recorder `50e7448` except where it reads its
version file; the .NET runtime files moved from 10.0.13 to 10.0.14.
ZIP SHA-256: `24e623594dd7b54da4f4dc1df09643b53a2c976069a59a4922f4670915b2cd5f`.
The integrated package version is 0.1.19 (`0.1.19-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. Test a short call and inspect both sides before
relying on a long recording. Fact checks come from the AI you chose; open the
source before relying on a verdict. Local PDF/Office extraction and optional
screen OCR dependencies are not included. Speaker labels may need correction.
