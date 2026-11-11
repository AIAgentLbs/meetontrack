# MeetOnTrack 0.1.29 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- After an update from inside the app, one assistant window stays open (the
  open one reloads into the new version) and the recorder stays in the tray
  instead of opening its window (MEETONTRACK-144).
- Updating from inside the app is safer (MEETONTRACK-143): only one update runs
  at a time and none replaces a newer version; a recorder that crashed no
  longer holds an update back; an update set to run after the call survives a
  restart of the assistant.
- Changing the language or the update notice in Settings no longer stops the
  page from reloading into a new version.

Everything from 0.1.28 is included. The Capture recorder is rebuilt from this
revision; its sources are unchanged since 0.1.26, and it now carries the .NET
10.0.15 runtime (was 10.0.14).

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
to the AI you chose.

On 0.1.26 to 0.1.28, use the Install button. Otherwise finish the call and close
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

Application source: `338995391222fca217641954f018371aa7b197da`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 43045443424](https://github.com/AIAgentLbs/meetontrack/actions/runs/43045443424),
`managed.zip` SHA-256 `d5b7c66184675d92d44749d53a7f70f13f19532cde3a6d670e507ef45737d36e`).
ZIP SHA-256: `a92665bff8cd6a5e6aa3ca93d15cd37cc646a995e4fd45a9a286bd444d7926ef`.
The integrated package version is 0.1.29 (`0.1.29-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release; the in-app update was checked by unit tests and the
packaged installation check on a Windows build machine, not on a real
desktop. Installing this version from 0.1.28 with the Install button is its
real check. Making
the report PDF with Chrome and with Edge was checked on a Windows build machine
with a sample meeting, not on a real call. Test a short call and inspect both
sides before relying on a long recording. Fact checks come from the AI you
chose; open the source before relying on a verdict. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
