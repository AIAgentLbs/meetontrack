import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import server
from call_feed import SPEAKABLE_RULE, heard_question
from permissions import open_settings
from server import CodexSession, MeetingJournal, analysis_question

NOW = 1_800_000_000.0
QUESTION = "What budget is set for the pilot this year?"


def iso(seconds_ago: float) -> str:
    return datetime.fromtimestamp(NOW - seconds_ago, timezone.utc).isoformat(timespec="seconds")


def segment(text: str = QUESTION, ago: float = 5, **extra) -> dict:
    return {"source": "system", "speaker": "Anna Petrova", "text": text, "timestamp": iso(ago), **extra}


def heard(segments, journal=(), started=0.0, busy=False):
    return heard_question(list(segments), list(journal), analysis_started_at=started, busy=busy, now=NOW)


class HeardQuestionTests(unittest.TestCase):
    def test_heard_question_is_newest_other_side_question(self):
        older = segment("When does Example LLC start the pilot?", ago=40)
        self.assertEqual(heard([older, segment()]), {"text": QUESTION, "speaker": "Anna Petrova", "at": iso(5)})

    def test_own_provisional_and_noise_are_not_heard(self):
        self.assertIsNone(heard([segment(source="microphone")]))
        self.assertIsNone(heard([segment(provisional=True)]))
        self.assertIsNone(heard([segment("Can you hear me?")]))

    def test_captured_question_is_not_heard(self):
        captured = {"category": "INCOMING_QUESTION", "text": "what budget is set for the pilot"}
        self.assertIsNone(heard([segment()], [captured]))

    def test_heard_question_ends(self):
        self.assertIsNone(heard([segment(ago=121)]))
        self.assertIsNone(heard([segment()], started=NOW - 2, busy=False))
        self.assertEqual(heard([segment()], started=NOW - 2, busy=True)["text"], QUESTION)


class AnalysisReplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.transcript = {"meeting_id": "one", "meeting": "Pilot review", "segments": [
            {"text": QUESTION, "speaker_id": "remote-1", "speaker": "Anna Petrova"},
        ]}

    def tearDown(self):
        self.temp.cleanup()

    def capture(self, name: str, direction: str, reply: str) -> list[dict]:
        journal = MeetingJournal(Path(self.temp.name) / f"{name}.json")
        line = {"kind": "substantive", "direction": direction, "evidence": QUESTION, "reply": reply}
        journal.capture_questions(self.transcript, "QUESTION_CAPTURE: " + json.dumps(line))
        return journal.snapshot("one")

    def test_capture_keeps_reply(self):
        [item] = self.capture("a", "incoming", "The pilot budget is set in January.")
        self.assertEqual(item["reply"], "The pilot budget is set in January.")
        [item] = self.capture("b", "incoming", "x" * 300)
        self.assertEqual(item["reply"], "x" * 200)
        [item] = self.capture("c", "general", "The pilot budget is set in January.")
        self.assertNotIn("reply", item)

    def test_analysis_question_has_rule(self):
        empty = SimpleNamespace(snapshot=lambda *a: [], claims=lambda *a: [], ACTIONABLE=set())
        with mock.patch.object(server, "JOURNAL", empty), mock.patch.object(server, "FACT_CHECKS", empty), \
                mock.patch.object(server, "PLANS", SimpleNamespace(snapshot=lambda *a: None)):
            question = analysis_question({"meeting_id": "one"}, "")[0]
        self.assertIn(SPEAKABLE_RULE, question)
        self.assertEqual(question.count(SPEAKABLE_RULE), 1)
        self.assertIn('"reply"', question)

    def test_urgent_analysis_gap(self):
        session = CodexSession(None)
        for offset, urgent, expected in [(0, False, True), (20, False, False), (20, True, True), (30, True, False)]:
            with mock.patch.object(server.time, "time", return_value=NOW + offset):
                self.assertEqual(session.should_analyze(f"text {offset} {urgent}", False, urgent=urgent), expected)


class SoundSettingsTests(unittest.TestCase):
    def test_sound_output_settings(self):
        calls = []
        open_settings("sound_output", "posix", opener=calls.append)
        open_settings("sound_output", "nt", opener=calls.append)
        self.assertEqual(calls, ["x-apple.systempreferences:com.apple.Sound-Settings.extension", "ms-settings:sound"])


if __name__ == "__main__":
    unittest.main()
