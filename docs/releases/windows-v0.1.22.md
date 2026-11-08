# MeetOnTrack 0.1.22 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Nothing changes in how MeetOnTrack works on Windows. This package carries the
  same web assistant as MeetOnTrack 0.1.22 for Mac, so both platforms stay on
  one version. Its changes are for the Mac: quitting the Mac app now also stops
  an AI tool sign-in that is still open (MEETONTRACK-124) and helpers started
  in the first moment after its service starts (MEETONTRACK-126); on Windows
  the service is stopped directly, as before.

Everything from 0.1.21 is included. The Capture recorder is unchanged from
0.1.19.

Known: on Windows the assistant still needs its usual local address to be
free. If another program already uses it, the assistant does not start and
says so; the Mac app resolves this itself since 0.1.22, Windows does not yet
(MEETONTRACK-131). The Mac's move to one app with its own window is not part
of the Windows package yet (MEETONTRACK-113): on Windows the assistant still
opens in the browser. A final transcript that never arrives stops being
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

Application source: `f5e1cb8871a403cab46d265c055767a29620f29e`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 42467360827](https://github.com/AIAgentLbs/meetontrack/actions/runs/42467360827),
`managed.zip` SHA-256 `a5a23f53b8cf740e501c1009b4dd1996432875d2e7ac5ed8f133774b5d6247a2`).
Its sources are unchanged since 0.1.19.
ZIP SHA-256: `a1844362701c7f28632a1d662e752ece60d88cbaafd222f93a22d31d9287747e`.
The integrated package version is 0.1.22 (`0.1.22-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. Making the report PDF with Chrome and with Edge was
checked on a Windows build machine with a sample meeting, not on a real call.
Test a short call and inspect both sides before relying on a long recording.
Fact checks come from the AI you chose; open the source before relying on a
verdict. Local PDF/Office extraction and optional screen OCR dependencies are
not included. Speaker labels may need correction.
