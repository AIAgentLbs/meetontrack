import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

try:
    from meeting_boundaries import MeetingBoundaries, BoundaryConflict, BoundaryUnavailable, FAREWELL
except ImportError:
    MeetingBoundaries = None


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "boundaries.json"
        self.physical = {"meeting_id": "p1", "meeting": "Example", "status": "recording",
                         "started_at": "2026-01-01T10:00:00Z", "segments": []}

    def store(self):
        self.assertIsNotNone(MeetingBoundaries, "logical meeting store is missing")
        return MeetingBoundaries(self.path)

    def split(self, store, expected="p1", token="one", at="2026-01-01T10:05:00Z"):
        return store.split(self.physical, expected, token, "Second", at)

    def test_retry_survives_restart(self):
        store = self.store()
        result = self.split(store)
        self.assertEqual(self.split(self.store(), at="2026-01-01T10:06:00Z"), result)
        self.assertEqual([p["meeting_id"] for p in store.project(self.physical)], ["p1", result["meeting_id"]])
        self.assertNotIn("segments", self.path.read_text())

    def test_three_boundaries_are_independent(self):
        store = self.store()
        identity = "p1"
        for minute in (5, 10, 15):
            identity = self.split(store, identity, str(minute), f"2026-01-01T10:{minute:02d}:00Z")["meeting_id"]
        parts = store.project(self.physical)
        self.assertEqual(len(parts), 4)
        self.assertEqual(parts[0]["audio_range"], {"start_seconds": 0.0, "end_seconds": 300.0})
        self.assertIsNone(parts[-1]["logical_interval"]["end"])

    def test_concurrent_stale_tabs_make_one_boundary(self):
        store = self.store()
        def attempt(token):
            try:
                self.split(store, token=token)
                return "ok"
            except BoundaryConflict:
                return "conflict"
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(attempt, ["a", "b"])), ["conflict", "ok"])

    def test_failed_write_does_not_publish(self):
        store = self.store()
        with patch("meeting_boundaries.os.replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                self.split(store)
        self.assertEqual(len(store.project(self.physical)), 1)
        self.assertFalse(self.path.exists())

    def test_corrupt_store_fails_closed(self):
        self.path.write_text('{"version":1,"sessions":"bad"}')
        self.assertIsNotNone(MeetingBoundaries)
        with self.assertRaises(ValueError):
            MeetingBoundaries(self.path)

    def test_late_and_crossing_speech_preserved_once(self):
        store = self.store()
        self.split(store)
        self.physical["segments"] = [
            {"timestamp": "2026-01-01T10:04:59Z", "end_timestamp": "2026-01-01T10:05:02Z", "text": "old", "source": "system"},
            {"timestamp": "2026-01-01T10:05:00Z", "text": "new", "source": "microphone"},
            {"timestamp": "bad", "text": "uncertain", "source": "system"}]
        parts = store.project(self.physical)
        self.assertEqual([s["text"] for s in parts[0]["segments"]], ["old", "uncertain"])
        self.assertTrue(parts[0]["segments"][0]["spans_boundary"])
        self.assertTrue(parts[0]["segments"][1]["boundary_unassigned"])
        self.assertEqual([s["text"] for s in parts[1]["segments"]], ["new"])

    def test_stop_and_next_physical_session(self):
        store = self.store()
        self.split(store)
        self.physical.update(status="finished", updated_at="2026-01-01T10:09:00Z")
        self.assertEqual(store.project(self.physical)[-1]["logical_interval"]["end"], "2026-01-01T10:09:00Z")
        self.assertEqual(len(store.project({**self.physical, "meeting_id": "p2"})), 1)

    def test_event_time_routes_old_physical_frames_and_preserves_logical_note(self):
        store = self.store()
        second = self.split(store)["meeting_id"]
        self.assertEqual(store.route_event({"meeting_id": "p1", "captured_at": "2026-01-01T10:06:00Z"})["meeting_id"], second)
        self.assertEqual(store.route_event({"meeting_id": "p1", "created_at": "2026-01-01T10:06:00Z", "logical_event": True})["meeting_id"], "p1")
        self.assertTrue(store.route_event({"meeting_id": "p1"})["boundary_unassigned"])

    def test_capture_started_in_second_part_routes_by_actual_third_part_time(self):
        store = self.store()
        second = self.split(store)["meeting_id"]
        third = self.split(store, expected=second, token="two", at="2026-01-01T10:10:00Z")["meeting_id"]
        self.assertEqual(store.route_event({"meeting_id": second, "captured_at": "2026-01-01T10:11:00Z"})["meeting_id"], third)

    def test_inactive_token_reuse_and_nonmonotonic_rejected(self):
        store = self.store()
        result = self.split(store)
        with self.assertRaises(BoundaryConflict):
            self.split(store, expected=result["meeting_id"], at="2026-01-01T10:04:00Z", token="two")
        with self.assertRaises(BoundaryConflict):
            self.split(store, expected=result["meeting_id"])
        self.physical["status"] = "finished"
        with self.assertRaises(BoundaryUnavailable):
            self.split(store, expected=result["meeting_id"], token="three")


def said(at, text, source="system"):
    return {"timestamp": f"2026-01-01T10:{at}Z", "source": source, "text": text}


def gap(start, end):
    return {"reason": "system-audio-lost", "started_at": f"2026-01-01T10:{start}Z",
            "ended_at": f"2026-01-01T10:{end}Z" if end else None}


class CallChangeTests(unittest.TestCase):
    """MEETONTRACK-103: goodbyes, a long far-end gap, then a different call."""

    def setUp(self):
        BoundaryTests.setUp(self)

    def call(self, warnings, segments):
        self.physical.update(capture_warnings=warnings, segments=segments)
        return MeetingBoundaries(self.path).split_at_call_change(self.physical)

    def test_goodbyes_then_long_gap_starts_new_meeting(self):
        segments = [said("01:00", "Ну давай тогда, пока."),
                    {**said("01:10", "Да, спасибо", "microphone"), "end_timestamp": "2026-01-01T10:01:20Z"},
                    said("03:40", "Слышно, да", "microphone")]
        result = self.call([gap("01:20", "02:50")], segments)
        self.assertEqual(result["started_at"], "2026-01-01T10:02:50Z")
        store = MeetingBoundaries(self.path)
        self.assertEqual([len(p["segments"]) for p in store.project(self.physical)], [2, 1])
        # The next loop pass sees the same gap and does nothing.
        self.assertIsNone(store.split_at_call_change(self.physical))
        self.assertEqual(len(store.project(self.physical)), 2)

    def test_goodbye_phrasings_match(self):
        for text in ("Всем привет, пока.", "Пока-пока!", "Счастливо тогда", "Ok, bye", "Take care!", "See you tomorrow", "See you."):
            with self.subTest(text=text):
                self.assertTrue(FAREWELL.search(text))

    def test_long_goodbye_utterance_counts_by_its_end(self):
        segments = [{**said("00:00", "...и на этом все, спасибо, пока"), "end_timestamp": "2026-01-01T10:01:15Z"},
                    said("03:40", "Слышно, да", "microphone")]
        self.assertIsNotNone(self.call([gap("01:20", "02:50")], segments))

    def test_goodbye_before_manual_boundary_does_not_split_new_meeting(self):
        segments = [said("01:00", "Ну давай тогда, пока."), said("03:40", "Слышно, да", "microphone")]
        self.physical.update(capture_warnings=[gap("01:30", "03:00")], segments=segments)
        store = MeetingBoundaries(self.path)
        store.split(self.physical, "p1", "manual", "Next", "2026-01-01T10:01:10Z")
        self.assertIsNone(store.split_at_call_change(self.physical))

    def test_manual_split_inside_gap_is_not_split_again(self):
        segments = [said("01:00", "Ну давай тогда, пока."), said("03:40", "Слышно, да", "microphone")]
        self.physical.update(capture_warnings=[gap("01:20", "02:50")], segments=segments)
        store = MeetingBoundaries(self.path)
        store.split(self.physical, "p1", "manual", "Next", "2026-01-01T10:02:00Z")
        self.assertIsNone(store.split_at_call_change(self.physical))
        self.assertEqual(len(store.project(self.physical)), 2)

    def test_normal_calls_are_not_split(self):
        before = [said("01:00", "Ну давай тогда, пока."), said("04:00", "Дальше", "microphone")]
        cases = [
            ([gap("01:20", "02:29")], before),  # usual muted pause, 69 s
            ([gap("01:20", "02:50")], [said("01:00", "Посмотрим слайд"), said("04:00", "Дальше")]),
            ([gap("01:20", "02:50")], before + [said("02:00", "Алло?", "microphone")]),  # capture loss
            ([gap("01:20", "02:50")], [said("01:00", "Ну давай, пока.")]),  # nothing after yet
            ([gap("01:20", None)], before),  # gap still open
            ([gap("01:20", "02:50")], [said("00:10", "Пока"), said("04:00", "Дальше")]),  # goodbye long before
            ([gap("01:20", "02:50")], [said("01:00", "Пока посмотрите документ"), said("04:00", "Дальше")]),
            ([gap("01:20", "02:50")], [said("01:00", "I will take care of the slides"), said("04:00", "Ok")]),
            ([gap("01:20", "02:50")], [said("01:00", "I can see you now"), said("04:00", "Ok")]),
            ([gap("01:20", "02:50")], before + [{**said("01:15", "Сейчас покажу", "microphone"),
                                                 "end_timestamp": "2026-01-01T10:01:30Z"}]),
            ([gap("01:20", "02:50")], before + [said("02:00", "Есть вопрос?")]),  # remote spoke in gap
        ]
        for warnings, segments in cases:
            with self.subTest(warnings=warnings, segments=segments):
                self.assertIsNone(self.call(warnings, segments))
