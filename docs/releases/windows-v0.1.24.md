# MeetOnTrack 0.1.24 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- Calls now get their final transcript and report (MEETONTRACK-136). The
  recorder saved its final transcript in a form the assistant could not read,
  so on Windows every finished call waited for a final transcript that never
  arrived, and no report was made or sent. The recorder now saves it in the
  plain form and the assistant reads both. Calls already recorded with an
  earlier version are picked up the first time the updated assistant starts;
  nothing needs to be done by hand.
- An automatic recording no longer runs on for hours after the call
  (MEETONTRACK-137). When a call app such as Chrome kept the microphone after
  the call and the room was not quiet, the recording never stopped. Now an
  automatically started recording stops once there has been no call audio for
  the time set in "Stop after silence on both tracks" (10 minutes by default),
  however much the microphone hears. A paused recording counts as sound and is
  not stopped. Recordings you start yourself are never stopped this way.
- Getting started lists only the AI tasks that cannot work, or work with a
  limit, with your AI choice, instead of every task.

Everything from 0.1.23 is included. The Capture recorder is rebuilt from this
revision.

Known: on Windows the assistant still needs its usual local address to be
free. If another program already uses it, the assistant does not start and
says so; the Mac app resolves this itself since 0.1.22, Windows does not yet
(MEETONTRACK-131). The assistant window is an Edge window, not part of the
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
The installer verifies the package checksum. No automatic installer is enabled.

## Build identity

Application source: `41fa12ac7b6ce5b535b26a0c8bfb591d8c505619`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 42646757653](https://github.com/AIAgentLbs/meetontrack/actions/runs/42646757653),
`managed.zip` SHA-256 `4cd2fd321745f479949bf59d24194cf4f0148bfa4718678488b7e1c9e6c136a0`).
ZIP SHA-256: `8ae7ce7cbf63dd6cf1e67090b4e39e276d615ba50faaf47791cdb65376192ff9`.
The integrated package version is 0.1.24 (`0.1.24-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release; the final transcript import and the automatic stop
without call audio were checked by unit tests and the packaged installation
check on a Windows build machine, not on a real desktop or a real call. Making
the report PDF with Chrome and with Edge was checked on a Windows build machine
with a sample meeting, not on a real call. Test a short call and inspect both
sides before relying on a long recording. Fact checks come from the AI you
chose; open the source before relying on a verdict. Local PDF/Office
extraction and optional screen OCR dependencies are not included. Speaker
labels may need correction.
