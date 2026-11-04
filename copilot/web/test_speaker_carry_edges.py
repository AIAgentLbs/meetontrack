"""MEETONTRACK-119: the edge cases of carrying live speaker corrections to the final transcript.

Follow-up to MEETONTRACK-117. One test per case in the issue; all names and text are synthetic.
"""

import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

import test_final_after_next_call as base
from archive import MeetingArchive
from meeting_boundaries import MeetingBoundaries
from speaker_edits import carry_corrections, segment_id
from test_final_after_next_call import iso

at = lambda second: f"2026-10-22T16:00:{second:02d}+00:00"  # noqa: E731


class CarriedCorrectionCaseTests(unittest.TestCase):
    def setUp(self):
        case = base.FinalTranscriptAfterNextCallTests("test_dropout_in_the_last_minute_is_explained_not_flagged")
        case.setUp()
        self.addCleanup(case.doCleanups)
        (case.first / "transcript.json").unlink()  # Only live text so far.
        case.next_call_ends()
        self.case, self.archive = case, case.archive

    def live(self) -> list[dict]:
        return self.archive.annotate_speakers(self.case.stored())["segments"]

    def assign(self, segment: dict, name: str) -> None:
        self.archive.speaker_edits.assign(self.archive.annotate_speakers(self.case.stored()), [segment["segment_id"]], name=name)

    def import_final(self) -> None:
        self.archive.import_final_transcript(self.case.stored())

    def test_1_a_merged_final_line_with_the_same_start_does_not_take_the_correction_by_time_alone(self):
        live = self.live()
        self.assign(live[0], "Synthetic Alpha")  # Live line 39-45 s.
        start = self.case.start
        # The live file now shows the final text: line 0 merged with line 1 (39-125 s), same start.
        merged = [{"source": "system", "timestamp": live[0]["timestamp"], "end_timestamp": iso(start + timedelta(seconds=125)),
                   "text": "Merged final line"}]
        merged += [{"source": "system", "timestamp": item["timestamp"], "end_timestamp": item["end_timestamp"],
                    "text": f"Final {index}"} for index, item in enumerate(live[2:], start=2)]
        merged.append({"source": "system", "timestamp": iso(start + timedelta(seconds=3600)), "text": "Final extra"})
        self.archive.sync_transcript({**self.case.live, "segments": merged})
        self.assertEqual(self.case.stored()["segments"][0]["text"], "Live line 0", "Corrected live text kept")
        self.case.write_final([{"speaker": "them", "start_ms": 39000, "end_ms": 125000, "text": "Merged final line"},
                               {"speaker": "them", "start_ms": 199000, "end_ms": 205000, "text": "Final next"}])
        self.import_final()
        stored = self.case.stored()
        line = next(item for item in stored["segments"] if item["text"] == "Merged final line")
        self.assertNotEqual(line.get("speaker"), "Synthetic Alpha", "Half of it was another, uncorrected line")
        self.assertIn(segment_id(line), stored["speaker_review"]["segment_ids"])

    def test_3_a_small_corrected_part_that_loses_is_still_flagged_when_the_name_is_used_elsewhere(self):
        live = [{"source": "system", "timestamp": at(0), "end_timestamp": at(3), "speaker_id": "manual-a",
                 "speaker": "Synthetic Alpha", "speaker_identity": "manual", "text": "Live"},
                {"source": "system", "timestamp": at(3), "end_timestamp": at(10), "speaker_id": "remote-1",
                 "speaker": "Собеседник 1", "text": "Live"},
                {"source": "system", "timestamp": at(20), "end_timestamp": at(24), "speaker_id": "manual-a",
                 "speaker": "Synthetic Alpha", "speaker_identity": "manual", "text": "Live"}]
        final = [{"source": "system", "timestamp": at(0), "end_timestamp": at(10), "text": "Final mixed"},
                 {"source": "system", "timestamp": at(20), "end_timestamp": at(24), "text": "Final alpha"}]
        segments, _, review = carry_corrections(live, {}, final)
        self.assertEqual([item.get("speaker") for item in segments], [None, "Synthetic Alpha"])
        self.assertEqual(review, {"segment_ids": [segment_id(final[0])], "names": []})

    def test_3_a_touch_at_the_edge_is_not_flagged(self):
        live = [{"source": "system", "timestamp": at(0), "end_timestamp": at(10), "speaker_id": "manual-a",
                 "speaker": "Synthetic Alpha", "speaker_identity": "manual", "text": "Live"},
                {"source": "system", "timestamp": at(10), "end_timestamp": at(30), "speaker_id": "remote-1",
                 "speaker": "Собеседник 1", "text": "Live"}]
        final = [{"source": "system", "timestamp": at(0), "end_timestamp": at(10), "text": "Final alpha"},
                 {"source": "system", "timestamp": "2026-10-22T16:00:09.500000+00:00", "end_timestamp": at(30), "text": "Final next"}]
        segments, _, review = carry_corrections(live, {}, final)
        self.assertEqual([item.get("speaker") for item in segments], ["Synthetic Alpha", None])
        self.assertIsNone(review)

    def unplaced(self) -> None:
        """Two corrected names the final cannot place: listed for review (MEETONTRACK-117)."""
        live = self.live()
        self.assign(live[0], "Synthetic Alpha")
        self.assign(live[1], "Synthetic Beta")
        self.case.write_final([{"speaker": "me", "start_ms": 1000, "end_ms": 3000, "text": "Final hello"},
                               {"speaker": "them", "start_ms": 39000, "end_ms": 125000, "text": "Final long line"}])
        self.import_final()
        self.assertEqual(self.case.stored()["speaker_review"]["names"], ["Synthetic Alpha", "Synthetic Beta"])

    def test_4_unplaced_names_stay_listed_after_the_flagged_line_is_assigned(self):
        self.unplaced()
        line = next(item for item in self.live() if item["text"] == "Final long line")
        self.assign(line, "Synthetic Gamma")
        self.assertEqual(self.case.stored()["speaker_review"], {"segment_ids": [], "names": ["Synthetic Alpha", "Synthetic Beta"]})
        hello = next(item for item in self.live() if item["text"] == "Final hello")
        self.assign(hello, "Synthetic Alpha")  # The person places one listed name.
        self.assertEqual(self.case.stored()["speaker_review"]["names"], ["Synthetic Beta"])
        self.assign(line, "Synthetic Beta")
        self.assertNotIn("speaker_review", self.case.stored())

    def test_5_a_revised_final_keeps_unresolved_names(self):
        self.unplaced()
        self.case.write_final([{"speaker": "me", "start_ms": 1000, "end_ms": 3000, "text": "Final hello"},
                               {"speaker": "them", "start_ms": 39000, "end_ms": 125000, "text": "Final long line, revised"}])
        self.import_final()
        stored = self.case.stored()
        self.assertEqual(stored["final_transcript"].split(":")[0],
                         str((self.case.first / "transcript.json").stat().st_size), "The revision was imported")
        self.assertEqual(stored["speaker_review"]["names"], ["Synthetic Alpha", "Synthetic Beta"])

    def test_6_translations_of_unchanged_lines_survive_the_corrected_import(self):
        path = self.case.root / "archive/FIRST-CALL/meeting.json"
        stored = json.loads(path.read_text())
        stored["segments"][2].update(translation_en="Synthetic translation", language="ru")
        path.write_text(json.dumps(stored))
        live = self.live()
        self.assign(live[0], "Synthetic Alpha")
        same = live[2]
        lines = [{"speaker": "them", "start_ms": 39000, "end_ms": 45000, "text": "Final first"},
                 {"speaker": "them", "start_ms": 199000, "end_ms": 205000, "text": same["text"]}]
        self.case.write_final(lines)
        # The final line keeps the live line's start, text and source (its translation key).
        with unittest.mock.patch("archive.canonical_segments", return_value=[
                {"source": "system", "timestamp": live[0]["timestamp"], "end_timestamp": live[0]["end_timestamp"], "text": "Final first"},
                {"source": "system", "timestamp": same["timestamp"], "end_timestamp": same["end_timestamp"], "text": same["text"]}]):
            self.import_final()
        stored = self.case.stored()
        kept = next(item for item in stored["segments"] if item["text"] == same["text"])
        self.assertEqual(kept.get("translation_en"), "Synthetic translation")
        self.assertEqual(stored["segments"][0].get("speaker"), "Synthetic Alpha")


