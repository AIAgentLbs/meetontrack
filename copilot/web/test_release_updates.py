import json
from pathlib import Path
import tempfile
import threading
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import unittest

import os
import re
import subprocess
import sys

import release_updates
from release_updates import ReleaseUpdates, select_release, installed_release, installer_url, pins_release


def release(version, platform="macos", prerelease=True, **extra):
    tag = ("windows-" if platform == "windows" else "") + "v" + version
    asset = (f"meeting-copilot-windows-v{version}-x64.zip" if platform == "windows"
             else "meeting-copilot-macos.zip")
    return dict(tag_name=tag, draft=False, prerelease=prerelease,
                html_url=f"https://github.com/AIAgentLbs/meetontrack/releases/tag/{tag}",
                body="Changes\n<script>alert(1)</script>", assets=[{"name": asset}], **extra)


class ReleaseSelectionTests(unittest.TestCase):
    def test_newest_matching_platform_not_first_or_lexicographic(self):
        data = [release("0.2.0", "windows"), release("0.1.9"), release("0.1.10")]
        self.assertEqual(select_release(data, "0.1.9", "macos", "technical-beta")["version"], "0.1.10")

    def test_stable_channel_never_advertises_beta(self):
        self.assertIsNone(select_release([release("1.1.0")], "1.0.0", "macos", "stable"))

    def test_same_windows_beta_or_older_version_is_not_an_update(self):
        self.assertIsNone(select_release([release("0.1.4", "windows"), release("0.1.3", "windows")],
                                         "0.1.4-windows-beta.1", "windows", "technical-beta"))

    def test_drafts_wrong_asset_untrusted_links_and_malformed_versions_are_rejected(self):
        valid = release("2.0.0")
        for bad in [dict(valid, draft=True), dict(valid, assets=[]),
                    dict(valid, html_url="https://example.com/installer"),
                    dict(valid, tag_name="vlatest")]:
            with self.subTest(bad=bad):
                self.assertIsNone(select_release([bad], "1.0.0", "macos", "technical-beta"))

    def test_windows_manifest_is_found_next_to_web_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "web").mkdir()
            (root / "release.json").write_text(json.dumps({"version": "0.1.4-windows-beta.1", "channel": "technical-beta"}))
            self.assertEqual(installed_release(root / "web", "windows")["version"], "0.1.4-windows-beta.1")

    def test_mac_bundle_reports_its_own_version(self):
        # The web payload lives in Contents/Resources/payload/web of the app.
        import plistlib
        with tempfile.TemporaryDirectory() as tmp:
            contents = Path(tmp) / "MeetOnTrack.app/Contents"
            web = contents / "Resources/payload/web"
            web.mkdir(parents=True)
            (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": "0.2.0"}))
            self.assertEqual(installed_release(web, "macos"),
                             {"version": "0.2.0", "channel": "technical-beta", "platform": "macos"})


class ReleaseMonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "updates.json"
        self.calls = []
        self.now = 1000000

    def tearDown(self):
        self.tmp.cleanup()

    def monitor(self, fetch=None):
        def feed():
            self.calls.append(True)
            return [release("0.1.10")]
        return ReleaseUpdates(self.path, {"version": "0.1.9", "channel": "technical-beta", "platform": "macos"},
                              fetch=fetch or feed, clock=lambda: self.now)

    def test_polling_snapshots_never_fetch_and_checks_are_every_fifteen_minutes(self):
        monitor = self.monitor()
        for _ in range(20):
            monitor.snapshot()
        self.assertEqual(self.calls, [])
        monitor.check()
        monitor.check()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(monitor.snapshot()["latest"]["version"], "0.1.10")
        self.now += 899
        monitor.check()
        self.assertEqual(len(self.calls), 1)
        self.now += 1
        monitor.check()
        self.assertEqual(len(self.calls), 2)

    def test_dismissal_survives_restart_without_hiding_release_notes(self):
        monitor = self.monitor()
        monitor.check()
        self.assertTrue(monitor.snapshot()["notify"])
        monitor.configure({"dismiss": "0.1.10"})
        restarted = self.monitor()
        self.assertFalse(restarted.snapshot()["notify"])
        self.assertIn("Changes", restarted.snapshot()["latest"]["notes"])

    def test_disabled_checks_do_not_contact_network_but_manual_check_works(self):
        monitor = self.monitor()
        monitor.configure({"enabled": False})
        monitor.check()
        self.assertEqual(self.calls, [])
        monitor.check(force=True)
        self.assertEqual(len(self.calls), 1)

    def test_failures_keep_previous_notice_and_back_off(self):
        monitor = self.monitor()
        monitor.check()
        monitor.fetch = lambda: (_ for _ in ()).throw(OSError("offline"))
        self.now += 901
        monitor.check()
        self.assertEqual(monitor.snapshot()["latest"]["version"], "0.1.10")
        self.assertTrue(monitor.snapshot()["error"])
        monitor.fetch = lambda: self.fail("retry must wait")
        monitor.check()

    def test_failure_retry_is_five_minutes_then_exponential_bounded_at_one_hour(self):
        calls = []
        def offline():
            calls.append(True)
            raise OSError("offline")
        monitor = self.monitor(offline)
        for delay in [300, 600, 1200, 2400, 3600, 3600]:
            monitor.check()
            self.assertEqual(monitor.next_check - self.now, delay)
            count = len(calls)
            self.now += delay - 1
            monitor.check()
            self.assertEqual(len(calls), count)
            self.now += 1
        monitor.fetch = lambda: [release("0.1.10")]
        monitor.check()
        self.assertFalse(monitor.snapshot()["error"])
        self.assertEqual(monitor.next_check - self.now, 900)

    def test_restart_checks_without_waiting_for_old_cached_timestamp(self):
        monitor = self.monitor()
        monitor.check()
        restarted = self.monitor()
        restarted.check()
        self.assertEqual(len(self.calls), 2)

    def test_unknown_installed_version_does_not_offer_downgrade(self):
        monitor = ReleaseUpdates(self.path, {"version": "", "channel": "technical-beta", "platform": "macos"},
                                 fetch=lambda: self.fail("unknown version must not contact server"))
        monitor.check(force=True)
        self.assertFalse(monitor.snapshot()["notify"])

    def test_corrupt_cache_cannot_stop_background_checks(self):
        for timestamp in ["bad", 10 ** 400]:
            self.path.write_text(json.dumps({"checked_at": timestamp, "enabled": "bad", "latest": {"version": "latest"}}))
            monitor = self.monitor()
            monitor.check()
            self.assertTrue(monitor.snapshot()["notify"])

    def test_manual_requests_are_single_flight_with_immediate_checking_state(self):
        started, finish = threading.Event(), threading.Event()
        calls = []
        def fetch():
            calls.append(True)
            started.set()
            finish.wait(2)
            return [release("0.1.10")]
        monitor = self.monitor(fetch)
        try:
            worker = monitor.request_check()
            self.assertTrue(started.wait(1))
            self.assertTrue(monitor.snapshot()["checking"])
            for _ in range(20):
                monitor.request_check()
            self.assertEqual(len(calls), 1)
        finally:
            finish.set()
            worker.join(3)
            self.assertFalse(worker.is_alive())

    def test_http_settings_and_checks_preserve_origin_guard(self):
        import server
        monitor = self.monitor()
        with patch.object(server, "UPDATES", monitor):
            http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{http.server_port}"
            try:
                with urlopen(base + "/api/updates") as response:
                    self.assertEqual(json.load(response)["updates"]["version"], "0.1.9")
                request = Request(base + "/api/updates/settings", data=b'{"enabled":false}',
                                  headers={"Content-Type": "application/json", "Origin": "https://evil.example"})
                with self.assertRaises(HTTPError) as failure:
                    urlopen(request)
                self.assertEqual(failure.exception.code, 403)
                failure.exception.close()
                request.remove_header("Origin")
                with urlopen(request) as response:
                    self.assertFalse(json.load(response)["updates"]["enabled"])
                with urlopen(base + "/updates.js") as response:
                    self.assertEqual(response.status, 200)
            finally:
                http.shutdown()
                http.server_close()
                thread.join()


class FakeProcess:
    def __init__(self, code):
        self.code = code

    def wait(self):
        return self.code


class OneClickUpdateTests(unittest.TestCase):
    """Never runs a real installer: fetching and spawning are injected."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.recording = False
        self.fetched, self.spawned = [], []
        self.script = b'VERSION="v0.1.10"\n'
        self.code = 0

    def tearDown(self):
        self.tmp.cleanup()

    def monitor(self, version="0.1.9", platform="macos"):
        tag = ("windows-" if platform == "windows" else "") + "v0.1.10"
        def fetch_script(url):
            self.fetched.append(url)
            return self.script
        def spawn(command, log):
            self.spawned.append((command, Path(command[-1]).read_bytes(), log))
            return FakeProcess(self.code)
        return ReleaseUpdates(self.root / "updates.json", {"version": version, "channel": "technical-beta", "platform": platform},
                              fetch=lambda: [release("0.1.10", platform)], clock=lambda: 1000000,
                              recording=lambda: self.recording, data_dir=self.root / "data",
                              fetch_script=fetch_script, spawn=spawn)

    def run_install(self, monitor, version="0.1.10"):
        monitor.install(version)
        for thread in threading.enumerate():
            if thread.name == "release-install":
                thread.join(5)
        return monitor.snapshot()

    def test_only_tag_installers_of_this_repository_are_trusted(self):
        self.assertEqual(installer_url("0.1.10", "macos"),
                         "https://raw.githubusercontent.com/AIAgentLbs/meetontrack/v0.1.10/install.sh")
        self.assertEqual(installer_url("0.1.10", "windows"),
                         "https://raw.githubusercontent.com/AIAgentLbs/meetontrack/windows-v0.1.10/scripts/windows/install.ps1")
        for version in ["0.1.10/../../evil", "latest", "0.1.10?x", "main"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                installer_url(version, "macos")
        with self.assertRaises(ValueError):
            installer_url("0.1.10", "linux")

    def test_installer_must_pin_the_offered_release(self):
        self.assertTrue(pins_release(b'VERSION="v0.1.10"', "0.1.10", "macos"))
        self.assertFalse(pins_release(b'VERSION="v0.1.9"', "0.1.10", "macos"))
        self.assertTrue(pins_release(b"$url='https://github.com/AIAgentLbs/meetontrack/releases/download/windows-v0.1.10/x.zip'",
                                     "0.1.10", "windows"))
        self.assertFalse(pins_release(b"releases/download/windows-v0.1.9/", "0.1.10", "windows"))

    def test_mac_update_runs_the_tag_installer_detached_and_clears_on_success(self):
        monitor = self.monitor()
        monitor.check()
        snapshot = self.run_install(monitor)
        self.assertEqual(self.fetched, ["https://raw.githubusercontent.com/AIAgentLbs/meetontrack/v0.1.10/install.sh"])
        command, script, log = self.spawned[0]
        self.assertEqual(command[:3], ["/bin/bash", "-c", release_updates.MAC_HELPER])
        self.assertEqual(script, self.script)
        self.assertEqual(log, self.root / "data/update.log")
        self.assertIsNone(snapshot["install"])

    def test_windows_update_runs_powershell_with_a_bom(self):
        self.script = b"$url='https://github.com/AIAgentLbs/meetontrack/releases/download/windows-v0.1.10/a.zip'"
        monitor = self.monitor("0.1.9-windows-beta.1", "windows")
        monitor.check()
        self.run_install(monitor)
        command, script, _ = self.spawned[0]
        self.assertEqual(command[1:6], ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command[-1]])
        self.assertTrue(command[0].endswith("powershell.exe"))
        self.assertEqual(script, b"\xef\xbb\xbf" + self.script)

    def test_recording_defers_the_update_until_it_ends(self):
        monitor = self.monitor()
        monitor.check()
        self.recording = True
        self.assertEqual(monitor.install("0.1.10")["install"], {"version": "0.1.10", "state": "scheduled"})
        self.assertIsNone(monitor.resume())
        self.assertEqual((self.fetched, self.spawned), ([], []))
        self.recording = False
        monitor.resume().join(5)
        self.assertEqual(len(self.spawned), 1)

    def test_recording_started_during_download_is_not_interrupted(self):
        monitor = self.monitor()
        monitor.check()
        def fetch_script(url):
            self.recording = True
            return self.script
        monitor.fetch_script = fetch_script
        self.assertEqual(self.run_install(monitor)["install"]["state"], "scheduled")
        self.assertEqual(self.spawned, [])

    def test_failures_keep_the_old_version_and_offer_retry_with_details_in_the_log(self):
        for case in ["pins_older", "exit_code", "offline"]:
            with self.subTest(case=case):
                self.spawned = []
                monitor = self.monitor()
                monitor.check()
                self.script = b'VERSION="v0.1.8"' if case == "pins_older" else b'VERSION="v0.1.10"'
                self.code = 1 if case == "exit_code" else 0
                if case == "offline":
                    monitor.fetch_script = lambda url: (_ for _ in ()).throw(OSError("offline"))
                snapshot = self.run_install(monitor)
                self.assertEqual(snapshot["install"], {"version": "0.1.10", "state": "failed"})
                self.assertEqual(len(self.spawned), 1 if case == "exit_code" else 0)
                self.assertIn("0.1.10", (self.root / "data/update.log").read_text())
        self.script, self.code = b'VERSION="v0.1.10"', 0
        monitor.fetch_script = lambda url: self.script
        self.assertIsNone(self.run_install(monitor)["install"])  # Retry

    def test_only_the_offered_newer_version_can_be_installed(self):
        monitor = self.monitor()
        with self.assertRaises(ValueError):
            monitor.install("0.1.10")  # nothing offered yet
        monitor.check()
        for version in ["0.1.8", "0.1.11", ""]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                monitor.install(version)

    def test_next_service_reports_how_an_interrupted_update_ended(self):
        (self.root / "updates.json").write_text(json.dumps({"installing": "0.1.10"}))
        self.assertEqual(self.monitor("0.1.9").snapshot()["install"], {"version": "0.1.10", "state": "failed"})
        self.assertIsNone(self.monitor("0.1.10").snapshot()["install"])
        self.assertIsNone(self.monitor("0.1.10-windows-beta.1", "windows").snapshot()["install"])

    def run_helper(self, osascript_answer="", capture_quits_after=1):
        """The Mac helper with stub tools: pgrep reports Capture running for `capture_quits_after` calls."""
        bin_dir, home = self.root / "bin", self.root / "home"
        (home / ".local/bin").mkdir(parents=True, exist_ok=True)
        bin_dir.mkdir(exist_ok=True)
        calls, count = self.root / "calls", self.root / "pgrep-count"
        calls.write_text(""); count.write_text("0")
        stubs = {"pkill": "", "open": "", "sleep": "", "osascript": f'echo "{osascript_answer}"',
                 "pgrep": f'n=$(($(cat "{count}") + 1)); echo $n > "{count}"; [ $n -le {capture_quits_after} ]'}
        for name, body in stubs.items():
            (bin_dir / name).write_text(f'#!/bin/bash\necho "{name} $*" >> "{calls}"\n{body}\n')
        (home / ".local/bin/meeting-copilot").write_text(f'#!/bin/sh\necho "meeting-copilot" >> "{calls}"\n')
        folder = self.root / "update-x"
        folder.mkdir(exist_ok=True)
        installer = folder / "install.sh"
        installer.write_text(f'echo "installer" >> "{calls}"; exit 3\n')
        for path in [*bin_dir.iterdir(), home / ".local/bin/meeting-copilot"]:
            path.chmod(0o755)
        command = release_updates.installer_command("macos", installer)
        # The helper's own command line cannot match its (and install.sh's) Capture pattern.
        self.assertIsNone(re.search(r"/MeetingCopilotCapture(\s|$)", " ".join(command)))
        result = subprocess.run(command, env={"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(home)},
                                capture_output=True, text=True, timeout=90)
        self.assertFalse(folder.exists())
        return result.returncode, [line.split(" ")[0] for line in calls.read_text().splitlines()]

    @unittest.skipIf(os.name == "nt", "the Mac helper is bash")
    def test_mac_helper_quits_capture_normally_installs_and_opens_the_window(self):
        self.assertEqual(self.run_helper(), (3, ["pgrep", "osascript", "pgrep", "pgrep", "installer", "meeting-copilot"]))
        # macOS pgrep hides ancestors without -a, and Capture is this helper's (MEETONTRACK-142).
        self.assertTrue(all(line.startswith("pgrep -af ") for line in (self.root / "calls").read_text().splitlines()
                            if line.startswith("pgrep")))

    @unittest.skipIf(os.name == "nt", "the Mac helper is bash")
    def test_mac_helper_never_installs_or_signals_while_capture_keeps_running(self):
        for answer in ["execution error: User canceled. (-128)",
                       "execution error: Not authorized to send Apple events (-1743)"]:
            with self.subTest(answer=answer):
                code, calls = self.run_helper(answer, capture_quits_after=10 ** 6)
                self.assertEqual(code, 75)
                self.assertNotIn("installer", calls)
                self.assertNotIn("pkill", calls)

    def test_withdrawn_release_is_not_installed_from_the_cached_offer(self):
        monitor = self.monitor()
        monitor.check()
        monitor.fetch = lambda: []
        self.assertEqual(self.run_install(monitor)["install"]["state"], "failed")
        self.assertEqual((self.fetched, self.spawned), ([], []))

    def test_service_counts_an_active_capture_as_recording_whatever_recognition_reports(self):
        import server
        with patch.object(server.TRANSCRIPT, "status", "error"), \
                patch.object(server.RECORDING_LOCATIONS, "active", return_value=None):
            self.assertFalse(server.UPDATES.recording())
        with patch.object(server.TRANSCRIPT, "status", "unavailable"), \
                patch.object(server.RECORDING_LOCATIONS, "active", return_value={"pid": 1}):
            self.assertTrue(server.UPDATES.recording())
        with patch.object(server.TRANSCRIPT, "status", "paused"), \
                patch.object(server.RECORDING_LOCATIONS, "active", return_value=None):
            self.assertTrue(server.UPDATES.recording())

    def test_http_install_keeps_origin_guard(self):
        import server
        monitor = self.monitor()
        monitor.check()
        with patch.object(server, "UPDATES", monitor):
            http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = Request(f"http://127.0.0.1:{http.server_port}/api/updates/install", data=b'{"version":"0.1.10"}',
                                  headers={"Content-Type": "application/json", "Origin": "https://evil.example"})
                with self.assertRaises(HTTPError) as failure:
                    urlopen(request)
                self.assertEqual(failure.exception.code, 403)
                failure.exception.close()
                request.remove_header("Origin")
                with self.assertRaises(HTTPError) as failure:
                    urlopen(request)  # not from the app's page
                self.assertEqual(failure.exception.code, 403)
                failure.exception.close()
                self.assertEqual(self.fetched, [])
                self.recording = True
                request.add_header("Origin", f"http://127.0.0.1:{http.server_port}")
                with urlopen(request) as response:
                    self.assertEqual(json.load(response)["updates"]["install"]["state"], "scheduled")
            finally:
                http.shutdown()
                http.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
