# MeetOnTrack release notifications and one-click update

The local web service checks the public `AIAgentLbs/meetontrack` release list
every 15 minutes, first checking about 30 seconds after service startup. State polling
does not perform network requests. There is one bounded response (2 MB, 10 second
timeout), one selected release and at most 20,000 characters of release notes.
Failed requests preserve the previous notice and retry after 5, 10, 20, 40,
then at most 60 minutes. A successful check restores the 15-minute interval;
manual checks remain available in Settings.

The check sends no meeting content, account credentials or usage statistics.
GitHub necessarily receives the ordinary network request, including the client's
IP address. Settings → MeetOnTrack updates can disable background checks. A
manual check still works when background checks are disabled.

## Version and channel identity

- macOS: since MEETONTRACK-109 the web service runs from inside the app bundle
  (`Contents/Resources/payload/web`) and reports that bundle's
  `CFBundleShortVersionString` as a technical beta. The archive's top-level
  `release.json` is the package manifest; it is not installed. 0.1.20 and older
  read `release.json` next to `~/.local/share/meeting-copilot/web`.
- Windows: `release.json` already lives next to `web/` in each version directory.
- Unknown versions do not trigger network checks or offer a possible downgrade.
- Technical-beta installs accept beta releases; stable installs exclude them.
  Both require a newer numeric version and a matching platform asset. Publishing
  a new build at an existing version is not supported: increment the version.
- Expected tags/assets currently remain `vX.Y.Z` / `meeting-copilot-macos.zip`
  and `windows-vX.Y.Z` / `meeting-copilot-windows-vX.Y.Z-x64.zip`. Changing
  distribution names requires updating the selector and tests in the same release.

## User experience and safety

A new version displays a header notice, "Version X available", with one button,
**Install**. Clicking the notice opens Settings with the version, release notes,
and the official release page. Dismissal persists across service restarts; notes
remain accessible in Settings. Notes are rendered as plain text, never as HTML.
This is an in-app notice, not an OS notification.