class SplitMeetingCorrectionTests(unittest.TestCase):
    """Case 2: a split meeting keeps its corrected live lines until its final import."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "config").mkdir()
        self.recording = root / "recordings" / "physical"
        self.recording.mkdir(parents=True)
        (self.recording / "meta.json").write_text(json.dumps({"started": "2026-01-01T10:00:00Z", "ended": "2026-01-01T10:20:00Z",
                                                              "duration_seconds": 1200}))
        (self.recording / "audio.wav").write_bytes(b"synthetic")
        self.store = MeetingBoundaries(root / "boundaries.json")
        self.archive = MeetingArchive(root / "recordings", root / "archive", root / "reports", root / "config")
        self.physical = {"meeting_id": "p1", "meeting": "Example", "status": "recording",
                         "started_at": "2026-01-01T10:00:00Z", "recording_dir": str(self.recording),
                         "updated_at": "2026-01-01T10:20:00Z", "segments": [
                             {"timestamp": "2026-01-01T10:02:00Z", "source": "system", "text": "old"},
                             {"timestamp": "2026-01-01T10:08:00Z", "source": "system", "text": "new"}]}
        self.second = self.store.split(self.physical, "p1", "one", "Example", "2026-01-01T10:05:00Z")["meeting_id"]
        self.physical["status"] = "finished"

    def sync(self):
        for part in self.store.project(self.physical):
            self.archive.sync_transcript(part)

    def stored(self, meeting_id="p1"):
        return json.loads((self.archive.archive_root / meeting_id / "meeting.json").read_text())

    def test_2_a_projected_refresh_before_the_import_does_not_drop_the_correction(self):
        self.sync()
        annotated = self.archive.annotate_speakers(self.stored())
        self.archive.speaker_edits.assign(annotated, [annotated["segments"][0]["segment_id"]], name="Synthetic Alpha")
        # The live file reads final-like text with another start before the import runs.
        self.physical["segments"] = [{"timestamp": "2026-01-01T10:02:01Z", "source": "system", "text": "old, refreshed"},
                                     {"timestamp": "2026-01-01T10:08:00Z", "source": "system", "text": "new"}]
        self.sync()
        self.assertEqual(self.stored()["segments"][0].get("speaker"), "Synthetic Alpha")
        (self.recording / "transcript.json").write_text(json.dumps({"engine": "synthetic", "segments": [
            {"speaker": "them", "start_ms": 120000, "end_ms": 121000, "text": "old final"},
            {"speaker": "them", "start_ms": 480000, "end_ms": 481000, "text": "new final"}]}))
        self.archive.import_final_transcript(self.stored())
        stored = self.stored()
        self.assertEqual([(s["text"], s.get("speaker")) for s in stored["segments"]], [("old final", "Synthetic Alpha")])
        self.assertNotIn("corrected_live", stored)

    def test_2_a_moved_boundary_keeps_the_dropped_correction_for_the_import(self):
        self.sync()
        annotated = self.archive.annotate_speakers(self.stored())
        self.archive.speaker_edits.assign(annotated, [annotated["segments"][0]["segment_id"]], name="Synthetic Alpha")
        part = next(part for part in self.store.project(self.physical) if part["meeting_id"] == "p1")
        moved = {**part, "logical_interval": {**part["logical_interval"], "end": "2026-01-01T10:06:00Z"},
                 "segments": [{"timestamp": "2026-01-01T10:02:01Z", "source": "system", "text": "old, refreshed"}]}
        self.archive.sync_transcript(moved)
        stored = self.stored()
        self.assertEqual(stored["segments"][0]["text"], "old, refreshed", "The new part shows")
        self.assertEqual([s["speaker"] for s in stored["corrected_live"]], ["Synthetic Alpha"])
        (self.recording / "transcript.json").write_text(json.dumps({"engine": "synthetic", "segments": [
            {"speaker": "them", "start_ms": 120000, "end_ms": 121000, "text": "old final"}]}))
        self.archive.import_final_transcript(stored)
        stored = self.stored()
        self.assertEqual([(s["text"], s.get("speaker")) for s in stored["segments"]], [("old final", "Synthetic Alpha")])
        self.assertNotIn("corrected_live", stored)


if __name__ == "__main__":
    unittest.main()
