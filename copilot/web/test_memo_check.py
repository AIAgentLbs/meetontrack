"""MEETONTRACK-163: one memo check per meeting, offline, kept in the report.

All names, texts and addresses are invented.
"""

import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import memo_check
from ai_providers import PURPOSES, AIChoiceError, default_adapters
from archive import MeetingArchive

SCHEMA = Path(__file__).resolve().parents[2] / "docs" / "config.schema.json"
PLAN = {
    "items": [
        {"id": "q1", "kind": "question", "text": "What budget is set for the pilot this year?"},
        {"id": "r1", "kind": "risk", "text": "Legal review may delay the pilot."},
        {"id": "q2", "kind": "question", "text": "Who signs off the purchase?"},
    ],
    "memo_markdown": "Anna Petrova said in October that the start is in April.",
}
SEGMENTS = [
    {"speaker": "Anna Petrova", "timestamp": "2026-11-20T10:01:00Z", "text": "The budget is approved for one quarter."},
    {"speaker": "Anna Petrova", "timestamp": "2026-11-20T10:02:00Z", "text": "We plan to start in March."},
]


def answer(questions=(), differs=()):
    return "Here it is:\n" + json.dumps({"questions": list(questions), "differs": list(differs)}) + "\nDone."


class MemoCheckTests(unittest.TestCase):
    def test_purpose_is_listed(self):
        self.assertIn("memo_check", PURPOSES)
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertIn("memo_check", schema["$defs"]["task"]["enum"])

    def test_prompt_numbers_lines(self):
        text = memo_check.prompt(PLAN, SEGMENTS)
        self.assertIn("q1: What budget", text)
        self.assertIn("[0] Anna Petrova: ", text)
        self.assertIn("[1] Anna Petrova: We plan to start in March.", text)
        self.assertNotIn("r1:", text)
        lowered = text.casefold()
        for adapter in default_adapters():
            for name in (adapter.name, adapter.label):
                self.assertNotIn(name.casefold(), lowered)
        with self.assertRaises(ValueError) as caught:
            memo_check.prompt(PLAN, [{"speaker": "Anna Petrova", "text": "word " * 50_000}])
        self.assertEqual(str(caught.exception), "too_long")

    def test_answered_needs_quote_from_its_line(self):
        result = memo_check.parse(answer([{"id": "q1", "status": "answered", "segment": 0,
                                           "quote": "budget  is APPROVED"}]), PLAN, SEGMENTS)
        self.assertEqual(result["state"], "done")
        first = result["questions"][0]
        self.assertEqual((first["id"], first["status"], first["speaker"], first["at"]),
                         ("q1", "answered", "Anna Petrova", "2026-11-20T10:01:00Z"))
        self.assertEqual(first["quote"], "budget is APPROVED")

    def test_invented_quote_is_dropped(self):
        for entry in ({"id": "q1", "status": "answered", "segment": 0, "quote": "budget is unlimited"},
                      {"id": "q1", "status": "answered", "segment": 1, "quote": "budget is approved"},
                      {"id": "q1", "status": "answered", "segment": 7, "quote": "budget is approved"}):
            first = memo_check.parse(answer([entry]), PLAN, SEGMENTS)["questions"][0]
            self.assertEqual((first["status"], first["quote"]), ("open", ""), entry)

    def test_unknown_and_missing_ids(self):
        result = memo_check.parse(answer([{"id": "q9", "status": "answered", "segment": 0,
                                           "quote": "budget is approved"}]), PLAN, SEGMENTS)
        self.assertEqual([(q["id"], q["status"]) for q in result["questions"]], [("q1", "open"), ("q2", "open")])

    def test_differs_needs_memo_words(self):
        kept = memo_check.parse(answer(differs=[{"memo": "the start is in April", "segment": 1,
                                                 "quote": "start in March"}]), PLAN, SEGMENTS)["differs"]
        self.assertEqual(len(kept), 1)
        self.assertTrue(kept[0]["key"].startswith("differs:"))
        self.assertEqual(len(kept[0]["key"]), len("differs:") + 12)
        self.assertEqual((kept[0]["memo"], kept[0]["quote"], kept[0]["speaker"]),
                         ("the start is in April", "start in March", "Anna Petrova"))
        dropped = memo_check.parse(answer(differs=[{"memo": "the start is in May", "segment": 1,
                                                    "quote": "start in March"}]), PLAN, SEGMENTS)["differs"]
        self.assertEqual(dropped, [])

    def test_outcomes(self):
        detail = {"meeting_id": "m1", "transcript": SEGMENTS}

        def raising(error):
            def run(prompt):
                raise error
            return run

        self.assertEqual(memo_check.check(detail, PLAN, lambda prompt: "no json"),
                         {"state": "failed", "reason": "ai_no_answer"})
        self.assertEqual(memo_check.check(detail, PLAN, raising(TimeoutError("slow"))),
                         {"state": "failed", "reason": "timeout"})
        self.assertEqual(memo_check.check(detail, PLAN, raising(AIChoiceError("needs_choice", ""))),
                         {"state": "unavailable", "reason": "ai_needs_choice"})
        self.assertEqual(memo_check.check(detail, PLAN, raising(RuntimeError("boom"))),
                         {"state": "failed", "reason": "error"})
        calls = []
        no_questions = {"items": [PLAN["items"][1]], "memo_markdown": PLAN["memo_markdown"]}
        for plan in (no_questions, None):
            self.assertIsNone(memo_check.check(detail, plan, lambda prompt: calls.append(prompt) or "{}"))
        self.assertEqual(calls, [])


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class MemoCheckReportTests(unittest.TestCase):
    """The archive as in test_after_archive: invented meeting m1, PDF and delivery faked."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        config = root / "config"
        config.mkdir()
        (config / "delivery.json").write_text(json.dumps({"email_enabled": True, "email_to": "owner@example.org"}))
        self.archive = MeetingArchive(root / "recordings", root / "archive", root / "reports", config)
        self.reports = root / "reports"
        ended = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=15)
        started = ended - timedelta(minutes=20)
        self.at = iso(started + timedelta(minutes=1))
        meeting = root / "archive" / "m1"
        meeting.mkdir(parents=True)
        (meeting / "meeting.json").write_text(json.dumps({
            "version": 1, "meeting_id": "m1", "meeting": "Pilot review", "status": "finished",
            "started_at": iso(started), "updated_at": iso(ended), "latest_at": iso(ended),
            "final_transcript": "synthetic-final",
            "segments": [{"source": "system", "speaker": "Anna Petrova", "timestamp": self.at,
                          "text": "The budget is approved for one quarter."}],
        }))
        self.now = time.time()
        self.archive.after.clock = lambda: self.now
        self.ready = True
        self.calls = 0
        self.result = {"state": "done", "differs": [], "questions": [
            {"id": "q1", "text": "What budget is set for the pilot this year?", "status": "answered",
             "quote": "budget is approved for one quarter", "speaker": "Anna Petrova", "at": self.at},
            {"id": "q2", "text": "Who signs off the purchase?", "status": "open", "quote": "",
             "speaker": "", "at": ""}]}

        def checker(detail):
            self.calls += 1
            return self.result

        self.archive.memo_checker = checker
        for name, fake in (("_print_pdf", lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")),
                           ("deliver", lambda detail, meta, **kwargs: {"mail_status": "sent"}),
                           ("_ready_for_delivery", lambda detail: self.ready)):
            patcher = patch.object(self.archive, name, side_effect=fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def report(self) -> dict:
        return json.loads((self.reports / "m1" / "report.json").read_text())

    def page(self) -> str:
        return (self.reports / "m1" / "index.html").read_text(encoding="utf-8")

    def test_report_runs_check_once(self):
        self.ready = False
        self.archive.generate_report("m1")
        self.assertEqual(self.calls, 0)
        self.assertNotIn("memo_check", self.report())
        self.ready = True
        self.archive.generate_report("m1")
        self.archive.generate_report("m1")
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.report()["memo_check"], self.result)
        self.assertIn("Сверка с мемо", self.page())
        self.assertIn("«budget is approved for one quarter»", self.page())  # the transcript has it unquoted
        self.assertIn("Who signs off the purchase?", self.page())
        self.archive.after.remove("m1", "memo:q1", True)
        self.archive.generate_report("m1")
        self.assertNotIn("«budget is approved for one quarter»", self.page())
        self.assertEqual(self.calls, 1)

    def test_first_ready_report_keeps_check(self):
        self.archive.generate_report("m1")  # no report.json yet: the result reaches it with the first meta
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.report()["memo_check"], self.result)
        self.assertIn('href="#memo-check"', self.page())

    def test_failed_check_does_not_hold_report(self):
        self.result = {"state": "failed", "reason": "timeout"}
        self.archive.generate_report("m1")
        self.assertIn("Сверки с мемо нет", self.page())
        self.archive.generate_report("m1")
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.report()["memo_check"], self.result)

    def test_old_meeting_is_not_checked(self):
        self.archive.generate_report("m1", on_request=True)
        self.archive.generate_report("m1", deliver=False)
        self.assertEqual(self.calls, 0)

    def test_checker_error_does_not_hold_report(self):
        def broken(detail):
            raise RuntimeError("synthetic")
        self.archive.memo_checker = broken
        self.archive.generate_report("m1")
        self.assertNotIn("memo_check", self.report())
        self.assertNotIn("memo-check", self.page())


if __name__ == "__main__":
    unittest.main()
