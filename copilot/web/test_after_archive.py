"""MEETONTRACK-163: the report carries the person's edits and waits for the send gate.

All names, texts and addresses are invented.
"""

import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from archive import MeetingArchive


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class AfterArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        config = root / "config"
        config.mkdir()
        (config / "delivery.json").write_text(json.dumps({"email_enabled": True, "email_to": "synthetic@example.test"}))
        self.archive = MeetingArchive(root / "recordings", root / "archive", root / "reports", config)
        self.reports = root / "reports"
        ended = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=15)
        started = ended - timedelta(minutes=20)
        meeting = root / "archive" / "m1"
        meeting.mkdir(parents=True)
        (meeting / "meeting.json").write_text(json.dumps({
            "version": 1, "meeting_id": "m1", "meeting": "Synthetic planning call", "status": "finished",
            "started_at": iso(started), "updated_at": iso(ended), "latest_at": iso(ended),
            "final_transcript": "synthetic-final",
            "segments": [{"source": "system", "timestamp": iso(started + timedelta(minutes=1)),
                          "text": "We can approve the budget for one quarter."},
                         {"source": "microphone", "timestamp": iso(started + timedelta(minutes=2)),
                          "text": "Then we send the proposal on Friday."}],
        }))
        at = lambda minutes: iso(started + timedelta(minutes=minutes))  # noqa: E731
        (config / "journal.json").write_text(json.dumps({"items": [
            {"id": "j3", "meeting_id": "m1", "category": "FACT", "text": "Budget approved for one quarter.",
             "created_at": at(3)},
            {"id": "j2", "meeting_id": "m1", "category": "COMMITMENT", "text": "We send the proposal on Friday.",
             "created_at": at(4)},
            {"id": "j1", "meeting_id": "m1", "category": "RISK", "text": "Legal review may delay the pilot.",
             "created_at": at(5)},
        ]}))
        self.now = time.time()
        self.archive.after.clock = lambda: self.now
        self.ready = True
        self.sent = 0

        def deliver(detail, meta, **kwargs):
            self.sent += 1
            return {"mail_status": "sent"}

        for name, fake in (("_print_pdf", lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")),
                           ("deliver", deliver),
                           ("_ready_for_delivery", lambda detail: self.ready)):
            patcher = patch.object(self.archive, name, side_effect=fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def report(self) -> dict:
        return json.loads((self.reports / "m1" / "report.json").read_text())

    def page(self) -> str:
        return (self.reports / "m1" / "index.html").read_text(encoding="utf-8")

    def due_retry(self) -> None:
        self.archive.retry_pending_deliveries(meeting_ids=self.archive.after.due())

    def test_first_ready_report_waits_while_shown(self):
        start = self.now
        self.archive.generate_report("m1")
        self.assertEqual(self.sent, 0)
        self.assertTrue(self.report().get("ready_at"))
        self.now = start + 10
        self.due_retry()
        self.assertEqual(self.sent, 0)
        self.now = start + 31
        self.due_retry()
        self.assertEqual(self.sent, 1)

    def test_held_report_never_goes(self):
        self.archive.after.hold("m1")
        self.archive.generate_report("m1")
        self.now += 2 * 3600
        self.archive.retry_pending_deliveries()
        self.due_retry()
        self.assertEqual(self.sent, 0)
        self.archive.after.send_now("m1")
        self.due_retry()
        self.assertEqual(self.sent, 1)
        self.assertTrue(self.report().get("delivery_started_at"))

    def test_held_report_with_the_crm_is_not_a_failure(self):
        """A held report waits on every channel, the CRM included: no delivery failure after 15 min (J, final M1)."""
        settings = {"email_enabled": True, "email_to": "synthetic@example.test", "twenty_enabled": True,
                    "twenty_url": "https://crm.example.test", "twenty_key_saved": True}
        (self.archive.config_root / "delivery.json").write_text(json.dumps(settings))
        self.archive.after.hold("m1")
        self.archive.generate_report("m1")
        self.assertEqual(self.report()["twenty_status"], "waiting_for_end")
        later = datetime.now().astimezone() + timedelta(minutes=20)
        twenty = self.archive.delivery_monitor.snapshot(settings, now=later)["channels"]["twenty"]
        self.assertEqual(twenty["failed"] + twenty["action_required"], 0)

    def test_send_now_waits_for_final_transcript(self):
        self.ready = False
        self.archive.after.send_now("m1")
        self.archive.generate_report("m1")
        self.archive.retry_pending_deliveries()
        self.assertEqual(self.sent, 0)
        self.ready = True
        self.archive.generate_report("m1")
        self.assertEqual(self.sent, 1)

    def test_edit_goes_into_report_and_pauses(self):
        start = self.now
        self.archive.generate_report("m1")
        before = self.archive.source_signature(self.archive.report_detail("m1"))
        self.now = start + 5
        self.archive.after.edit("m1", "summary", "Budget approved for one quarter.\nPilot starts in March.")
        detail = self.archive.report_detail("m1")
        self.assertEqual(self.archive.report_summary(detail),
                         ["Budget approved for one quarter.", "Pilot starts in March."])
        self.assertNotEqual(self.archive.source_signature(detail), before)
        self.archive.generate_report("m1")  # what the next history pass does
        self.assertIn("Pilot starts in March.", self.page())
        self.assertEqual(self.sent, 0)
        self.now = start + 5 + 20
        self.due_retry()
        self.archive.retry_pending_deliveries()
        self.assertEqual(self.sent, 0)
        self.now = start + 5 + 31
        self.due_retry()
        self.assertEqual(self.sent, 1)

    def test_hold_pressed_while_retry_prepares_wins(self):
        start = self.now
        self.archive.generate_report("m1")
        self.now = start + 31
        real = self.archive.report_gate

        def gate(identity):
            self.archive.after.hold("m1")  # pressed after retry checked the gate, before it sends
            return real(identity)

        with patch.object(self.archive, "report_gate", side_effect=gate):
            self.due_retry()
        self.assertEqual(self.sent, 0)
        self.archive.after.send_now("m1")
        self.archive.retry_pending_deliveries()
        self.assertEqual(self.sent, 1)

    def test_removed_item_left_out(self):
        self.archive.after.remove("m1", "journal:j1", True)
        self.assertNotIn("j1", [item.get("id") for item in self.archive.report_detail("m1")["journal"]])
        self.archive.generate_report("m1")
        self.assertNotIn("Legal review may delay the pilot.", self.page())
        self.archive.after.remove("m1", "journal:j1", False)
        self.assertIn("j1", [item.get("id") for item in self.archive.report_detail("m1")["journal"]])
        self.archive.generate_report("m1")
        self.assertIn("Legal review may delay the pilot.", self.page())

    def test_history_pass_sees_edits(self):
        with patch.object(self.archive, "create_due_report", return_value=False) as due:
            self.archive.finalize_history()
            self.archive.finalize_history()
            self.assertEqual(due.call_count, 1)
            self.archive.after.edit("m1", "next_steps", "Send the proposal on Friday.")
            self.archive.finalize_history()
            self.assertEqual(due.call_count, 2)

    def test_unedited_summary_is_unchanged(self):
        detail = self.archive.report_detail("m1")
        self.assertFalse((self.reports / "m1" / "after.json").exists())
        self.assertNotIn("after_edits", {k for k, v in detail.items() if v})
        summary = self.archive.report_summary(detail)
        steps = self.archive.report_next_steps(detail)
        self.assertEqual(summary, ["Budget approved for one quarter.", "We send the proposal on Friday."])
        self.assertEqual(steps, [])  # neither line names an explicit next action
        page = self.archive._report_html(detail, [])
        for line in summary:
            self.assertIn(f"<li>{line}</li>", page)
        self.assertIn("Автоматически выделенных следующих шагов нет", page)
        self.archive.after.edit("m1", "next_steps", "\n".join(f"Step {n}" for n in range(12)) + "\n\n")
        self.assertEqual(self.archive.report_next_steps(self.archive.report_detail("m1")),
                         [f"Step {n}" for n in range(10)])


class DeliveryLoopTests(unittest.TestCase):
    def test_due_reports_go_first_and_the_full_scan_once_a_minute(self):
        import threading
        import server

        calls = []
        stop = threading.Event()

        def retry(**kwargs):
            calls.append(kwargs)
            if len(calls) == 3:
                stop.set()

        with patch.object(server.TRANSCRIPT, "stop", stop), \
             patch.object(server, "DELIVERY_WAKE") as wake, \
             patch.object(server.ARCHIVE.after, "due", side_effect=[{"m1"}, set(), {"m2"}]), \
             patch.object(server.ARCHIVE, "retry_pending_deliveries", side_effect=retry):
            server.delivery_loop()
        self.assertEqual(calls, [{"meeting_ids": {"m1"}}, {}, {"meeting_ids": {"m2"}}])
        wake.wait.assert_called_with(5)


if __name__ == "__main__":
    unittest.main()
