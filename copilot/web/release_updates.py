"""Release checks and the one-click update.

Checking sends no meeting data. Installing runs only when the person clicks Update: the
official installer of exactly the offered release, taken from that release's tag on GitHub
(it pins and verifies the package SHA-256), detached from this service because it replaces
and restarts it. During a recording the update waits until the recording ends.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import Request, urlopen

REPOSITORY = "AIAgentLbs/meetontrack"
RELEASE_URL = f"https://github.com/{REPOSITORY}/releases/tag/"
INSTALLERS = {"macos": "install.sh", "windows": "scripts/windows/install.ps1"}
INSTALLER_URL = re.compile(r"https://raw\.githubusercontent\.com/AIAgentLbs/meetontrack/"
                           r"(?:v\d+\.\d+\.\d+/install\.sh|windows-v\d+\.\d+\.\d+/scripts/windows/install\.ps1)")
# Live states install.ps1 also refuses to update in. The server also treats an active capture
# marker (`.recording.json` with a live pid) as recording, since recognition can report error/unavailable mid-call.
RECORDING = {"recording", "paused", "loading", "overloaded"}
# Mac: install.sh refuses while Capture runs. Quit it like the Quit menu item (an Apple Event):
# the app decides on its own thread, so a recording that started meanwhile gets its
# "Quit while recording?" question instead of being cut off, and a kept app is not updated.
# Never SIGTERM: that path stops a recording without asking. If the quit is refused or
# Automation is denied, nothing is installed and the person sees "Try again" (details in update.log).
# Then install, and open the assistant window of whatever is installed now: install.sh opened
# the new app, or restored the old one after a failure. The pgrep pattern is install.sh's;
# this command line cannot match it (no space or end after the name). -a: this helper descends
# from Capture (via the server), and macOS pgrep otherwise hides ancestors (MEETONTRACK-142).
MAC_HELPER = r"""
running() { pgrep -af '/MeetingCopilotCapture([[:space:]]|$)' >/dev/null; }
if running; then
  answer=$(osascript -e 'quit app id "com.aiagentlbs.meetingcopilot.capture"' 2>&1)
  echo "MeetOnTrack update: quit Capture: ${answer:-ok}"
  for _ in {1..240}; do running || break; sleep 0.25; done
  if running; then echo "MeetOnTrack update: Capture did not quit (a recording, or Automation denied); nothing installed"; rm -rf "${1%/*}"; exit 75; fi
fi
/bin/bash "$1"
status=$?
echo "MeetOnTrack update: installer exited with $status"
"$HOME/.local/bin/meeting-copilot" || open -b com.aiagentlbs.meetingcopilot.capture
rm -rf "${1%/*}"
exit $status
"""
# Beta fixes should be discovered promptly, without coupling network work to
# transcript polling. Keep failures bounded too, instead of hiding fixes for a day.
INTERVAL = 15 * 60
RETRY_INTERVAL = 5 * 60
MAX_RETRY_INTERVAL = 60 * 60


def version_key(value):
    match = re.fullmatch(r"(?:windows-)?v?(\d+)\.(\d+)\.(\d+)(?:-windows-beta\.\d+)?", str(value))
    return tuple(map(int, match.groups())) if match else None


def select_release(releases, current, platform, channel):
    current_key = version_key(current)
    if current_key is None or not isinstance(releases, list):
        return None
    candidates = []
    for item in releases[:100]:
        if not isinstance(item, dict) or item.get("draft") or (item.get("prerelease") and channel != "technical-beta"):
            continue
        tag = str(item.get("tag_name", ""))
        key = version_key(tag)
        if key is None or key <= current_key or tag.startswith("windows-") != (platform == "windows"):
            continue
        expected = f"meeting-copilot-windows-v{'.'.join(map(str, key))}-x64.zip" if platform == "windows" else "meeting-copilot-macos.zip"
        assets = item.get("assets")
        if not isinstance(assets, list) or not any(isinstance(asset, dict) and asset.get("name") == expected for asset in assets):
            continue
        if item.get("html_url") != RELEASE_URL + tag:
            continue
        candidates.append((key, {"version": ".".join(map(str, key)), "url": RELEASE_URL + tag,
                                  "notes": str(item.get("body") or "")[:20000], "prerelease": bool(item.get("prerelease"))}))
    return max(candidates, key=lambda entry: entry[0])[1] if candidates else None


def release_tag(version, platform):
    return ("windows-" if platform == "windows" else "") + "v" + version


def installer_url(version, platform):
    url = f"https://raw.githubusercontent.com/{REPOSITORY}/{release_tag(version, platform)}/{INSTALLERS.get(platform, '')}"
    if not INSTALLER_URL.fullmatch(url):
        raise ValueError("Untrusted installer URL")
    return url


def pins_release(script: bytes, version, platform):
    """The tag's installer must install that very release, not an older one (no downgrade)."""
    # The one line that names the package (install.sh `VERSION=`, install.ps1 `$url=`) names this tag.
    prefix, expected = ((b"$url=", f"$url='https://github.com/{REPOSITORY}/releases/download/{release_tag(version, platform)}/")
                        if platform == "windows" else (b"VERSION=", f'VERSION="{release_tag(version, platform)}"'))
    lines = [line.rstrip(b"\r") for line in script.split(b"\n") if line.startswith(prefix)]
    return len(lines) == 1 and (lines[0] == expected.encode() if platform == "macos" else lines[0].startswith(expected.encode()))


