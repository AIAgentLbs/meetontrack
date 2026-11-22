import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import server
from call_feed import SPEAKABLE_RULE, analysed_watermark, heard_question
from permissions import open_settings
from server import CodexSession, MeetingJournal, analysis_question

NOW = 1_800_000_000.0
QUESTION = "What budget is set for the pilot this year?"


def iso(seconds_ago: float) -> str:
    return datetime.fromtimestamp(NOW - seconds_ago, timezone.utc).isoformat(timespec="seconds")


def segment(text: str = QUESTION, ago: float = 5, **extra) -> dict:
    return {"source": "system", "speaker": "Anna Petrova", "text": text, "timestamp": iso(ago), **extra}


def heard(segments, journal=(), until="", busy=False):
    return heard_question(list(segments), list(journal), analysed_until=until, busy=busy, now=NOW)


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
        self.assertIsNone(heard([segment()], [{"category": "OPEN_QUESTION", "text": QUESTION}]))
        self.assertIsNotNone(heard([segment()], [{"category": "INCOMING_QUESTION", "text": "?"}]))

    def test_word_match_is_whole_words(self):
        # "budge" sits inside "budget": not the same words, so the question still waits.
        part = {"category": "INCOMING_QUESTION", "text": "What budge?"}
        self.assertIsNotNone(heard([segment()], [part]))
        longer = {"category": "INCOMING_QUESTION", "text": "So what budget is set for the pilot this year, Anna?"}
        self.assertIsNone(heard([segment()], [longer]))

    def test_heard_question_ends(self):
        self.assertIsNone(heard([segment(ago=121)]))
        self.assertIsNone(heard([segment()], until=iso(5), busy=False))
        self.assertEqual(heard([segment()], until=iso(5), busy=True)["text"], QUESTION)

    def test_analysis_before_the_question_reached_the_transcript(self):
        # The analysis started after the question began (at -5 s) but saw a transcript
        # whose newest line was older: the question was not in it and still waits.
        self.assertEqual(heard([segment()], until=iso(10), busy=False)["text"], QUESTION)


class ProvisionalQuestionTests(unittest.TestCase):
    """B4: an analysis that read a question while it was provisional has not read it."""

    def test_watermark_stops_before_the_first_provisional_line(self):
        segments = [segment("Thanks.", ago=20), segment(ago=10, provisional=True),
                    segment("Right.", ago=5, source="microphone")]
        until = analysed_watermark(segments, iso(5))
        self.assertLess(datetime.fromisoformat(until).timestamp(), NOW - 10)
        segments[1].pop("provisional")  # finalized, same start time
        self.assertEqual(heard(segments, until=until)["text"], QUESTION)
        self.assertEqual(analysed_watermark(segments, iso(5)), iso(5))

    def test_finalized_line_is_a_new_analysis(self):
        session = CodexSession(None)
        with mock.patch.object(server.time, "time", return_value=NOW):
            self.assertTrue(session.should_analyze("same text", False, latest_at=iso(11)))
        with mock.patch.object(server.time, "time", return_value=NOW + 20):
            self.assertTrue(session.should_analyze("same text", False, urgent=True, latest_at=iso(5)))
            self.assertFalse(session.should_analyze("same text", False, urgent=True, latest_at=iso(5)))


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

    def test_prompts_name_no_one_and_file_the_other_sides_question_as_incoming(self):
        # B2: no owner's name in any analysis prompt; in a call of two, every question from the other side
        # is put to the user, so a voice agent asking "When can you start?" gets an answer card.
        empty = SimpleNamespace(snapshot=lambda *a: [], claims=lambda *a: [], ACTIONABLE=set())
        with mock.patch.object(server, "JOURNAL", empty), mock.patch.object(server, "FACT_CHECKS", empty), \
                mock.patch.object(server, "PLANS", SimpleNamespace(snapshot=lambda *a: None)):
            question = analysis_question({"meeting_id": "one"}, "")[0]
        prompts = [question, CodexSession._base_prompt(CodexSession(None), "q", "t", "m", {}),
                   CodexSession._continuation_prompt("q", "t", "m", {}),
                   server.Handler._transcript_text({"capture_warnings": [{}], "segments": []})]
        for prompt in prompts:
            self.assertNotRegex(prompt, r"Майк|Mike")
        self.assertIn("в звонке один на один каждый вопрос собеседника адресован пользователю", question)
        self.assertNotIn("до 18 слов", prompts[1] + prompts[2])  # one length rule: SPEAKABLE_RULE's
        # D1: the Call view shows elapsed call time; a clock time in the source line would be a second clock.
        for prompt in prompts[:3]:
            self.assertIn("источник без времени", prompt)

    def test_other_sides_question_without_a_named_speaker_is_incoming(self):
        # A call-audio segment the diarizer did not name is still the other side: it keeps its reply.
        self.transcript["segments"] = [{"text": QUESTION, "source": "system", "speaker_id": "unassigned", "speaker": ""}]
        [item] = self.capture("d", "incoming", "We can start on Monday.")
        self.assertEqual((item["category"], item["reply"]), ("INCOMING_QUESTION", "We can start on Monday."))
        self.transcript["segments"] = [{"text": QUESTION, "source": "microphone", "speaker_id": "unassigned"}]
        [item] = self.capture("e", "incoming", "We can start on Monday.")
        self.assertEqual(item["category"], "OPEN_QUESTION")

    def test_urgent_analysis_gap(self):
        session = CodexSession(None)
        for offset, urgent, expected in [(0, False, True), (20, False, False), (20, True, True), (30, True, False)]:
            with mock.patch.object(server.time, "time", return_value=NOW + offset):
                self.assertEqual(session.should_analyze(f"text {offset} {urgent}", False, urgent=urgent), expected)
        session.last_error = "failed"
        with mock.patch.object(server.time, "time", return_value=NOW + 200):
            self.assertFalse(session.should_analyze("after error", False, urgent=True))

    def test_analysis_records_the_transcript_it_saw(self):
        session = CodexSession(None)
        self.assertTrue(session.should_analyze("one", False, latest_at=iso(10)))
        self.assertEqual(session.analysed_until, iso(10))
        self.assertFalse(session.should_analyze("one", False, latest_at=iso(1)))  # skipped: unchanged
        self.assertEqual(session.analysed_until, iso(10))


class SoundSettingsTests(unittest.TestCase):
    def test_sound_output_settings(self):
        calls = []
        open_settings("sound_output", "posix", opener=calls.append)
        open_settings("sound_output", "nt", opener=calls.append)
        self.assertEqual(calls, ["x-apple.systempreferences:com.apple.Sound-Settings.extension", "ms-settings:sound"])


if __name__ == "__main__":
    unittest.main()
