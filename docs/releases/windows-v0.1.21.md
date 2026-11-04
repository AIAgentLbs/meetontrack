# MeetOnTrack 0.1.21 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- If the app restarts between sending a report by email and sending it to
  Telegram, the email is no longer sent again (MEETONTRACK-122). Each channel's
  result is kept on disk right after its send; a send whose result is unknown
  is never repeated without your confirmation.
- The report PDF now tries both browsers: when Google Chrome is installed but
  cannot print, Microsoft Edge prints it. Only when neither can print does
  the report go out as an HTML file (MEETONTRACK-123).
- Until you choose an interface language in Settings, the web UI follows
  your browser's first preferred language: Russian for Russian, English
  otherwise (before, it was always Russian). A language you chose stays.
- Speaker corrections carry over to the final transcript in the last two rare
  cases: a meeting split from one recording whose boundary moved, and a revised
  final transcript whose lines moved. A line to check stays in the "check the
  speakers" ("проверьте спикеров") list in both (MEETONTRACK-121).

Everything from 0.1.20 is included. The Capture recorder is unchanged from
0.1.19. The Mac's move to one app with its own window is not part of the
Windows package yet (MEETONTRACK-113): on Windows the assistant still opens in
the browser.

Known: a final transcript that never arrives stops being flagged after three
days (MEETONTRACK-118). Whether the Windows recorder can use Antigravity for
its own tasks has not been checked yet (MEETONTRACK-106).

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

Application source: `1d50bf29d1ed4cafc90af2530a4b1544d4e7edd9`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 41877690861](https://github.com/AIAgentLbs/meetontrack/actions/runs/41877690861),
`managed.zip` SHA-256 `02922d3111ab4f5c36cc9263a7d53139bc343264ec49e861beaa1c68d7217dd9`).
Its sources are unchanged since 0.1.19.
ZIP SHA-256: `fd5a504102c24728055719e3c0cda5631dc7ba747ddb7fd4b84c1f1443b81a36`.
The integrated package version is 0.1.21 (`0.1.21-windows-beta.1`); its
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