def fetch_installer(url):
    with urlopen(Request(url, headers={"User-Agent": "MeetOnTrack-update"}), timeout=30) as response:
        if response.geturl() != url:
            raise ValueError("Installer download was redirected")
        raw = response.read(1_000_001)
    if len(raw) > 1_000_000:
        raise ValueError("Installer too large")
    return raw


def installer_command(platform, script: Path):
    if platform == "windows":
        shell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        return [str(shell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)]
    return ["/bin/bash", "-c", MAC_HELPER, "meetontrack-update", str(script)]


def spawn_installer(command, log: Path):
    """Detached: the installer stops this service (Windows) or the app that owns it (Mac)."""
    detached = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
                else {"start_new_session": True})
    # The installer's own defaults, never a leftover override (MEETING_COPILOT_ASSET_URL...).
    env = {key: value for key, value in os.environ.items() if not key.startswith("MEETING_COPILOT_")}
    with open(log, "ab") as output:
        return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                env=env, **detached)


def installed_release(web_dir: Path, platform=None):
    platform = platform or ("windows" if sys.platform == "win32" else "macos")
    try:
        data = json.loads((web_dir.parent / "release.json").read_text())
        if version_key(data.get("version")):
            return {"version": data["version"], "channel": data.get("channel", "stable"), "platform": platform}
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    if platform == "macos":
        # Inside the app bundle (Contents/Resources/payload/web) the bundle itself is the release.
        contents = web_dir.resolve().parent.parent.parent
        bundled = [contents / "Info.plist"] if contents.name == "Contents" else []
        for plist in (*bundled, *(root / "Meeting Copilot Capture.app/Contents/Info.plist"
                                      for root in (Path("/Applications"), Path.home() / "Applications"))):
            try:
                with plist.open("rb") as handle:
                    data = plistlib.load(handle)
                value = data.get("CFBundleShortVersionString", "")
                if version_key(value):
                    return {"version": value, "channel": "technical-beta", "platform": platform}
            except (OSError, ValueError):
                pass
    return {"version": "", "channel": "stable", "platform": platform}


def fetch_releases():
    request = Request(f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=100",
                      headers={"Accept": "application/vnd.github+json", "User-Agent": "MeetOnTrack-update-check"})
    with urlopen(request, timeout=10) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("Release feed too large")
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("Invalid release feed")
    return data


