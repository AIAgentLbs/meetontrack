# MeetOnTrack 0.1.20 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Windows now sends meeting reports. Before, Windows could not make the PDF
  report, so no report was made or sent (MEETONTRACK-120). The PDF is now
  printed by Google Chrome or, when Chrome is not installed, by Microsoft
  Edge, which comes with Windows.
- A meeting report is no longer lost when its PDF cannot be made. If neither
  browser can make the PDF, the report still goes out by email and Telegram as
  a single HTML file with a short note. The meeting and the delivery header
  say "The PDF was not created" ("PDF не создан"), and the app tries the PDF
  again every 30 minutes. Once the PDF is made it is uploaded to Google Drive,
  if you turned Drive on, and the email is not sent again. Drive only ever
  receives the PDF. Only the final transcript is ever sent, as in 0.1.19.
- "Send again" ("Отправить снова") and the automatic retries also work for a
  report that has only the HTML file.
- Speakers you correct during the call carry over to the final transcript in
  more cases: when the final transcript joins a corrected line with its
  neighbour, in meetings split from one recording, and when a corrected part
  of a line is small. Names you still have to place, and lines still to check,
  stay in the "check the speakers" ("проверьте спикеров") list until you deal
  with them, also after the final transcript is revised. English translations
  of unchanged lines are kept.

Everything from 0.1.19 is included. The Capture recorder is unchanged from
0.1.19.

Known: two rarer cases of carrying speaker corrections remain, in split
meetings whose boundary moved and in a revised final transcript whose lines
moved (MEETONTRACK-121). If the app restarts between sending the email and
sending to Telegram, the email can be sent again (MEETONTRACK-122). A final
transcript that never arrives stops being flagged after three days
(MEETONTRACK-118). Whether the Windows recorder can use Antigravity for its
own tasks has not been checked yet (MEETONTRACK-106).

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

Application source: `aedbff899f1de43628cc16b2cb7a5ed5a2a2dd39`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 41865457069](https://github.com/AIAgentLbs/meetontrack/actions/runs/41865457069),
`managed.zip` SHA-256 `c5a8a02cfe5592f45f8f2b792efd18e3c8ef7d18afbac501dc804330a8b162c7`).
Its sources are unchanged since 0.1.19.
ZIP SHA-256: `94ea0e5d1e6eb63fdfea43dca607bbb0fe793ac48eb2648033c419edecd80845`.
The integrated package version is 0.1.20 (`0.1.20-windows-beta.1`); its
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
