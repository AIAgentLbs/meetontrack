"""Installer regressions in temporary directories; no real app/provider changes."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="meeting-installer-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "fixture & test"
        self.root.mkdir()
        self.mock = self.root / "mock-bin"
        self.mock.mkdir()
        self.package = self.root / "package.zip"
        app = "Meeting Copilot Capture.app"
        payload = f"{app}/Contents/Resources/payload"
        files = {
            "release.json": json.dumps({"version": "0.1.9", "channel": "technical-beta"}),
            f"{app}/Contents/MacOS/MeetingCopilotCapture": "synthetic-app",
            f"{payload}/web/server.py": "print('synthetic-server')\n",
            f"{payload}/bin/meeting-copilot": "#!/bin/sh\nexit 0\n",
            f"{payload}/config/SESSION.md": "synthetic-session\n",
            f"{payload}/config/delivery.json.example": "{}\n",
            f"{payload}/config/refresh-repos.py": "from pathlib import Path\np=Path(__file__).parent/'repos.json'\np.write_text('{\"repositories\": []}')\n",
            f"{payload}/python/bin/python3": '#!/bin/sh\nexec "$TEST_PYTHON" "$@"\n',
        }
        helpers = ("zoom-window-finder", "zoom-frame-inspector", "detect-speech-language")
        for name in helpers:
            files[f"{payload}/bin/{name}"] = "#!/bin/sh\nexit 0\n"
        with zipfile.ZipFile(self.package, "w") as handle:
            for name, body in files.items():
                entry = zipfile.ZipInfo(name)
                entry.external_attr = (0o100755 if name.split("/")[-1] in (*helpers, 'python3') else 0o100644) << 16
                handle.writestr(entry, body)
        self.env = os.environ | {
            "PATH": f"{self.mock}:/usr/bin:/bin:/usr/sbin:/sbin",
            "MEETING_COPILOT_ASSET_URL": "https://example.invalid/synthetic.zip",
            "MEETING_COPILOT_ASSET_SHA256": hashlib.sha256(self.package.read_bytes()).hexdigest(),
            "MEETING_COPILOT_APP_ROOT": str(self.root / "Applications"),
            "MEETING_COPILOT_SHARE_ROOT": str(self.root / "share"),
            "MEETING_COPILOT_CONFIG_ROOT": str(self.root / "config"),
            "MEETING_COPILOT_BIN_ROOT": str(self.root / "bin"),
            "MEETING_COPILOT_AGENTS_ROOT": str(self.root / "agents"),
            "MEETING_COPILOT_TRASH_ROOT": str(self.root / "Trash"),
            "MEETING_COPILOT_SKIP_LAUNCH": "1",
            "FIXTURE_PACKAGE": str(self.package), "FIXTURE_ROOT": str(self.root),
            "TEST_PYTHON": sys.executable, "HOME": str(self.root / "home"),
        }
        Path(self.env["MEETING_COPILOT_APP_ROOT"]).mkdir()
        self.script("python3", 'touch "$FIXTURE_ROOT/system-python"\nexit 99')
        self.script("uname", 'if [ "$1" = -s ]; then echo "${MOCK_OS:-Darwin}"; else echo "${MOCK_ARCH:-arm64}"; fi')
        self.script("sw_vers", 'echo "${MOCK_VERSION:-15.0}"')
        self.script("codex", 'exit "${MOCK_CODEX_EXIT:-0}"')
        self.script("pgrep", 'if [ "${MOCK_CAPTURE:-0}" = 1 ]; then echo 999; exit 0; fi\nif [ "${MOCK_CAPTURE_AFTER_STAGE:-0}" = 1 ] && [ -f "$FIXTURE_ROOT/downloaded" ]; then echo 999; exit 0; fi\nexit 1')
        self.script("curl", 'touch "$FIXTURE_ROOT/downloaded"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp "$FIXTURE_PACKAGE" "$2"; exit 0; fi; shift; done\nexit 2')
        self.script("swiftc", 'touch "$FIXTURE_ROOT/compiled"\nexit 99')
        for name in ("open", "launchctl"):
            self.script(name, 'touch "$FIXTURE_ROOT/unexpected-launch"\nexit 99')

    def script(self, name, body):
        path = self.mock / name
        path.write_text("#!/bin/bash\nset -eu\n" + body + "\n")
        path.chmod(0o755)

    def run_install(self, **environment):
        return subprocess.run(["/bin/bash", str(ROOT / "install.sh")], env=self.env | environment,
                              text=True, capture_output=True, timeout=30)

    def seed_existing(self):
        """A 0.1.18 install: app, launchd agent, separate python/web/bin copies, user data."""
        app = Path(self.env["MEETING_COPILOT_APP_ROOT"]) / "Meeting Copilot Capture.app"
        app.mkdir()
        (app / "previous").write_text("previous-app")
        share, config = Path(self.env["MEETING_COPILOT_SHARE_ROOT"]), Path(self.env["MEETING_COPILOT_CONFIG_ROOT"])
        for program in ("web", "python/bin", "bin"):
            (share / program).mkdir(parents=True)
        (share / "web/previous").write_text("previous-web")
        (share / "web/server.log").write_text("old log")
        (share / "python/bin/python3").write_text("old python")
        (share / "release.json").write_text('{"version": "0.1.18"}')
        for helper in ("zoom-window-finder", "zoom-frame-inspector", "detect-speech-language"):
            (share / "bin" / helper).write_text("old helper")
        for data in ("recordings/keep.txt", "archive/a/meeting.md", "reports/r.pdf", "models/m.bin", "meeting-copilot-live.json"):
            (share / data).parent.mkdir(parents=True, exist_ok=True)
            (share / data).write_text("synthetic-" + data)
        config.mkdir()
        (config / "delivery.json").write_text("synthetic-private-settings")
        (config / "config.json").write_text('{"interface_language": "ru", "ai": {"choice": "x"}}\n')
        (config / "SESSION.md").write_text("keep-session")
        (config / "active-repos.json").write_text('{"repositories": ["keep-selection"]}')
        agents = Path(self.env["MEETING_COPILOT_AGENTS_ROOT"])
        agents.mkdir()
        (agents / "com.aiagentlbs.meeting-copilot.plist").write_text("legacy agent")
        return app, share, config

    def prepare_launch(self):
        # Only the OS/browser boundary is replaced; execute the real installer.
        # Fake launchd: "loaded" marks a registered job. After bootout it can
        # linger for MOCK_UNLOAD_AFTER_PRINTS checks; bootstrap of a still
        # registered label fails with error 5, as observed on macOS.
        self.script("launchctl", '''
printf "%s\\n" "$*" >> "$FIXTURE_ROOT/launches"
loaded="$FIXTURE_ROOT/loaded"; lingering="$FIXTURE_ROOT/lingering"
case "$1" in
  bootout)
    [ -f "$loaded" ] || exit 3
    if [ "${MOCK_UNLOAD_AFTER_PRINTS:-0}" -gt 0 ]; then echo "$MOCK_UNLOAD_AFTER_PRINTS" > "$lingering"; else rm -f "$loaded"; fi
    exit 0;;
  print)
    [ -f "$loaded" ] || exit 113
    [ -f "$lingering" ] || exit 0
    left=$(<"$lingering")
    if [ "$left" -le 0 ]; then rm -f "$loaded" "$lingering"; exit 113; fi
    echo $((left-1)) > "$lingering"; exit 0;;
  bootstrap)
    count=0
    [ ! -f "$FIXTURE_ROOT/bootstrap-count" ] || count=$(<"$FIXTURE_ROOT/bootstrap-count")
    count=$((count+1)); printf "%s" "$count" > "$FIXTURE_ROOT/bootstrap-count"
    if [ -f "$loaded" ] || [ "$count" -le "${MOCK_BOOTSTRAP_FAILURES:-0}" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2; exit 5
    fi
    touch "$loaded"; exit 0;;
esac
''')
        self.script("open", '''
if [ "$1" = "http://127.0.0.1:43121/" ]; then
  [ -f "$FIXTURE_ROOT/healthy" ] || exit 77
fi
printf "%s\\n" "$*" >> "$FIXTURE_ROOT/opened"
''')
        self.script("sleep", 'exit 0')
        self.script("curl", '''
case "$*" in
  *http://127.0.0.1:${MOCK_HEALTH_PORT:-43121}/api/health*)
    count=0
    [ ! -f "$FIXTURE_ROOT/health-count" ] || count=$(<"$FIXTURE_ROOT/health-count")
    count=$((count+1))
    printf "%s" "$count" > "$FIXTURE_ROOT/health-count"
    [ "$count" -ge "${MOCK_HEALTH_READY_AFTER:-2}" ] || exit 7
    if [ "${MOCK_WRONG_SERVICE:-0}" = 1 ]; then
      printf '{"ok":true,"service":"different-app"}'
    else
      touch "$FIXTURE_ROOT/healthy"
      printf '{"ok":true,"service":"meeting-copilot","version":"%s","instance":"%s"}' "${MOCK_HEALTH_VERSION:-0.1.9}" "${MOCK_HEALTH_INSTANCE-app-token}"
    fi
    exit 0;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then cp "$FIXTURE_PACKAGE" "$2"; exit 0; fi
  shift
done
exit 2
''')

    def test_install_opens_the_app_and_waits_for_its_own_service(self):
        self.prepare_launch()
        result = self.run_install(MEETING_COPILOT_SKIP_LAUNCH="0")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        # One app, no browser tab: the app shows the assistant in its own window.
        self.assertEqual((self.root / "opened").read_text().splitlines(),
                         [str(self.root / "Applications/Meeting Copilot Capture.app")])
        self.assertEqual((self.root / "health-count").read_text(), "2")
        self.assertFalse((self.root / "launches").exists())

    def test_install_finds_the_service_on_the_port_the_app_recorded(self):
        """MEETONTRACK-130: another program held 43121, so the app runs its service elsewhere."""
        share = Path(self.env["MEETING_COPILOT_SHARE_ROOT"])
        share.mkdir()
        (share / "server-port").write_text("50123\n")
        for port in ("50123", "43121"):  # a stale record must not break the install either
            with self.subTest(port=port):
                for name in ("opened", "health-count", "healthy"):
                    (self.root / name).unlink(missing_ok=True)
                self.prepare_launch()
                result = self.run_install(MEETING_COPILOT_SKIP_LAUNCH="0", MOCK_HEALTH_PORT=port)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                self.assertEqual((self.root / "health-count").read_text(), "2")

    def test_unready_unrelated_or_old_service_is_not_success(self):
        for environment in ({"MOCK_WRONG_SERVICE": "1"}, {"MOCK_HEALTH_VERSION": "0.1.18"},
                            {"MOCK_HEALTH_INSTANCE": ""}):  # started by hand, not by the app
            with self.subTest(environment=environment):
                for name in ("opened", "health-count", "healthy"):
                    (self.root / name).unlink(missing_ok=True)
                self.prepare_launch()
                result = self.run_install(MEETING_COPILOT_SKIP_LAUNCH="0", **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("did not become ready", result.stderr)
                self.assertLessEqual(int((self.root / "health-count").read_text()), 120)

    def test_upgrade_from_0_1_18_retires_agent_and_program_copies_only(self):
        app, share, config = self.seed_existing()
        settings = (config / "config.json").read_bytes()
        self.prepare_launch()
        (self.root / "loaded").touch()
        result = self.run_install(MEETING_COPILOT_SKIP_LAUNCH="0", MOCK_UNLOAD_AFTER_PRINTS="3")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        launches = (self.root / "launches").read_text()
        self.assertIn("bootout", launches)
        self.assertNotIn("bootstrap", launches)
        self.assertFalse((self.root / "loaded").exists())
        self.assertFalse((Path(self.env["MEETING_COPILOT_AGENTS_ROOT"]) / "com.aiagentlbs.meeting-copilot.plist").exists())
        for program in ("python", "web", "bin", "release.json"):
            self.assertFalse((share / program).exists(), program)
        for data in ("recordings/keep.txt", "archive/a/meeting.md", "reports/r.pdf", "models/m.bin", "meeting-copilot-live.json"):
            self.assertEqual((share / data).read_text(), "synthetic-" + data)
        self.assertEqual((config / "config.json").read_bytes(), settings)
        self.assertEqual((config / "delivery.json").read_text(), "synthetic-private-settings")
        self.assertTrue((app / "Contents/Resources/payload/web/server.py").is_file())
        self.assert_single_app_and_no_backups(app, share)
        self.assertEqual((self.root / "opened").read_text().splitlines(), [str(app)])

    def assert_0_1_18_intact(self, app, share):
        self.assertEqual((app / "previous").read_text(), "previous-app")
        self.assertEqual((share / "web/previous").read_text(), "previous-web")
        self.assertTrue((share / "python/bin/python3").is_file())
        self.assertTrue((share / "bin/zoom-window-finder").is_file())
        self.assertTrue((Path(self.env["MEETING_COPILOT_AGENTS_ROOT"]) / "com.aiagentlbs.meeting-copilot.plist").is_file())
        self.assert_single_app_and_no_backups(app, share)

    def test_new_app_not_ready_restores_0_1_18_and_restarts_its_service(self):
        app, share, _ = self.seed_existing()
        self.prepare_launch()
        (self.root / "loaded").touch()
        result = self.run_install(MEETING_COPILOT_SKIP_LAUNCH="0", MOCK_HEALTH_VERSION="0.1.18")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("previous version was restored", result.stderr)
        self.assert_0_1_18_intact(app, share)
        launches = (self.root / "launches").read_text().splitlines()
        self.assertTrue(launches[0].startswith("bootout"))
        self.assertTrue(launches[-1].startswith("bootstrap"))
        self.assertTrue((self.root / "loaded").exists())

    def test_rolled_back_install_restores_the_settings_it_migrated(self):
        """MEETONTRACK-125: the retired-key removal is undone when the new app is not proven."""
        app, share, config = self.seed_existing()
        settings = json.dumps({"analytics": True, "keep_audio": True}).encode()
        (config / "config.json").write_bytes(settings)
        (config / "analytics.json").write_text("synthetic-retired-state")
        self.prepare_launch()
        (self.root / "loaded").touch()
        result = self.run_install(MEETING_COPILOT_SKIP_LAUNCH="0", MOCK_HEALTH_VERSION="0.1.18")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((config / "config.json").read_bytes(), settings)
        self.assertEqual((config / "analytics.json").read_text(), "synthetic-retired-state")
        self.assertFalse((config / "analytics-pending.json").exists())
        self.assert_0_1_18_intact(app, share)

    def test_old_service_that_will_not_stop_changes_nothing(self):
        app, share, _ = self.seed_existing()
        self.prepare_launch()
        (self.root / "loaded").touch()
        result = self.run_install(MEETING_COPILOT_SKIP_LAUNCH="0", MOCK_UNLOAD_AFTER_PRINTS="99")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not stop", result.stderr)
        self.assert_0_1_18_intact(app, share)
        self.assertFalse((self.root / "opened").exists())

    def test_failure_after_cli_restores_the_old_cli(self):
        app, share, config = self.seed_existing()
        cli = Path(self.env["MEETING_COPILOT_BIN_ROOT"]) / "meeting-copilot"
        cli.parent.mkdir()
        cli.write_text("old cli")
        (config / "config.json").write_text("{not json")  # the settings step fails after the CLI
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(cli.read_text(), "old cli")
        self.assert_0_1_18_intact(app, share)

    def test_user_files_in_old_bin_survive(self):
        _, share, _ = self.seed_existing()
        (share / "bin/mine").write_text("not ours")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(sorted(path.name for path in (share / "bin").iterdir()), ["mine"])

    def test_fresh_install_is_one_app_with_its_own_service(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        share = Path(self.env["MEETING_COPILOT_SHARE_ROOT"])
        app = Path(self.env["MEETING_COPILOT_APP_ROOT"]) / "Meeting Copilot Capture.app"
        self.assertTrue((app / "Contents/Resources/payload/web/server.py").is_file())
        self.assertTrue((app / "Contents/Resources/payload/bin/detect-speech-language").is_file())
        for program in ("web", "python", "bin", "release.json"):
            self.assertFalse((share / program).exists(), program)
        self.assertFalse(Path(self.env["MEETING_COPILOT_AGENTS_ROOT"]).exists())
        self.assertTrue((Path(self.env["MEETING_COPILOT_BIN_ROOT"]) / "meeting-copilot").is_file())
        self.assertFalse((self.root / "unexpected-launch").exists())
        self.assertFalse((self.root / "compiled").exists())
        self.assertFalse((self.root / "system-python").exists())
        preferences = Path(self.env["MEETING_COPILOT_CONFIG_ROOT"]) / "active-repos.json"
        self.assertEqual(json.loads(preferences.read_text())["repositories"], [])

    def assert_single_app_and_no_backups(self, app, share):
        self.assertEqual([path.name for path in app.parent.iterdir()], [app.name])
        self.assertEqual(list(share.glob("*.backup-*")) + list(share.glob("backups/*/*.app")), [])

    def test_reinstall_preserves_data_and_leaves_no_app_copies(self):
        app, share, config = self.seed_existing()
        for _ in range(2):
            result = self.run_install()
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue((app / "Contents/MacOS/MeetingCopilotCapture").is_file())
        self.assertFalse((app / "previous").exists())
        self.assert_single_app_and_no_backups(app, share)
        self.assertEqual((share / "recordings/keep.txt").read_text(), "synthetic-recordings/keep.txt")
        self.assertEqual((config / "delivery.json").read_text(), "synthetic-private-settings")
        self.assertEqual((config / "SESSION.md").read_text(), "keep-session")
        self.assertEqual(json.loads((config / "active-repos.json").read_text())["repositories"], ["keep-selection"])

    def test_old_leftovers_move_to_trash(self):
        app, share, _ = self.seed_existing()
        stale = [app.parent / "Meeting Copilot Capture.backup-20261001-1.app", share / "web.backup-20261001-1",
                 share / "python.backup-20261001-1", share / "backups/20261020T1-brand-refresh/previous.app"]
        for path in stale:
            path.mkdir(parents=True)
            (path / "old").write_text("old")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assert_single_app_and_no_backups(app, share)
        self.assertEqual(sorted(path.name for path in (self.root / "Trash").iterdir()),
                         sorted(path.name for path in stale))

    def test_failure_partway_restores_previous_version(self):
        app, share, _ = self.seed_existing()
        # The command-line tool is installed after the app was replaced.
        Path(self.env["MEETING_COPILOT_BIN_ROOT"]).write_text("not a directory")
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("previous version was restored", result.stderr)
        self.assertEqual((app / "previous").read_text(), "previous-app")
        # Before the commit point the old install is untouched and still runs.
        self.assertEqual((share / "web/previous").read_text(), "previous-web")
        self.assertTrue((share / "python/bin/python3").is_file())
        self.assertTrue((Path(self.env["MEETING_COPILOT_AGENTS_ROOT"]) / "com.aiagentlbs.meeting-copilot.plist").is_file())
        self.assert_single_app_and_no_backups(app, share)

    def test_checksum_failure_never_replaces_app(self):
        app, share, _ = self.seed_existing()
        result = self.run_install(MEETING_COPILOT_ASSET_SHA256="0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertTrue((app / "previous").is_file())
        self.assertTrue((share / "web/previous").is_file())
        self.assertFalse((self.root / "compiled").exists())

    def test_missing_release_identity_never_replaces_installed_app(self):
        app, share, _ = self.seed_existing()
        with zipfile.ZipFile(self.package) as archive:
            files = {name: archive.read(name) for name in archive.namelist() if name != "release.json"}
        with zipfile.ZipFile(self.package, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        result = self.run_install(MEETING_COPILOT_ASSET_SHA256=hashlib.sha256(self.package.read_bytes()).hexdigest())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Release file is missing: release.json", result.stderr)
        self.assertTrue((app / "previous").is_file())
        self.assertTrue((share / "web/previous").is_file())
        self.assertFalse((self.root / "compiled").exists())

    def test_reinstall_removes_only_retired_usage_settings_and_state(self):
        _, share, config = self.seed_existing()
        (config / "config.json").write_text(json.dumps({"analytics": True, "keep_audio": True}))
        for name in ("analytics.json", "analytics-pending.json"):
            (config / name).write_text("synthetic-retired-state")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(json.loads((config / "config.json").read_text()), {"keep_audio": True})
        for name in ("analytics.json", "analytics-pending.json"):
            self.assertFalse((config / name).exists())
        self.assertEqual((share / "recordings/keep.txt").read_text(), "synthetic-recordings/keep.txt")

    def test_missing_packaged_helper_never_replaces_app(self):
        app, _, _ = self.seed_existing()
        with zipfile.ZipFile(self.package) as archive:
            files = [(entry, archive.read(entry)) for entry in archive.infolist()
                     if not entry.filename.endswith("payload/bin/detect-speech-language")]
        with zipfile.ZipFile(self.package, "w") as archive:
            for entry, data in files:
                archive.writestr(entry, data)
        result = self.run_install(MEETING_COPILOT_ASSET_SHA256=hashlib.sha256(self.package.read_bytes()).hexdigest())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Release helper is missing", result.stderr)
        self.assertTrue((app / "previous").is_file())

    def test_ai_is_optional_and_no_local_compilation_is_required(self):
        result = self.run_install(MOCK_CODEX_EXIT="127")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertFalse((self.root / "compiled").exists())

    def test_running_capture_blocks_before_download(self):
        app, _, _ = self.seed_existing()
        result = self.run_install(MOCK_CAPTURE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Quit Meeting Copilot Capture", result.stderr)
        self.assertTrue((app / "previous").is_file())
        self.assertFalse((self.root / "downloaded").exists())

    def test_capture_started_during_staging_is_also_protected(self):
        app, _, _ = self.seed_existing()
        result = self.run_install(MOCK_CAPTURE_AFTER_STAGE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Quit Meeting Copilot Capture", result.stderr)
        self.assertTrue((app / "previous").is_file())

    def test_platform_and_dependency_failures_stop_before_download(self):
        for environment in ({"MOCK_OS": "Linux"}, {"MOCK_ARCH": "x86_64"},
                            {"MOCK_VERSION": "14.7"}):
            with self.subTest(environment=environment):
                result = self.run_install(**environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "downloaded").exists())

    def test_alternate_download_requires_explicit_digest(self):
        self.env.pop("MEETING_COPILOT_ASSET_SHA256")
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("alternate asset URL requires", result.stderr)
        self.assertFalse((self.root / "downloaded").exists())


if __name__ == "__main__":
    unittest.main()
