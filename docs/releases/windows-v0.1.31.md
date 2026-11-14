# MeetOnTrack 0.1.31 for Windows

Technical beta for Windows 11 24H2+, x64. Capture, .NET, Python and the web UI
are included; no compiler or SDK is required. Initial setup downloads local
speech models. AI answers are optional and use an AI tool you already have.

- The recorder labels speakers You and Others (Вы and Остальные in Russian),
  as on the Mac; saved files are unchanged. Speaker naming no longer has its
  own AI setting: it uses the same AI as the summary, and is off when
  summaries are off (MEETONTRACK-83).
- If another program already uses the assistant's usual local address
  (port 43121), the assistant now starts on a free port and the tray opens
  it there, as the Mac app does (MEETONTRACK-131).
- The tray's "Check for updates" item, which could never find an update, is
  gone; updates come through the assistant's Install button
  (MEETONTRACK-81).
- Claude Code needs version 2.1.304 or later; an older one is shown as
  unavailable with a hint to update (MEETONTRACK-6).
- Ollama: Chinese, Japanese, Korean and emoji text is sized correctly for the
  model's context, and long chats keep the session rules and drop older
  meeting snapshots first (MEETONTRACK-8, MEETONTRACK-50).
- Live translation: its status updates on screen when it changes, and "choose
  an AI" or "unavailable" stays visible until a translation actually works
  (MEETONTRACK-51, MEETONTRACK-52). A "translation" that only repeats the
  original line is no longer stored or shown, including ones saved by earlier
  versions (MEETONTRACK-64).
- Report delivery: older repaired reports keep their status and Send again
  button, and a resend still in progress at its deadline says it may not have
  arrived (MEETONTRACK-93). If the final transcript arrives late, the report
  that never went out is now sent automatically, and the waiting notice stays
  until then (MEETONTRACK-118).
- Fact checking checks your knowledge base excerpts (Gmail, Drive, context
  folders) in a separate call without web access; the web search step
  receives only the statement (MEETONTRACK-128).
- Reading context from your repositories no longer runs commands that a
  repository's own git settings could define (hooks, filters, external diff
  tools, submodules) (MEETONTRACK-129).
- Better contrast in light and dark themes, and no text smaller than 11px
  (MEETONTRACK-22).

Everything from 0.1.30 is included. The Capture recorder is rebuilt from this
revision; its sources changed since 0.1.30.

Known: the assistant window is a browser window, not part of the Capture
recorder itself as on the Mac (MEETONTRACK-113). The Windows recorder does not
use your AI choice for its own tasks yet, so Antigravity is not available to
it (MEETONTRACK-106). Telegram delivery cannot be set up on Windows yet
(MEETONTRACK-135).

The speech recognition choice from the Mac release is not available on Windows
yet (MEETONTRACK-69). Getting started says so, and the Windows recorder keeps
transcribing with its local speech models as before.

Fact checking sends the checked statement to the AI you chose; knowledge base
excerpts go only to its call without web access. The CRM, when set up,
receives only the meeting note.

On 0.1.26 to 0.1.30, use the Install button. Otherwise finish the call and close
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

Application source: `29b1221898711779c6909e37e30ed68bff04acca`.
Native recorder: built from this repository's `windows/` at the same revision
([windows-candidate run 43577056467](https://github.com/AIAgentLbs/meetontrack/actions/runs/43577056467),
`managed.zip` SHA-256 `7a6032702f643625ecc0a22024f6177643716c7485c1b9149ca1ff5458c2dd5a`).
ZIP SHA-256: `42cef1bd224314710b7729bccd45651f4bc2bf7f46951c47a6758eee061d3e0e`.
The integrated package version is 0.1.31 (`0.1.31-windows-beta.1`); its
independently versioned native component retains 0.6.6. The web update
checker compares integrated versions.

## Limits

Unsigned technical beta; keep SmartScreen and antivirus enabled. Real-device
audio, permissions, headphone reconnects and installed tray acceptance are not
claimed for this release. The busy-port handling and the You/Others labels
were checked by tests only, not on a real Windows machine. Making the report PDF with Chrome and with Edge
was checked on a Windows build machine with a sample meeting, not on a real
call. Test a short call and inspect both sides before relying on a long
recording. Fact checks come from the AI you chose; open the source before
relying on a verdict. Local PDF/Office extraction and optional screen OCR
dependencies are not included. Speaker labels may need correction.
