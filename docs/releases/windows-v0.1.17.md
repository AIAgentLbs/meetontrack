# MeetOnTrack 0.1.17 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- When the AI service is briefly overloaded, MeetOnTrack no longer says that
  your AI account limit is reached. It now says: "The AI service is busy and
  turned the request away for now. This is not your plan limit. Retry in a
  minute." ("Сервис ИИ сейчас перегружен и временно отклоняет запросы. Это не
  лимит вашего тарифа. Повторите через минуту." in Russian). The limit message
  appears only when the plan limit or credit is really used up.
- In the meeting report, the time of every phrase and every screenshot is
  your local time, the same as in the report header. Before, they were shown
  in UTC and could differ from the header by an hour or more. A meeting
  started with "Start new meeting" ("Начать новую встречу") is also titled
  with your local time.
- Ordinary phrases such as "I'm sure" or "I'm going" are no longer taken as
  someone introducing themselves, so words like "sure" no longer appear as a
  participant's name.

Everything from 0.1.16 is included. Two other changes are part of the Mac
release only: the installer cleanup of extra app copies, and starting a new
meeting by itself when the call changes within one recording (it needs the
sound-dropout signal that the Windows recorder does not report yet). On
Windows, use "Start new meeting" ("Начать новую встречу") when one recording
covers two calls.

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

Application source: `6d81643a85388e81ae46f597a5c480850d821fd6`.
Native source: `50e7448c880538ab96b57e093b4f7214a7a51de0`
([recorder run 39649348946](https://github.com/AIAgentLbs/meetontrack-recorder/actions/runs/39649348946)).
ZIP SHA-256: `686897a8e788cf18ea876cc095e8751ad5a2955f457b9a5cf6bb2656d5527e93`.
The integrated package version is 0.1.17; its independently versioned native
component retains 0.6.6. The web update checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. Test a short call and inspect both sides before
relying on a long recording. Fact checks come from the AI you chose; open the
source before relying on a verdict. Local PDF/Office extraction and optional
screen OCR dependencies are not included. Speaker labels may need correction.
