# MeetOnTrack 0.1.26 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Updates install from the app (MEETONTRACK-142). When a newer version is
  published, the header shows "Version X available" with an Install button.
  It downloads that exact release from GitHub with the official installer,
  which checks the package checksum, and reopens MeetOnTrack. During a call
  the update waits until the call ends. If it fails, the old version keeps
  working and the notice offers Try again; the details are in `update.log`.
  The button arrives with this version, so updating to 0.1.26 itself still
  takes the command below.
- The recorder closes its audio files whatever went wrong while stopping
  (MEETONTRACK-139). A recording that grew past the 4 GB limit of a WAV file
  left `mic.wav` open, and the final transcription found it locked until
  Capture was closed.
- Turning on email or Drive delivery no longer reports meetings from before
  it was turned on as overdue (MEETONTRACK-141).

Everything from 0.1.25 is included. The Capture recorder is rebuilt from this
revision.

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

Finish the call and close Capture before installing or updating:

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

Application source: `5465905331a782c47f067da190689fb6e39e6ead`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 42777308992](https://github.com/AIAgentLbs/meetontrack/actions/runs/42777308992),
`managed.zip` SHA-256 `3472c0870dcc56c2573ee325655f1bae1d380531f78758af37e4e3a5622b08bb`).
ZIP SHA-256: `b25bab718b458e8aed8402f9d520e8f9f464f60df62c4b420424103a05aca526`.
The integrated package version is 0.1.26 (`0.1.26-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release; the in-app update and closing the audio files were
checked by unit tests and the packaged installation check on a Windows build
machine, not on a real desktop or a real call. The first real in-app update
is the one from 0.1.26 to the next version. Making
the report PDF with Chrome and with Edge was checked on a Windows build machine
with a sample meeting, not on a real call. Test a short call and inspect both
sides before relying on a long recording. Fact checks come from the AI you
chose; open the source before relying on a verdict. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
