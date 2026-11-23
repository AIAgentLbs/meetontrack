"""MEETONTRACK-189 P1-10: a report built without the other side says so at the top."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from archive import MeetingArchive, capture_problem_lines


class CaptureProblemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / "config").mkdir()
        (root / "recordings").mkdir()
        self.recordings = root / "recordings"
        self.archive = MeetingArchive(self.recordings, root / "archive", root / "reports", root / "config")

    def test_recording_meta_reaches_the_detail(self):
        folder = self.recordings / "2026.01.05-1000 Example call"
        folder.mkdir()
        (folder / "meta.json").write_text(json.dumps({
            "started": "2026-01-05T09:00:00Z", "ended": "2026-01-05T09:30:00Z", "duration_seconds": 1800,
            "trigger": "mic-activity", "stop_reason": "call-ended",
            "capture_problems": ["far_end_not_recorded"],
        }))
        meeting_id = "recording-" + hashlib.sha1(folder.name.encode("utf-8")).hexdigest()[:16]
        detail = self.archive.detail(meeting_id)
        self.assertEqual(detail["capture_problems"], ["far_end_not_recorded"])

    def test_report_opens_with_the_problem(self):
        detail = {"meeting_id": "sample", "title": "Example", "started_at": "2026-01-05T09:00:00Z",
                  "duration_seconds": 1800, "transcript": [], "journal": [], "meeting_chat": [],
                  "capture_problems": ["far_end_not_recorded"]}
        page = self.archive._report_html(detail, [])
        self.assertIn("Собеседник не записан", page)
        self.assertLess(page.index("Собеседник не записан"), page.index('id="overview"'))
        clean = self.archive._report_html({**detail, "capture_problems": []}, [])
        self.assertNotIn("Собеседник не записан", clean)

    def _deliver(self, settings: dict) -> list:
        config = Path(self.temp.name) / "config"
        (config / "telegram.env").write_text("# Synthetic fixture: no credentials")
        (config / "delivery.json").write_text(json.dumps(settings), encoding="utf-8")
        pdf = Path(self.temp.name) / "meeting-report.pdf"
        pdf.write_bytes(b"%PDF-test")
        detail = {"meeting_id": "meeting-1", "title": "Test call",
                  "started_at": datetime.now().astimezone().isoformat(),
                  "ended_at": (datetime.now().astimezone() - timedelta(minutes=5)).isoformat(),
                  "status": "finished", "final_transcript": "1:1",
                  "capture_problems": ["far_end_not_recorded"]}
        with patch.object(self.archive.delivery_settings, "executable", return_value="/fake/gws-personal"), \
             patch("archive.subprocess.run", return_value=subprocess.CompletedProcess(
                 [], 0, '{"id":"sent","ok":true,"status":"sent","message_id":7}', "")) as run:
            self.archive.deliver(detail, {"pdf_path": str(pdf)})
        return [call.args[0] for call in run.call_args_list]

    def test_memo_mail_and_telegram_say_the_other_side_was_not_recorded(self):
        commands = self._deliver({"email_to": "owner@example.com", "google_account": "owner@example.com",
                                  "drive_enabled": False, "telegram_enabled": True,
                                  "telegram_account": "synthetic",
                                  "telegram_config": str(Path(self.temp.name) / "config" / "telegram.env")})
        mail = next(command for command in commands if "gmail" in command)
        self.assertTrue(mail[mail.index("--body") + 1].startswith("Собеседник не записан"))
        telegram = next(command for command in commands if command[0] == sys.executable)
        self.assertIn("Собеседник не записан", telegram[telegram.index("--note") + 1])

    def test_silent_or_speechless_sessions_are_not_undelivered_reports(self):
        """P1-8 and step 7: a lost grant shows the permission to fix; silence or no speech shows nothing."""
        ended = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        snapshot = {"status": "finished"}
        silent = {"transcription_failed": "no_audio_captured: neither track carried any sound"}
        self.assertIsNone(self.archive._final_wait(snapshot, ended, None, silent))
        self.assertIsNone(self.archive._final_wait(
            snapshot, ended, None, {"transcription_failed": "No speech was recognized; audio kept for a manual retry."}))
        denied = self.archive._final_wait(snapshot, ended, None, {**silent, "far_end_cause": "system_audio_permission"})
        self.assertEqual((denied["state"], denied["reason"], denied["permission"]),
                         ("missing", "capture_permission", "call_audio"))
        mic = self.archive._final_wait(snapshot, ended, None, {**silent, "mic_start": "denied"})
        self.assertEqual(mic["permission"], "microphone")
        self.assertEqual(self.archive._final_wait(snapshot, ended, None, {})["reason"], "final_transcript")

    def test_missing_microphone_is_said(self):
        lines = capture_problem_lines({"capture_problems": ["mic_not_recorded"]})
        self.assertEqual(len(lines), 1)
        self.assertIn("микрофон", lines[0])

    def test_unknown_codes_are_not_shown(self):
        self.assertEqual(capture_problem_lines({"capture_problems": ["something_new"]}), [])
        self.assertEqual(len(capture_problem_lines({"capture_problems": ["far_end_not_recorded"]})), 1)


if __name__ == "__main__":
    unittest.main()
