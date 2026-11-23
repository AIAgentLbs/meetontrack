"""MEETONTRACK-189 P1-11 and P1-12: nothing left behind may hold every later report back."""

import io
import json
import os
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from archive import MeetingArchive
from recording_health import marker_state, process_started, stuck_markers


class StuckMarkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / "config").mkdir()
        self.recordings = root / "recordings"
        self.recordings.mkdir()
        self.reports = root / "reports"
        self.archive = MeetingArchive(self.recordings, root / "archive", self.reports, root / "config")

    def marker(self, name: str, content) -> Path:
        folder = self.recordings / name
        folder.mkdir()
        path = folder / ".recording.json"
        path.write_text(content if isinstance(content, str) else json.dumps(content))
        return path

    def test_marker_states(self):
        live = self.marker("live", {"pid": os.getpid(), "started": "2026-01-05T09:00:00Z"})
        dead = self.marker("dead", {"pid": 2_147_483_000, "started": "2026-01-05T09:00:00Z"})
        unreadable = self.marker("unreadable", "{not json")
        stale = self.marker("stale", {"pid": 2**80})  # out of range: cannot be checked
        old_live = self.marker("old-live", {"pid": os.getpid()})
        old = time.time() - 13 * 3600
        os.utime(stale, (old, old))
        os.utime(old_live, (old, old))

        self.assertEqual(marker_state(live), "live")
        self.assertEqual(marker_state(dead), "dead")
        self.assertEqual(marker_state(unreadable), "live", "a fresh unreadable marker still holds reports back")
        self.assertEqual(marker_state(stale), "stale")
        self.assertEqual(marker_state(old_live), "stale", "an owner that cannot be confirmed gets 12 hours")
        self.assertEqual({item["reason"] for item in stuck_markers([live, dead, stale, unreadable])},
                         {"dead", "stale"})

    @unittest.skipIf(os.name == "nt", "the Windows recorder writes no start time")
    def test_recycled_pid_is_dead(self):
        started = process_started(os.getpid())
        self.assertIsNotNone(started)
        mine = self.marker("mine", {"pid": os.getpid(), "pid_started": started})
        recycled = self.marker("recycled", {"pid": os.getpid(), "pid_started": started - 3600})
        old_mine = self.marker("old-mine", {"pid": os.getpid(), "pid_started": started + 0.4})
        old = time.time() - 13 * 3600
        os.utime(old_mine, (old, old))
        self.assertEqual(marker_state(mine), "live")
        self.assertEqual(marker_state(recycled), "dead", "a live pid that started later is someone else")
        self.assertEqual(marker_state(old_mine), "live", "a confirmed owner holds reports back at any age")
        with patch("recording_health.process_started", return_value=None):
            self.assertEqual(marker_state(old_mine), "stale", "unreadable start time: the 12-hour rule")

    def test_dead_marker_does_not_hold_reports_back(self):
        self.marker("dead", {"pid": 2_147_483_000, "started": "2026-01-05T09:00:00Z"})
        self.assertFalse(self.archive._capture_active())
        self.marker("live", {"pid": os.getpid(), "started": "2026-01-05T09:00:00Z"})
        self.assertTrue(self.archive._capture_active())

    def test_one_failing_report_does_not_block_the_retry_scan(self):
        for name in ("older", "newer"):
            (self.reports / name).mkdir(parents=True)
            (self.reports / name / "report.json").write_text("{}")
        (self.config_file()).write_text("{}")
        os.utime(self.reports / "older" / "report.json", (time.time() - 60, time.time() - 60))
        tried = []

        def retry(path, settings, now):
            tried.append(path.parent.name)
            if path.parent.name == "newer":
                raise RuntimeError("synthetic failure")
            return True

        with patch.object(self.archive, "_retry_report", side_effect=retry), redirect_stderr(io.StringIO()):
            retried = self.archive.retry_pending_deliveries()
        self.assertEqual(tried, ["newer", "older"])
        self.assertEqual(retried, 1)
        failed = json.loads((self.reports / "newer" / "report.json").read_text())
        self.assertIn("RuntimeError: synthetic failure", failed["delivery_error"])
        self.assertTrue(failed["delivery_retry_at"])

    def test_delivery_stops_after_three_automatic_attempts_and_is_then_shown(self):
        """MEETONTRACK-189 step 7: three attempts with backoff, then the person sees which report."""
        from datetime import datetime, timedelta
        self.config_file().write_text(json.dumps({"email_enabled": True}))
        (self.reports / "m1").mkdir(parents=True)
        now = datetime.now().astimezone()
        meta = {"generated_at": (now - timedelta(hours=3)).isoformat(), "mail_status": "failed",
                "delivery_attempts": 3, "delivery_retry_at": (now - timedelta(minutes=1)).isoformat()}
        path = self.reports / "m1" / "report.json"
        path.write_text(json.dumps(meta))
        self.assertFalse(self.archive._retry_report(path, {"email_enabled": True}, now), "no fourth attempt")
        health = self.archive.delivery_health()
        self.assertIn("m1", [item["meeting_id"] for item in health["undelivered"]])
        path.write_text(json.dumps({**meta, "delivery_attempts": 1}))
        self.assertNotIn("m1", [item["meeting_id"] for item in self.archive.delivery_health()["undelivered"]],
                         "still retrying: not the person's problem yet")
        # A sign-in keeps its own action after the retries are spent: Send again cannot fix it.
        path.write_text(json.dumps({**meta, "mail_status": "auth_required"}))
        health = self.archive.delivery_health()
        self.assertEqual([issue["reason"] for issue in health["channels"]["gmail"]["issues"]], ["auth_required"])

    def config_file(self) -> Path:
        return Path(self.temp.name) / "config" / "delivery.json"


if __name__ == "__main__":
    unittest.main()