class ReleaseUpdates:
    def __init__(self, path, identity, fetch=fetch_releases, clock=time.time, recording=lambda: False,
                 data_dir=None, fetch_script=fetch_installer, spawn=spawn_installer):
        self.path, self.identity, self.fetch, self.clock = Path(path), identity, fetch, clock
        self.recording, self.fetch_script, self.spawn = recording, fetch_script, spawn
        self.data_dir = Path(data_dir) if data_dir else self.path.parent
        self.job = None  # {"version", "state": scheduled | running | failed}
        self.lock = threading.RLock()
        self.busy = False
        self.error = False
        self.failures = 0
        self.next_check = 0
        self.data = {"enabled": True, "checked_at": 0, "dismissed": "", "latest": None}
        try:
            saved = json.loads(self.path.read_text())
            if isinstance(saved, dict):
                if isinstance(saved.get("enabled"), bool):
                    self.data["enabled"] = saved["enabled"]
                checked = saved.get("checked_at", 0)
                if isinstance(checked, (float, int)) and 0 <= checked <= self.clock():
                    self.data["checked_at"] = checked
                self.data["dismissed"] = str(saved.get("dismissed", ""))[:60]
                self.data["latest"] = saved.get("latest")
                latest = self.data["latest"]
                # Cached metadata is untrusted too; never return arbitrary external links.
                if latest:
                    tag = ("windows-" if identity["platform"] == "windows" else "") + "v" + str(latest.get("version", ""))
                    if not version_key(latest.get("version")) or latest.get("url") != RELEASE_URL + tag or not version_key(identity.get("version")) or version_key(latest["version"]) <= version_key(identity["version"]) or (latest.get("prerelease") and identity["channel"] != "technical-beta"):
                        self.data["latest"] = None
                    else:
                        self.data["latest"] = {"version": latest["version"], "url": latest["url"], "notes": str(latest.get("notes", ""))[:20000], "prerelease": bool(latest.get("prerelease"))}
            # An update was running when the previous service stopped: this one tells how it ended.
            installing = str(saved.get("installing", ""))
            if version_key(installing) and not (version_key(identity.get("version")) and version_key(identity["version"]) >= version_key(installing)):
                self.job = {"version": installing, "state": "failed"}
            # An after-call update survives a restart while the same release is still on offer;
            # installing it rechecks GitHub and the installer's pin first (MEETONTRACK-143).
            scheduled = str(saved.get("scheduled", ""))
            if not self.job and self.data["latest"] and self.data["latest"]["version"] == scheduled:
                self.job = {"version": scheduled, "state": "scheduled"}
                self.data["scheduled"] = scheduled
        except (OSError, ValueError, TypeError, AttributeError):
            self.data["latest"] = None
        # A restart checks promptly even if yesterday's cache recorded a failure.
        # The loop supplies a startup delay; repeated snapshots still do no I/O.

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".updates-", dir=self.path.parent)
        try:
            with os.fdopen(descriptor, "w") as handle:
                json.dump(self.data, handle)
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def snapshot(self):
        with self.lock:
            latest = self.data["latest"]
            return {**self.identity, **self.data, "checking": self.busy, "error": self.error, "install": self.job,
                    "notify": bool(self.data["enabled"] and latest and latest["version"] != self.data["dismissed"])}

    def configure(self, payload):
        with self.lock:
            if "enabled" in payload:
                if not isinstance(payload["enabled"], bool):
                    raise ValueError("enabled must be a boolean")
                self.data["enabled"] = payload["enabled"]
            if "dismiss" in payload:
                self.data["dismissed"] = str(payload["dismiss"])[:60]
            self._save()
        return self.snapshot()

    def install(self, version):
        """The person clicked Update (or Retry) for the release on offer."""
        with self.lock:
            latest = self.data["latest"]
            if self.identity.get("platform") not in INSTALLERS or not latest or latest["version"] != version:
                raise ValueError("This version is not offered for update")
            if not self.job or self.job["state"] == "failed":
                self.job = {"version": version, "state": "scheduled"}
                self.data["scheduled"] = version
                try:
                    self._save()
                except OSError:
                    pass  # still scheduled for this run of the service
        self.resume()
        return self.snapshot()

    def resume(self):
        """Start a scheduled update unless a recording is in progress (then the loop retries)."""
        with self.lock:
            job = self.job
            if not job or job["state"] != "scheduled" or self.recording():
                return None
            job["state"] = "running"
        worker = threading.Thread(target=self._install, args=(job["version"],), daemon=True, name="release-install")
        worker.start()
        return worker

    def _log(self, line):
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            with open(self.data_dir / "update.log", "a", encoding="utf-8") as log:
                log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
        except OSError:
            pass

    def _install(self, version):
        platform = self.identity["platform"]
        try:
            # The cached offer is only a notice: the release must still be the one GitHub offers now.
            fresh = select_release(self.fetch(), self.identity["version"], platform, self.identity["channel"])
            if fresh:
                with self.lock:
                    self.data["latest"] = fresh
            if not fresh or fresh["version"] != version:
                raise ValueError(f"{version} is no longer the offered release")
            url = installer_url(version, platform)
            script = self.fetch_script(url)
            if not pins_release(script, version, platform):
                raise ValueError(f"{url} does not install {release_tag(version, platform)}")
            if self.recording():  # a call started meanwhile: wait for it again
                with self.lock:
                    self.job = {"version": version, "state": "scheduled"}
                return
            if platform == "windows" and not script.startswith(b"\xef\xbb\xbf"):
                script = b"\xef\xbb\xbf" + script  # Windows PowerShell reads a file without BOM as ANSI
            self.data_dir.mkdir(parents=True, exist_ok=True)
            # A fresh owner-only folder and a new file: nothing pre-existing is followed or reused.
            target = Path(tempfile.mkdtemp(prefix="update-", dir=self.data_dir)) / (
                "install.ps1" if platform == "windows" else "install.sh")
            with open(target, "xb") as handle:
                handle.write(script)
            with self.lock:
                self.data["installing"] = version
                self.data.pop("scheduled", None)
                self._save()
            self._log(f"installing {release_tag(version, platform)} from {url}")
            code = self.spawn(installer_command(platform, target), self.data_dir / "update.log").wait()
            # Success replaces this service before the wait returns; still here means it failed.
            failed = code != 0
            if failed:
                self._log(f"installer exited with {code}; the current version keeps running")
        except Exception as error:
            failed = True
            self._log(f"update to {version} failed: {error}")
        with self.lock:
            self.data.pop("installing", None)
            self.data.pop("scheduled", None)
            self.job = {"version": version, "state": "failed"} if failed else None
            try:
                self._save()
            except OSError:
                pass

    def check(self, force=False):
        with self.lock:
            if self.busy or not version_key(self.identity.get("version")):
                return
            if not force and (not self.data["enabled"] or self.clock() < self.next_check):
                return
            self.busy = True
        self._perform_check()

    def _perform_check(self):
        try:
            latest = select_release(self.fetch(), self.identity["version"], self.identity["platform"], self.identity["channel"])
            with self.lock:
                self.data["latest"] = latest
                self.error = False
                self.failures = 0
        except Exception:
            with self.lock:
                self.error = True
                self.failures = min(self.failures + 1, 5)
        finally:
            with self.lock:
                self.busy = False
                self.data["checked_at"] = self.clock()
                delay = min(RETRY_INTERVAL * (2 ** max(0, self.failures - 1)), MAX_RETRY_INTERVAL) if self.failures else INTERVAL
                self.next_check = self.clock() + delay
                try:
                    self._save()
                except OSError:
                    self.error = True

    def request_check(self):
        with self.lock:
            if self.busy or not version_key(self.identity.get("version")):
                return
            self.busy = True
        worker = threading.Thread(target=self._perform_check, daemon=True, name="release-check")
        worker.start()
        return worker

    def loop(self, stop):
        # Separate from transcript/state polling; no meeting data is sent.
        if stop.wait(30):
            return
        while not stop.is_set():
            self.check()
            self.resume()
            if stop.wait(30):
                return
