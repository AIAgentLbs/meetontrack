#!/bin/bash
set -euo pipefail

REPO="AIAgentLbs/meetontrack"
VERSION="v0.1.30"
ASSET="meeting-copilot-macos.zip"
SHA256="f743b7fafddbe0dafdf578d3be73e1a5d329ba512640df6aef3c04008bf1d933"
SHARE="${MEETING_COPILOT_SHARE_ROOT:-$HOME/.local/share/meeting-copilot}"
CONFIG="${MEETING_COPILOT_CONFIG_ROOT:-$HOME/.config/meeting-copilot}"
BIN="${MEETING_COPILOT_BIN_ROOT:-$HOME/.local/bin}"
AGENTS="${MEETING_COPILOT_AGENTS_ROOT:-$HOME/Library/LaunchAgents}"
LABEL="com.aiagentlbs.meeting-copilot"

say() { printf 'MeetOnTrack · %s\n' "$*"; }
fail() { printf 'MeetOnTrack · ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS is required"
[[ "$(uname -m)" == "arm64" ]] || fail "this beta currently requires Apple Silicon"
os_version="$(sw_vers -productVersion)"
[[ "${os_version%%.*}" -ge 15 ]] || fail "macOS 15 or later is required"
for tool in curl unzip shasum pgrep; do
  command -v "$tool" >/dev/null || fail "$tool is required; see https://meetontrack.com/ru/#install"
done
# Recording and local transcription do not require a paid AI subscription.
# The assistant's optional connection is checked explicitly in first-run UI.

# macOS pgrep hides the caller's own ancestors unless given -a.
capture_running() { pgrep -af '/MeetingCopilotCapture([[:space:]]|$)' >/dev/null 2>&1; }
require_capture_closed() {
  capture_running || return 0
  # Seen only with -a, Capture is our ancestor: an in-app update whose helper (0.1.26-0.1.27)
  # missed it. Quit it as the helper should have: an Apple Event, never SIGTERM, so a
  # recording gets its own "Quit while recording?" question. Run from Terminal: refuse as before.
  if ! pgrep -f '/MeetingCopilotCapture([[:space:]]|$)' >/dev/null 2>&1; then
    osascript -e 'quit app id "com.aiagentlbs.meetingcopilot.capture"' >/dev/null 2>&1 || true
    for _ in {1..240}; do capture_running || return 0; sleep 0.25; done
  fi
  fail "Quit Meeting Copilot Capture after your call before installing. The running capture was not stopped."
}
require_capture_closed

tmp="$(mktemp -d "${TMPDIR:-/tmp}/meeting-copilot.XXXXXX")"
# The previous app/python/web are kept only in "$tmp/rollback" while this script
# runs (never as a second .app: Launchpad and Spotlight listed every leftover
# "Meeting Copilot Capture.backup-*.app" as another MeetOnTrack). A failure
# before the commit point puts them back; success deletes them with "$tmp".
rollback="$tmp/rollback"
replaced=()
committed=false
locked=false
mkdir -p "$SHARE"
launched=false
agent_stopped=false
finish() {
  local status=$? index target
  if [[ $status -ne 0 && "$committed" != true && ${#replaced[@]} -gt 0 ]]; then
    # A new app that failed its readiness check is quit before its files go, like the Quit menu
    # item (an Apple Event), never SIGTERM: a recording it started meanwhile gets the app's own
    # "Quit while recording?" question. An app that stays is never swapped out from under itself:
    # the new version is kept and the failure is reported (MEETONTRACK-143).
    if [[ "$launched" == true ]]; then
      osascript -e 'quit app id "com.aiagentlbs.meetingcopilot.capture"' >/dev/null 2>&1 || true
      for wait in {1..240}; do
        pgrep -f "$app/Contents/MacOS/MeetingCopilotCapture" >/dev/null 2>&1 || break
        sleep 0.25
      done
      if pgrep -f "$app/Contents/MacOS/MeetingCopilotCapture" >/dev/null 2>&1; then
        printf 'MeetOnTrack · the new version is still running (a recording?) and stays installed. Log: %s\n' "$SHARE/server.log" >&2
        replaced=()
      else
        # Only its web service can be left behind; that one is not a recording.
        pkill -TERM -f "$app/Contents/Resources/payload/" >/dev/null 2>&1 || true
        for wait in {1..40}; do
          pgrep -f "$app/Contents/Resources/payload/" >/dev/null 2>&1 || break
          sleep 0.25
        done
        pkill -KILL -f "$app/Contents/Resources/payload/" >/dev/null 2>&1 || true
      fi
    fi
    for ((index=${#replaced[@]}-1; index>=0; index--)); do
      target="${replaced[$index]}"
      rm -rf "$target"
      [[ ! -e "$rollback/$index" ]] || mv "$rollback/$index" "$target"
    done
    # The old version's service was only stopped, never deleted: start it again.
    if [[ "$agent_stopped" == true && ${#replaced[@]} -gt 0 ]]; then
      launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL.plist" >/dev/null 2>&1 || true
    fi
    [[ ${#replaced[@]} -eq 0 ]] || printf 'MeetOnTrack · the previous version was restored\n' >&2
  fi
  rm -rf "$tmp"
}
trap finish EXIT
# replace SOURCE TARGET: swap in a complete copy, keeping TARGET until commit.
replace() {
  mkdir -p "$rollback"
  [[ ! -e "$2" ]] || mv "$2" "$rollback/${#replaced[@]}"
  replaced+=("$2")
  cp -R "$1" "$2"
}
# keep TARGET: a file migrated in place; a copy goes back if the install is rolled back (MEETONTRACK-125).
keep() {
  mkdir -p "$rollback"
  [[ ! -e "$1" ]] || cp -p "$1" "$rollback/${#replaced[@]}"
  replaced+=("$1")
}
url="${MEETING_COPILOT_ASSET_URL:-https://github.com/$REPO/releases/download/$VERSION/$ASSET}"
expected="${MEETING_COPILOT_ASSET_SHA256:-$SHA256}"
if [[ -n "${MEETING_COPILOT_ASSET_URL:-}" && -z "${MEETING_COPILOT_ASSET_SHA256:-}" ]]; then
  fail "An alternate asset URL requires MEETING_COPILOT_ASSET_SHA256"
fi
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Invalid expected SHA-256"
say "downloading $VERSION"
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 "$url" -o "$tmp/$ASSET"
actual="$(shasum -a 256 "$tmp/$ASSET")"
[[ "${actual%% *}" == "$expected" ]] || fail "Release checksum mismatch; nothing was installed"
unzip -tq "$tmp/$ASSET" >/dev/null || fail "Release archive is damaged"
unzip -q "$tmp/$ASSET" -d "$tmp/release"
release_app="$tmp/release/Meeting Copilot Capture.app"
# One app (MEETONTRACK-109): Python, the web service and helpers are inside it.
payload_in="Contents/Resources/payload"
[[ -d "$release_app" ]] || fail "release app is missing"
[[ -f "$tmp/release/release.json" ]] || fail "Release file is missing: release.json"
for file in web/server.py bin/meeting-copilot config/refresh-repos.py config/SESSION.md config/delivery.json.example; do
  [[ -f "$release_app/$payload_in/$file" ]] || fail "Release file is missing: $file"
done
python="$release_app/$payload_in/python/bin/python3"
[[ -x "$python" ]] || fail "Release Python runtime is missing"
"$python" -I -B -c 'import ssl, sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || fail "Packaged Python runtime cannot start"
for helper in zoom-window-finder zoom-frame-inspector detect-speech-language; do
  [[ -x "$release_app/$payload_in/bin/$helper" ]] || fail "Release helper is missing: $helper"
done
release_version="$("$python" -I -B -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$tmp/release/release.json")" \
  || fail "Release file is invalid: release.json"
# One install at a time (MEETONTRACK-143): an in-app update and a rerun must not interleave
# their swaps and rollbacks. A kernel lock (flock) on fd 9: it belongs to this script's open
# file, outlives the helper that took it, and goes away with this script, also after a crash.
mkdir -p "$SHARE"
exec 9>>"$SHARE/.install.lock"
for wait in {1..600}; do
  "$python" -I -B -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null && { locked=true; break; }
  sleep 0.5
done
[[ "$locked" == true ]] || fail "Another MeetOnTrack installation is running; nothing was changed. Try again when it finishes."
require_capture_closed

# Installers up to 0.1.16 left a backup of every previous version behind. Move
# those leftovers to the Trash (reversible), never the installed app itself.
trash="${MEETING_COPILOT_TRASH_ROOT:-$HOME/.Trash}"
stamp="$(date +%Y%m%d-%H%M%S)-$$"
if [[ -n "${MEETING_COPILOT_APP_ROOT:-}" ]]; then
  app_roots=("$MEETING_COPILOT_APP_ROOT")
else
  app_roots=(/Applications "$HOME/Applications")
fi
leftovers=("$SHARE"/*.backup-* "$SHARE"/backups/*/*.app)
for root in "${app_roots[@]}"; do leftovers+=("$root/Meeting Copilot Capture.backup-"*.app); done
for item in "${leftovers[@]}"; do
  [[ -e "$item" ]] || continue
  mkdir -p "$trash"
  target="$trash/${item##*/}" n=0
  while [[ -e "$target" ]]; do n=$((n + 1)); target="$trash/$stamp-$n ${item##*/}"; done
  if mv "$item" "$target"; then say "moved an old copy to the Trash: $item"; else say "could not move $item to the Trash"; fi
done

app_root="${MEETING_COPILOT_APP_ROOT:-/Applications}"
if [[ ! -w "$app_root" ]]; then
  app_root="$HOME/Applications"
  mkdir -p "$app_root"
fi
app="$app_root/Meeting Copilot Capture.app"
# Under the lock, never replace a newer version that another install finished meanwhile.
if [[ -f "$app/Contents/Info.plist" ]] && ! "$python" -I -B - "$app/Contents/Info.plist" "$release_version" <<'PY'
import plistlib, re, sys
def key(value):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", str(value))
    return tuple(map(int, match.groups())) if match else None
try:
    installed = key(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleShortVersionString"))
except Exception:
    installed = None
new = key(sys.argv[2])
sys.exit(1 if installed and new and installed > new else 0)
PY
then
  fail "A newer MeetOnTrack is already installed; nothing was changed"
fi
replace "$release_app" "$app"
payload="$app/$payload_in"
python="$payload/python/bin/python3"

mkdir -p "$SHARE" "$CONFIG" "$BIN"
replace "$payload/bin/meeting-copilot" "$BIN/meeting-copilot"
install -m 0755 "$payload/config/refresh-repos.py" "$CONFIG/refresh-repos.py"
# One-time removal of retired usage-reporting state; preserve all other settings.
for retired in config.json analytics.json analytics-pending.json; do keep "$CONFIG/$retired"; done
"$python" -I -B - "$CONFIG" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
config = root / "config.json"
if config.is_file():
    value = json.loads(config.read_text())
    if "analytics" in value:
        del value["analytics"]
        temporary = config.with_name("config.json.statistics-removal.tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        temporary.chmod(0o600)
        temporary.replace(config)
for name in ("analytics.json", "analytics-pending.json"):
    (root / name).unlink(missing_ok=True)
PY
[[ -f "$CONFIG/SESSION.md" ]] || install -m 0644 "$payload/config/SESSION.md" "$CONFIG/SESSION.md"
[[ -f "$CONFIG/delivery.json.example" ]] || install -m 0600 "$payload/config/delivery.json.example" "$CONFIG/delivery.json.example"

# Discovery is explicit (meeting-copilot --refresh). A first install must not
# scan unrelated project directories or write to a different user's config.
if [[ ! -f "$CONFIG/repos.json" ]]; then
  "$python" -I -B - "$CONFIG/repos.json" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({"repositories": [], "repository_count": 0, "search_roots": []}) + "\n")
PY
fi
if [[ ! -f "$CONFIG/active-repos.json" ]]; then
  "$python" -I -B - "$CONFIG/repos.json" "$CONFIG/active-repos.json" <<'PY'
import json, pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
data = json.loads(source.read_text())
data["repositories"] = []
data["repository_count"] = 0
target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
fi

# Up to 0.1.18 a launchd agent ran the web service from separate copies of
# Python and web/ in $SHARE. The app runs its own now. Stop the agent so the
# port is free, but delete nothing of the old version until the new app has
# proved itself: a failure from here on restores it and restarts its agent.
domain="gui/$(id -u)"
if [[ -f "$AGENTS/$LABEL.plist" ]]; then
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  agent_stopped=true
  stopped=false
  for wait in {1..40}; do
    if ! launchctl print "$domain/$LABEL" >/dev/null 2>&1; then stopped=true; break; fi
    sleep 0.25
  done
  [[ "$stopped" == true ]] || fail "The previous background service did not stop; nothing was changed. Rerun the installer."
fi

if [[ "${MEETING_COPILOT_SKIP_LAUNCH:-0}" != "1" ]]; then
  launched=true
  open "$app"
  # The app starts the assistant's local service itself; confirm it is this
  # version answering, not a leftover, before calling the install done. Only a
  # service an app started carries a launch token (MEETONTRACK-116): one started
  # by hand on the port does not count.
  ready=false
  # The app records the port it runs on when 43121 is taken (MEETONTRACK-130); a
  # stale record is harmless, only a service that answers as this version counts.
  for attempt in {1..120}; do
    recorded="$(cat "$SHARE/server-port" 2>/dev/null || true)"
    [[ "$recorded" =~ ^[0-9]+$ ]] || recorded=""
    for port in $recorded 43121; do
      if curl --fail --silent --connect-timeout 1 --max-time 1 \
        "http://127.0.0.1:$port/api/health" \
        | "$python" -I -B -c 'import json,sys; value=json.load(sys.stdin); sys.exit(0 if value.get("ok") is True and value.get("service")=="meeting-copilot" and value.get("version")==sys.argv[1] and value.get("instance") else 1)' "$release_version" \
          >/dev/null 2>&1; then
        ready=true
        break 2
      fi
    done
    sleep 0.25
  done
  [[ "$ready" == true ]] || fail "The new version's assistant did not become ready. Log: $SHARE/server.log"
fi

# Commit: the new app runs. The previous copies are deleted with "$tmp", and
# only the old program files go: recordings, archive, reports, models and
# every setting stay untouched.
committed=true
if [[ "$agent_stopped" == true ]]; then
  rm -f "$AGENTS/$LABEL.plist"
  say "retired the separate background service; MeetOnTrack runs it itself now"
fi
rm -rf "$SHARE/python" "$SHARE/web" "$SHARE/release.json"
for helper in zoom-window-finder zoom-frame-inspector detect-speech-language; do rm -f "$SHARE/bin/$helper"; done
rmdir "$SHARE/bin" 2>/dev/null || true
[[ "${MEETING_COPILOT_SKIP_LAUNCH:-0}" == "1" ]] || say "MeetOnTrack is open; finish first-run permissions and model setup in its window"
say "$release_version installed; existing recordings and private settings were preserved"
say "reopen anytime with Open MeetOnTrack assistant in the app window or menu bar"