**Install** (`POST /api/updates/install`, same Host/Origin checks as every POST, and an
`Origin` header is required, so only the app's own page starts an install):

1. The server accepts only the version it currently offers (newer than the
   installed one, matching platform and channel). The browser cannot name a URL.
   Before installing, the release list is fetched again: a cached offer that GitHub no
   longer lists is not installed.
2. During a recording (live status `recording`, `paused`, `loading` or
   `overloaded`, the states `install.ps1` also refuses, or while a capture marker
   `.recording.json` has a live owner, whatever recognition reports) the update is scheduled
   and the notice says it installs after the call. The 30-second release loop
   starts it once the recording ends. It never interrupts a recording.
3. The server downloads the official installer of exactly that release from the
   release tag: `https://raw.githubusercontent.com/AIAgentLbs/meetontrack/vX.Y.Z/install.sh`
   (Mac) or `.../windows-vX.Y.Z/scripts/windows/install.ps1` (Windows). Redirects
   are refused. The script must pin that tag (`VERSION="vX.Y.Z"` /
   `releases/download/windows-vX.Y.Z/`), so a tag cannot install an older
   release (exactly one such line, naming that tag). The script is written to a new
   owner-only folder. The installer pins and verifies the package SHA-256 itself. The
   website copy is not used: it may lag the notice. The recording state is
   checked again right before the installer starts.
4. The installer runs detached from the service (own session/process group),
   output appended to `~/.local/share/meeting-copilot/update.log`.
   - Windows: `powershell -File install.ps1` stops the old service, asks the
     old Capture to quit when idle and starts the new version.
   - Mac: a small helper quits Capture like its Quit menu item (Apple Event
     `quit`), so the app itself asks "Quit while recording?" if a recording
     started meanwhile. If Capture keeps running (kept recording, or Automation
     denied) nothing is installed and the notice offers Try again; no SIGTERM.
     Then it runs `install.sh` (which opens the new app and waits for its
     service, or restores the old version on failure) and `meeting-copilot` to
     open the assistant window of whatever is installed now.
5. The page reloads itself when the service version changes. If the installer
   fails, the old version keeps working; the notice says so in plain words with
   **Try again**, and details stay in the log. A service that restarts with an
   `installing` record but an older version reports the failure the same way.

Settings keeps the platform-specific installer command with a copy button as a
fallback (Terminal on Mac, PowerShell on Windows). It installs the website copy,
which can lag release metadata. Publication must update the installer
pin/checksum in the tagged commit, as it already does.

Native Sparkle/Velopack installation stays disabled; the one-click update reuses
the same installers people run by hand. Existing users receive it only after
installing a package that includes it.

## Automatic installation: deferred

Developer ID app signing/notarization and Sparkle Ed25519 update-archive signing
are separate mechanisms. Apple Developer membership is not a prerequisite for
the latter, nor for serving an HTTPS appcast and update archives. Developer ID
remains a distribution-hardening goal; command-line installation does not remove
macOS execution and permission checks. Do not claim that membership alone fixes
recording permissions, or block updater implementation solely on enrollment.
Validate the actual package's launch, framework loading and recording permissions
across an update. References: https://sparkle-project.org/documentation/ and
https://developer.apple.com/developer-id/ (checked 2026-10-19).

Owner decision (2026-10-19): ship release notifications, notes and a manual update command.
Owner request (2026-11-09): add the one-click Update above, which runs the tagged
installer after explicit consent. Native background installation stays deferred. The checklist
below applies when that separate feature is resumed; do not describe the current
checker as an automatic installer.

The release must update Capture, web UI and embedded Python as a single unit.
Since MEETONTRACK-109 (2026-11-04) that unit on macOS is the app bundle itself:
`Meeting Copilot Capture.app/Contents/Resources/payload` holds the Python
runtime, `web/`, the compiled helpers (`bin/`) and config templates, and the app
starts the service as its child process (no launchd agent). A Sparkle update of
the bundle therefore updates the native app, web UI and Python together. The
first move to this layout needs the installer once: it retires the
`com.aiagentlbs.meeting-copilot` agent and deletes `~/.local/share/meeting-copilot`
`python/`, `web/`, `release.json` and the three helpers in `bin/` only after the
new app is in place; data and settings there are untouched. Sparkle itself
stays disabled. Windows ZIP installs are not registered with Velopack, so its
existing update service reports NotInstalled.

Required acceptance before promotion:

- Package the complete product in the native update unit (Sparkle on Mac,
  Velopack on Windows), using our own feed and signing identity, never upstream.
- Automatically check, download and verify promoted releases; expose release
  notes and progress, and let users disable automatic installation in Settings.
- Defer replacement while recording, paused, starting, finalizing, transcribing,
  archiving or delivering. Recheck under a shared lifecycle gate immediately
  before exit; stale web transcript state is not an installation lock.
- Preserve recordings, models, credentials and settings. Retain the last working
  version; restore it if the new native app or loopback service fails its health check.
- Test exact N-to-N+1 package updates on both OSes: background detection, active
  call deferral, tampered package rejection, offline retry, interrupted install,
  rollback and settings/data preservation. Validate native AND web versions.
- Publish the bootstrap release only after those tests. Legacy packages without
  an updater necessarily require one initial upgrade; future fixes do not.

Environment checked 2026-10-19: macOS reports zero valid code-signing identities.
Vault searches for MeetOnTrack, Sparkle, signing and Apple Developer returned no
matching records. Windows appears online in Tailscale, but a bounded ED25519 SSH
host-key probe returned no key; authenticated Windows testing was not possible.
These observations are not proof that an Apple account or another Windows access
path does not exist. Do not change the public site's manual-update disclaimer or
claim automatic installation until the complete release passes acceptance.

The visible product is **MeetOnTrack by aiagentlbs.com**. Bundle identifiers,
executable names, installation directories, launch-agent labels and configuration
keys retain their legacy names for compatibility and recording permissions.

## Reproducible tests

```sh
python3 -m unittest discover -s copilot/web -p 'test_*.py'
python3 -m unittest scripts/test_installer.py
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-update-ui.cjs
```

The UI test uses synthetic releases and an isolated browser. It never talks to
the running meeting service. Screenshots go to `/tmp`, not Git.
