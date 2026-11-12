"""MEETONTRACK-94: a call followed right away by another one.

Shaped like the 2026-10-22 case: a 60-minute Chrome call with 44 live lines and
a system-audio warning 70 seconds before it ended; the next call starts two
minutes later; the recorder writes the 406-line final transcript while the next
call is still recording. All text is synthetic.
"""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import archive
from archive import MeetingArchive
from delivery_health import DeliveryHealth
from speaker_edits import carry_corrections


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class FinalTranscriptAfterNextCallTests(unittest.TestCase):
    sent_automatically = True

    def setUp(self, days_ago: float = 0):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = self.root / "config"
        self.config.mkdir()
        (self.config / "delivery.json").write_text(json.dumps({"email_enabled": True, "email_to": "synthetic@example.test"}))
        self.archive = MeetingArchive(self.root / "recordings", self.root / "archive", self.root / "reports", self.config)
        self.start = (datetime.now(timezone.utc) - timedelta(days=days_ago, hours=3)).replace(microsecond=0)
        self.end = self.start + timedelta(seconds=3650)
        self.dropout = self.start + timedelta(seconds=3580)
        self.first = self.recording("2026.10.22-1601 Google Chrome Helper (Ap", self.start, self.end)
        self.next_start = self.start + timedelta(seconds=3774)
        self.second = self.recording("2026.10.22-1703 Google Chrome Helper (Ap", self.next_start, None)
        (self.second / ".recording.json").write_text("{}")  # The next call is recording.
        live = [{"source": "system", "voice_id": "remote-1", "provisional": False,
                 "timestamp": iso(self.start + timedelta(seconds=39 + index * 80)),
                 "end_timestamp": iso(self.start + timedelta(seconds=45 + index * 80)),
                 "text": f"Live line {index}"} for index in range(44)]
        self.live = {"meeting_id": "FIRST-CALL", "meeting": "Google Chrome Helper (Ap", "status": "finished",
                     "started_at": iso(self.start), "updated_at": iso(self.end), "latest_at": live[-1]["timestamp"],
                     "segments": live, "recording_dir": str(self.first),
                     "capture_warnings": [{"reason": "system-audio-lost", "started_at": iso(self.dropout)}]}
        self.archive.sync_transcript(self.live)
        self.archive.sync_transcript({"meeting_id": "NEXT-CALL", "meeting": "Google Chrome Helper (Ap",
                                      "status": "recording", "started_at": iso(self.next_start),
                                      "updated_at": iso(self.next_start), "recording_dir": str(self.second),
                                      "segments": [{"source": "system", "timestamp": iso(self.next_start + timedelta(seconds=5)),
                                                    "text": "Next call line"}]})
        # The final transcript arrives half an hour after the call, while the next one records.
        lines = [{"speaker": "me" if index % 3 == 0 else "them", "start_ms": index * 8780,
                  "end_ms": index * 8780 + 4000, "text": f"Final line {index}"} for index in range(405)]
        lines.append({"speaker": "them", "start_ms": 3564160, "end_ms": 3565360, "text": "Final goodbye"})
        self.write_final(lines)
        self.sent: list[str] = []

    def recording(self, name: str, started: datetime, ended: datetime | None) -> Path:
        directory = self.root / "recordings" / name
        directory.mkdir(parents=True)
        meta = {"app": "Google Chrome Helper (Aperitif)", "audio_channels": {"mic": 0, "system": 1},
                "files": {"mic": "audio.m4a", "system": "audio.m4a"}, "started": iso(started),
                "trigger": "mic-activity", "transcription_input": "per-track",
                "system_recoveries": [{"at": iso(started + timedelta(seconds=50)), "status": "restarted"}]}
        if ended:
            meta.update(ended=iso(ended), duration_seconds=int((ended - started).total_seconds()) - 1,
                        stop_reason="call-ended")
        (directory / "meta.json").write_text(json.dumps(meta))
        (directory / "audio.m4a").write_bytes(b"synthetic")
        return directory

    def write_final(self, lines: list[dict]) -> None:
        (self.first / "transcript.json").write_text(json.dumps({
            "created_at": iso(self.end + timedelta(minutes=31)), "engine": "fluidaudio", "language": "auto",
            "model": "synthetic-model", "segments": lines}))

    def next_call_ends(self) -> None:
        (self.second / ".recording.json").unlink(missing_ok=True)

    def stored(self, meeting_id: str = "FIRST-CALL") -> dict:
        return json.loads((self.root / "archive" / meeting_id / "meeting.json").read_text())

    def finalize(self) -> None:
        def deliver(detail, meta, **kwargs):
            self.sent.append(detail["meeting_id"])
            return {"mail_status": "sent"}
        with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")), \
             patch.object(self.archive, "deliver", side_effect=deliver):
            self.archive.finalize_history()

    def test_final_transcript_replaces_live_and_report_follows_when_next_call_ends(self):
        self.finalize()
        stored = self.stored()
        self.assertEqual(len(stored["segments"]), 406)
        self.assertEqual(stored["segments"][-1]["text"], "Final goodbye")
        self.assertFalse((self.root / "reports/FIRST-CALL/report.json").exists(),
                         "No report while the next call is still recording")
        self.next_call_ends()
        self.finalize()
        report = json.loads((self.root / "reports/FIRST-CALL/report.json").read_text())
        self.assertEqual(self.sent, ["FIRST-CALL"])
        self.assertEqual(report["mail_status"], "sent")
        self.assertNotIn("delivery_on_request", report)
        self.assertEqual(len(self.stored("NEXT-CALL")["segments"]), 1, "The next call is left alone")

    def test_dropout_in_the_last_minute_is_explained_not_flagged(self):
        self.next_call_ends()
        self.finalize()
        detail = self.archive.detail("FIRST-CALL")
        self.assertEqual(detail["library_status"], "report_ready")
        self.assertEqual(detail["audio_gap"], {"started_at": self.dropout.isoformat(), "count": 1,
                                               "ended_at": "", "seconds": 70})
        summary = next(item for item in self.archive.list_meetings() if item["meeting_id"] == "FIRST-CALL")
        self.assertEqual(summary["audio_gap"], detail["audio_gap"])
        self.assertNotEqual(summary["library_status"], "needs_attention")

    def test_audio_gap_only_counts_the_part_inside_this_meeting(self):
        detail = {"started_at": iso(self.start), "ended_at": iso(self.end), "capture_warnings": [
            {"started_at": iso(self.start - timedelta(seconds=60)), "ended_at": iso(self.start + timedelta(seconds=30))},
            {"started_at": iso(self.end + timedelta(seconds=60)), "ended_at": iso(self.end + timedelta(seconds=90))}]}
        self.assertEqual(MeetingArchive._audio_gap(detail), {
            "started_at": self.start.isoformat(), "count": 1,
            "ended_at": (self.start + timedelta(seconds=30)).isoformat(), "seconds": 30})
        detail["capture_warnings"] = detail["capture_warnings"][1:]  # Only after this meeting ended.
        self.assertIsNone(MeetingArchive._audio_gap(detail))

    def test_final_speech_inside_the_dropout_clears_the_warning(self):
        lines = json.loads((self.first / "transcript.json").read_text())["segments"]
        lines.append({"speaker": "them", "start_ms": 3610000, "end_ms": 3620000, "text": "Still talking"})
        self.write_final(lines)
        self.finalize()
        self.assertEqual(self.stored()["capture_warnings"], [])
        self.assertIsNone(self.archive.detail("FIRST-CALL")["audio_gap"])

    def test_one_short_utterance_only_narrows_a_long_dropout(self):
        self.live["capture_warnings"] = [{"reason": "system-audio-lost", "started_at": iso(self.start + timedelta(seconds=2400))}]
        self.archive.sync_transcript(self.live)
        lines = json.loads((self.first / "transcript.json").read_text())["segments"]
        self.write_final([line for line in lines if not 2400000 < line["start_ms"]]
                         + [{"speaker": "them", "start_ms": 2500000, "end_ms": 2501000, "text": "One word"}])
        self.finalize()
        self.assertEqual(self.archive.detail("FIRST-CALL")["audio_gap"]["started_at"],
                         (self.start + timedelta(seconds=2501)).isoformat())

    def test_later_live_export_never_replaces_final_and_repeat_passes_change_nothing(self):
        self.next_call_ends()
        self.finalize()
        self.archive.sync_transcript(self.live)  # A restart re-reads an old live file.
        stored = self.stored()
        self.assertEqual(len(stored["segments"]), 406)
        path = self.root / "archive/FIRST-CALL/meeting.json"
        before = path.read_bytes()
        self.finalize()
        self.finalize()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.sent, ["FIRST-CALL"], "One report, sent once")


    def test_final_read_by_the_live_file_keeps_its_names_and_still_gets_its_report(self):
        from canonical_transcript import canonical_segments
        named = canonical_segments(self.live)
        for segment in named:
            if segment["source"] == "system":
                segment.update(speaker="Visual Name", speaker_confidence="visual-voice-map")
        self.archive.sync_transcript({**self.live, "segments": named})  # The next call then started.
        self.next_call_ends()
        self.finalize()
        stored = self.stored()
        self.assertTrue(stored["final_transcript"])
        self.assertEqual(stored["segments"][-1]["speaker"], "Visual Name")
        self.assertTrue((self.root / "reports/FIRST-CALL/report.json").exists())
        self.assertEqual(self.sent, ["FIRST-CALL"] if self.sent_automatically else [])

    def test_a_merged_report_waits_until_every_chunk_has_its_final_transcript(self):
        # A reconnect 30 s later is the same call: its chunk sorts first by folder name.
        early = self.start - timedelta(minutes=30)
        chunk = self.recording("2026.10.22-1530 Google Chrome Helper (Ap", early, self.start - timedelta(seconds=30))
        (chunk / "transcript.json").write_text(json.dumps({"engine": "fluidaudio", "segments": [
            {"speaker": "them", "start_ms": 1000, "end_ms": 3000, "text": "Earlier chunk final"}]}))
        self.archive.sync_transcript({**self.live, "meeting": "Synthetic sync"})  # Same title: one call.
        self.archive.sync_transcript({**self.live, "meeting": "Synthetic sync", "meeting_id": "EARLY-CHUNK", "started_at": iso(early),
                                      "updated_at": iso(self.start - timedelta(seconds=30)), "capture_warnings": [],
                                      "recording_dir": str(chunk), "segments": [
                                          {"source": "system", "timestamp": iso(early + timedelta(seconds=1)), "text": "Live chunk"}]})
        self.next_call_ends()
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"] if self.sent_automatically else [])
        texts = [item["text"] for item in self.archive.report_detail("FIRST-CALL")["transcript"]]
        self.assertIn("Earlier chunk final", texts)
        self.assertNotIn("Live chunk", texts)


    def test_a_failing_report_is_shown_and_tried_again_every_30_minutes_not_every_minute(self):
        self.next_call_ends()
        marker = self.root / "reports/FIRST-CALL/report-failure.json"
        with patch.object(self.archive, "_print_pdf", side_effect=archive.ReportPdfError("Chrome не создал PDF")) as printer:
            self.archive.finalize_history()
            self.archive.finalize_history()
            self.assertEqual(printer.call_count, 1)
            failure = json.loads(marker.read_text())
            self.assertEqual((failure["reason"], failure["attempts"]), ("pdf", 1))
            self.assertEqual(self.archive.detail("FIRST-CALL")["report_failure"]["reason"], "pdf")
            health = self.archive.delivery_health()
            item = next(item for item in health["undelivered"] if item["meeting_id"] == "FIRST-CALL")
            self.assertTrue(item["missing"] and item["failed"])
            self.assertGreaterEqual(health["issue_count"], 1)
            earlier = (datetime.now(timezone.utc) - timedelta(minutes=31)).isoformat()
            marker.write_text(json.dumps({**failure, "failed_at": earlier}))
            self.archive.finalize_history()
            self.assertEqual(printer.call_count, 2)
            self.assertEqual(json.loads(marker.read_text())["attempts"], 2)
        # The person's button does not wait for the 30 minutes, and success clears the failure.
        with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")), \
             patch.object(self.archive, "deliver", side_effect=lambda detail, meta, **_: self.sent.append(detail["meeting_id"]) or {"mail_status": "sent"}):
            self.archive.generate_report("FIRST-CALL")
        self.assertFalse(marker.exists())
        self.assertIsNone(self.archive.detail("FIRST-CALL")["report_failure"])
        self.assertNotIn("FIRST-CALL", [item["meeting_id"] for item in self.archive.delivery_health()["undelivered"]])


class OldMeetingRepairTests(FinalTranscriptAfterNextCallTests):
    sent_automatically = False

    def setUp(self):
        super().setUp(days_ago=10)
        self.next_call_ends()

    def test_old_meeting_gets_a_report_that_is_sent_only_on_request(self):
        self.finalize()
        path = self.root / "reports/FIRST-CALL/report.json"
        report = json.loads(path.read_text())
        self.assertTrue(report["delivery_on_request"])
        self.assertEqual(self.sent, [])
        # A report made while the call was still recording no longer waits for its end.
        path.write_text(json.dumps({**report, "mail_status": "waiting_for_end", "generated_while_recording": True}))
        (self.root / "archive/FIRST-CALL/meeting.json").touch()
        self.finalize()
        self.assertEqual(json.loads(path.read_text())["mail_status"], "pending")
        settings = json.loads((self.config / "delivery.json").read_text())
        with patch.object(self.archive, "deliver") as deliver:
            self.archive.retry_pending_deliveries()
            # A refresh that sends nothing (speaker rename) keeps it on request.
            with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")):
                self.archive.generate_report("FIRST-CALL", deliver=False)
            self.archive.retry_pending_deliveries()
        deliver.assert_not_called()
        self.assertTrue(json.loads(path.read_text())["delivery_on_request"])
        health = DeliveryHealth(self.root / "reports", self.config / "health.json").refresh(
            settings, now=datetime.now(timezone.utc) + timedelta(hours=1))
        self.assertEqual(health["issue_count"], 0)
        self.assertEqual(health["notifications"], [])
        # A send the person asked for that failed is shown, not hidden as "on request".
        failed = json.loads(path.read_text())
        path.write_text(json.dumps({**failed, "mail_status": "failed", "last_delivery_request": "synthetic-request-0001"}))
        health = DeliveryHealth(self.root / "reports", self.config / "health.json").refresh(
            settings, now=datetime.now(timezone.utc) + timedelta(hours=1))
        self.assertEqual(health["issue_count"], 1)
        self.assertEqual(health["channels"]["gmail"]["issues"][0]["reason"], "retry_expired")  # "Send again".

    # The inherited cases also hold for an old meeting, without any sending.
    def test_final_transcript_replaces_live_and_report_follows_when_next_call_ends(self):
        self.finalize()
        self.assertEqual(len(self.stored()["segments"]), 406)
        self.assertEqual(self.sent, [])

    def test_later_live_export_never_replaces_final_and_repeat_passes_change_nothing(self):
        self.finalize()
        self.archive.sync_transcript(self.live)
        self.assertEqual(len(self.stored()["segments"]), 406)


class RepairedOldMeetingDeliveryTests(unittest.TestCase):
    """MEETONTRACK-99, shaped like 9AE490BB: sent 10 days ago, email failed and
    Telegram arrived; the final transcript then rebuilt its report."""

    def __getattr__(self, name):  # The shared call fixture: root, config, archive, finalize, sent.
        case = self.__dict__.get("case")
        if case is None:
            raise AttributeError(name)
        return getattr(case, name)

    def setUp(self):
        self.case = FinalTranscriptAfterNextCallTests("test_dropout_in_the_last_minute_is_explained_not_flagged")
        self.case.setUp(days_ago=10)
        self.addCleanup(self.case.doCleanups)
        self.next_call_ends()
        self.settings = {"email_to": "synthetic@example.test", "telegram_account": "synthetic",
                         "telegram_config": "/synthetic/telegram", "drive_folder_id": "folder"}
        (self.config / "delivery.json").write_text(json.dumps(self.settings))
        self.sent_at = (self.end + timedelta(minutes=2)).isoformat(timespec="seconds")
        self.report_dir = self.root / "reports/FIRST-CALL"
        self.report_dir.mkdir(parents=True)
        (self.report_dir / "meeting-report.pdf").write_bytes(b"%PDF old")
        self.old = {"generated_at": self.sent_at, "html": "/api/archive/report/FIRST-CALL/index.html",
                    "pdf": "/api/archive/report/FIRST-CALL/meeting-report.pdf",
                    "pdf_path": str(self.report_dir / "meeting-report.pdf"), "source_signature": "live-text",
                    "drive_status": "uploaded", "drive_folder_url": "https://drive.google.com/drive/folders/f1",
                    "drive_html_url": "https://drive.google.com/file/d/h1/view",
                    "drive_pdf_url": "https://drive.google.com/file/d/p1/view",
                    "mail_status": "failed", "telegram_status": "sent",
                    "delivery_checked_at": self.sent_at, "delivery_retry_at": self.sent_at}
        (self.report_dir / "report.json").write_text(json.dumps(self.old))

    def health(self, hours: float = 0) -> dict:
        return DeliveryHealth(self.root / "reports", self.config / "delivery-health.json").refresh(
            self.settings, now=datetime.now(timezone.utc) + timedelta(hours=hours))

    def test_rebuilding_keeps_the_old_outcome_and_raises_no_new_delivery_problem(self):
        self.finalize()
        self.assertEqual(self.sent, [], "Nothing is sent for an old meeting")
        report = json.loads((self.report_dir / "report.json").read_text())
        self.assertTrue(report["delivery_on_request"])
        self.assertNotEqual(report["generated_at"], self.sent_at)  # The report itself is new.
        self.assertEqual((report["mail_status"], report["telegram_status"]), ("failed", "sent"))
        self.assertEqual((report["delivery_checked_at"], report["delivery_started_at"]), (self.sent_at, self.sent_at))
        self.assertEqual(report["drive_status"], "pending", "The Drive copy has the old text")
        self.assertEqual(report["drive_pdf_url"], self.old["drive_pdf_url"])
        health = self.health()
        self.assertEqual((health["issue_count"], health["notifications"]), (0, []))
        self.assertEqual(health["channels"]["drive"]["pending"], 0, "Old Drive copies are not pending work")
        with patch.object(self.archive, "deliver") as deliver:
            self.archive.retry_pending_deliveries()
        deliver.assert_not_called()
        self.assertEqual(self.archive.delivery_health()["undelivered"], [])

    def test_the_persons_create_again_starts_a_new_window_and_its_failure_shows(self):
        self.finalize()
        with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")), \
             patch.object(self.archive, "deliver", return_value={"mail_status": "failed"}) as deliver:
            self.archive.generate_report("FIRST-CALL")  # The "Create the report again" button.
        deliver.assert_called_once()
        report = json.loads((self.report_dir / "report.json").read_text())
        self.assertNotIn("delivery_on_request", report)
        self.assertNotEqual(report["delivery_started_at"], self.sent_at)
        health = self.health()
        self.assertEqual([i["reason"] for i in health["channels"]["gmail"]["issues"]], ["delivery_failed"])

    def test_a_missing_old_report_still_offers_create_again(self):
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        (self.report_dir / "report.json").write_text(json.dumps({
            "generated_at": now, "report_missing": True, "delivery_on_request": True,
            "mail_status": "failed", "telegram_status": "failed", "drive_status": "pending"}))
        health = self.health()
        self.assertIn("report_missing", [i["reason"] for i in health["channels"]["gmail"]["issues"]])

    def test_a_problem_already_raised_by_0_1_16_clears_on_the_next_check(self):
        self.finalize()
        # What 0.1.16 wrote after rebuilding the report: a fresh "email failed".
        report = json.loads((self.report_dir / "report.json").read_text())
        report.pop("delivery_started_at")
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        (self.report_dir / "report.json").write_text(json.dumps({**report, "delivery_checked_at": now, "delivery_retry_at": now}))
        key = "FIRST-CALL:gmail"
        issue = {"meeting_id": "FIRST-CALL", "channel": "gmail", "state": "failed", "reason": "delivery_failed"}
        (self.config / "delivery-health.json").write_text(json.dumps({
            "version": 1, "issues": {key: issue}, "sequence": 13, "acknowledged_through": 12,
            "events": [{**issue, "kind": "failed", "id": 13, "at": datetime.now().astimezone().isoformat()}]}))
        health = self.health()
        self.assertEqual((health["issue_count"], health["notifications"]), (0, []))
        self.assertNotIn(health["state"], {"failed", "action_required"})
        stored = json.loads((self.config / "delivery-health.json").read_text())
        self.assertEqual(stored["issues"], {})

    def test_a_refresh_inside_the_delivery_window_does_not_restart_it(self):
        # A recent report, sent 2 days ago; a speaker rename rebuilds it today.
        sent = (datetime.now().astimezone() - timedelta(days=2, hours=23)).isoformat(timespec="seconds")
        meta = {**self.old, "generated_at": sent, "delivery_checked_at": sent, "delivery_retry_at": sent}
        (self.report_dir / "report.json").write_text(json.dumps(meta))
        with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")), \
             patch.object(self.archive, "_ready_for_delivery", return_value=True), \
             patch.object(self.archive, "deliver") as deliver:
            self.archive.generate_report("FIRST-CALL", deliver=False)
            deliver.assert_not_called()
            report = json.loads((self.report_dir / "report.json").read_text())
            self.assertNotIn("delivery_on_request", report)
            self.assertEqual(report["delivery_started_at"], sent)
            # Two hours later the 3-day window from the first send is over: no more retries.
            with patch.object(archive, "datetime", wraps=datetime) as clock:
                clock.now.return_value = datetime.now().astimezone() + timedelta(hours=2)
                self.archive.retry_pending_deliveries()
            deliver.assert_not_called()
        self.assertEqual(self.health(hours=2)["issue_count"], 0, "Telegram arrived: the email failure closes")


class FinalOnlyDeliveryTests(unittest.TestCase):
    """MEETONTRACK-94 owner rule: a report goes out only from the final transcript."""

    def __getattr__(self, name):  # The shared call fixture: root, archive, finalize, sent, write_final...
        case = self.__dict__.get("case")
        if case is None:
            raise AttributeError(name)
        return getattr(case, name)

    def setUp(self):
        self.case = FinalTranscriptAfterNextCallTests("test_dropout_in_the_last_minute_is_explained_not_flagged")
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.final = json.loads((self.first / "transcript.json").read_text())["segments"]
        (self.first / "transcript.json").unlink()  # Only live text so far.
        self.next_call_ends()

    def report(self) -> dict:
        path = self.root / "reports/FIRST-CALL/report.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def test_nothing_is_sent_before_the_final_transcript_and_once_after_it(self):
        self.finalize()
        self.archive.retry_pending_deliveries()
        self.assertEqual(self.sent, [])
        self.assertEqual(self.report(), {}, "No report is built from live text")
        self.write_final(self.final)
        self.finalize()
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"], "Sent once, from the final transcript")
        texts = [item["text"] for item in self.archive.report_detail("FIRST-CALL")["transcript"]]
        self.assertEqual((len(texts), texts[-1]), (406, "Final goodbye"))
        self.assertNotIn("Live line 0", texts)

    def test_a_missing_final_transcript_needs_attention_and_nothing_is_sent(self):
        # The call ended about two hours ago and the recorder never wrote its final transcript.
        self.finalize()
        detail = self.archive.detail("FIRST-CALL")
        self.assertEqual((detail["final_wait"]["state"], detail["final_wait"]["reason"]), ("missing", "final_transcript"))
        summary = next(item for item in self.archive.list_meetings() if item["meeting_id"] == "FIRST-CALL")
        self.assertEqual(summary["final_wait"]["state"], "missing")
        item = next(item for item in self.archive.delivery_health()["undelivered"] if item["meeting_id"] == "FIRST-CALL")
        self.assertEqual(item["final_wait"]["state"], "missing")
        # The person's "Create the report" builds it from what there is, but sends nothing.
        with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")), \
             patch.object(self.archive, "deliver") as deliver:
            self.archive.generate_report("FIRST-CALL")
            self.archive.retry_pending_deliveries()
        deliver.assert_not_called()
        self.assertEqual(self.report()["mail_status"], "waiting_for_end")
        # A later final transcript sends it, once.
        self.write_final(self.final)
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"])
        self.assertEqual(self.report()["mail_status"], "sent")
        self.assertIsNone(self.archive.detail("FIRST-CALL")["final_wait"])
        self.assertNotIn("FIRST-CALL", [i["meeting_id"] for i in self.archive.delivery_health()["undelivered"]])

    def test_a_windows_final_transcript_with_a_byte_order_mark_is_imported(self):
        # The Windows recorder writes transcript.json with .NET's Encoding.UTF8, which starts
        # the file with a UTF-8 byte order mark; it was never read (MEETONTRACK-136).
        self.finalize()
        self.write_final(self.final)
        path = self.first / "transcript.json"
        path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes())
        self.finalize()
        self.assertTrue(self.stored().get("final_transcript"))
        self.assertIsNone(self.archive.detail("FIRST-CALL")["final_wait"])
        self.assertEqual(self.sent, ["FIRST-CALL"])

    def test_a_call_that_just_ended_is_only_waiting(self):
        meeting = self.stored()
        ended = datetime.now(timezone.utc) - timedelta(minutes=5)
        (self.root / "archive/FIRST-CALL/meeting.json").write_text(json.dumps({**meeting, "updated_at": iso(ended)}))
        meta = json.loads((self.first / "meta.json").read_text())
        (self.first / "meta.json").write_text(json.dumps({**meta, "ended": iso(ended)}))
        self.assertEqual(self.archive.detail("FIRST-CALL")["final_wait"]["state"], "waiting")
        self.assertNotIn("FIRST-CALL", [i["meeting_id"] for i in self.archive.delivery_health()["undelivered"]])

    def test_a_merged_report_waits_for_the_final_transcript_of_every_chunk(self):
        early = self.start - timedelta(minutes=30)
        chunk = self.recording("2026.10.22-1530 Google Chrome Helper (Ap", early, self.start - timedelta(seconds=30))
        self.archive.sync_transcript({**self.live, "meeting": "Synthetic sync"})  # Same title: one call.
        self.archive.sync_transcript({**self.live, "meeting": "Synthetic sync", "meeting_id": "EARLY-CHUNK", "started_at": iso(early),
                                      "updated_at": iso(self.start - timedelta(seconds=30)), "capture_warnings": [],
                                      "recording_dir": str(chunk), "segments": [
                                          {"source": "system", "timestamp": iso(early + timedelta(seconds=1)), "text": "Live chunk"}]})
        self.write_final(self.final)  # The last chunk is final, the earlier one is not.
        self.finalize()
        self.assertEqual(self.sent, [], "Never one chunk's final text with another's live text")
        (chunk / "transcript.json").write_text(json.dumps({"engine": "fluidaudio", "segments": [
            {"speaker": "them", "start_ms": 1000, "end_ms": 3000, "text": "Earlier chunk final"}]}))
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"])
        texts = [item["text"] for item in self.archive.report_detail("FIRST-CALL")["transcript"]]
        self.assertIn("Earlier chunk final", texts)
        self.assertNotIn("Live chunk", texts)

    def test_a_restart_between_live_and_final_sends_once(self):
        self.finalize()
        self.case.archive = MeetingArchive(self.root / "recordings", self.root / "archive", self.root / "reports", self.config)
        self.write_final(self.final)
        self.finalize()
        self.case.archive = MeetingArchive(self.root / "recordings", self.root / "archive", self.root / "reports", self.config)
        self.finalize()
        self.archive.retry_pending_deliveries()
        self.assertEqual(self.sent, ["FIRST-CALL"])

    def test_speakers_corrected_on_live_text_carry_to_the_final_sent_once(self):
        # MEETONTRACK-117: the person renamed the other side during the call.
        self.archive.speaker_edits.rename(self.archive.annotate_speakers(self.stored()), "remote-1", "Synthetic Name")
        self.write_final(self.final)
        self.finalize()
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"], "Sent once, from the final transcript")
        stored = self.stored()
        self.assertNotIn("speaker_review", stored)
        self.assertTrue(all(item["text"].startswith("Final") for item in stored["segments"]))
        speakers = {item["source"]: set() for item in stored["segments"]}
        for item in self.archive.report_detail("FIRST-CALL")["transcript"]:
            speakers.setdefault(item.get("source"), set()).add(item.get("speaker"))
        self.assertEqual(speakers["system"], {"Synthetic Name"}, "Every line of the renamed voice")
        self.assertNotIn("Synthetic Name", speakers["microphone"])

    def test_a_correction_the_final_cannot_place_is_flagged_and_still_sent(self):
        live = self.archive.annotate_speakers(self.stored())["segments"]
        for segment, name in ((live[0], "Synthetic Alpha"), (live[1], "Synthetic Beta")):
            self.archive.speaker_edits.assign(self.archive.annotate_speakers(self.stored()), [segment["segment_id"]], name=name)
        # The final transcript holds both corrected moments in one line of one voice.
        self.write_final([{"speaker": "me", "start_ms": 1000, "end_ms": 3000, "text": "Final hello"},
                          {"speaker": "them", "start_ms": 39000, "end_ms": 125000, "text": "Final long line"}])
        self.finalize()
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"], "Still sent once, from the final transcript")
        detail = self.archive.detail("FIRST-CALL")
        self.assertEqual(detail["speaker_review"]["names"], ["Synthetic Alpha", "Synthetic Beta"])
        self.assertEqual(len(detail["speaker_review"]["segment_ids"]), 1)
        line = next(item for item in self.stored()["segments"] if item["text"] == "Final long line")
        self.assertNotIn(line.get("speaker"), {"Synthetic Alpha", "Synthetic Beta"}, "The final keeps its own label")
        summary = next(item for item in self.archive.list_meetings() if item["meeting_id"] == "FIRST-CALL")
        self.assertTrue(summary["speaker_review"])

    def test_the_owners_own_name_carries_to_the_final(self):
        final = [{"source": "microphone", "timestamp": "2026-10-22T16:00:00+00:00", "text": "Final mine"}]
        live = [{"source": "microphone", "timestamp": "2026-10-22T16:00:00+00:00", "speaker_id": "self",
                 "speaker": "Synthetic Me", "speaker_identity": "manual", "text": "Live mine"}]
        segments, names, review = carry_corrections(live, {"self": "Synthetic Me"}, final)
        self.assertEqual((segments, names, review), (final, {"self": "Synthetic Me"}, None))

    def test_a_live_file_showing_the_final_text_keeps_corrections_for_the_import(self):
        self.archive.speaker_edits.rename(self.archive.annotate_speakers(self.stored()), "remote-1", "Synthetic Name")
        self.write_final(self.final)
        # The live file reads the final transcript before the 60-second import runs.
        self.archive.sync_transcript({**self.live, "segments": archive.canonical_segments(self.stored())})
        self.assertTrue(self.stored()["segments"][0]["text"].startswith("Live"), "Corrected live text kept")
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"])
        system = {item.get("speaker") for item in self.stored()["segments"] if item["source"] == "system"}
        self.assertEqual(system, {"Synthetic Name"})

    def test_an_uncorrected_line_is_not_given_a_name_from_its_voice(self):
        at = lambda second: f"2026-10-22T16:00:{second:02d}+00:00"
        live = [{"source": "system", "timestamp": at(0), "end_timestamp": at(10), "speaker_id": "manual-a",
                 "speaker": "Synthetic Alpha", "speaker_identity": "manual", "text": "Live"},
                {"source": "system", "timestamp": at(20), "end_timestamp": at(24), "speaker_id": "remote-1",
                 "speaker": "Собеседник 1", "text": "Live"}]
        final = [{"source": "system", "timestamp": at(0), "end_timestamp": at(10), "text": "Final"},
                 {"source": "system", "timestamp": at(20), "end_timestamp": at(24), "text": "Final"}]
        segments, _, review = carry_corrections(live, {}, final)
        self.assertEqual([item.get("speaker") for item in segments], ["Synthetic Alpha", None])
        self.assertIsNone(review)

    def test_one_corrected_line_does_not_rename_its_whole_voice(self):
        at = lambda second: f"2026-10-22T16:00:{second:02d}+00:00"
        live = [{"source": "system", "timestamp": at(second), "end_timestamp": at(second + 4), "speaker_id": "remote-1",
                 "speaker": "Собеседник 1", "text": "Live"} for second in (0, 10, 20, 30)]
        live[1].update(speaker_id="manual-x", speaker="Synthetic Guest", speaker_identity="manual")
        final = [{"source": "system", "timestamp": at(second), "end_timestamp": at(second + 4), "text": "Final"}
                 for second in (0, 10, 20, 30)]
        segments, _, review = carry_corrections(live, {}, final)
        self.assertEqual([item.get("speaker") for item in segments], [None, "Synthetic Guest", None, None])
        self.assertIsNone(review)

    def test_a_rebuild_of_lost_analysis_holds_the_report_until_it_ends(self):
        pending = {"FIRST-CALL"}
        self.archive.analysis_pending = lambda meeting_id: meeting_id in pending
        self.write_final(self.final)
        self.finalize()
        self.assertEqual(self.sent, [])
        pending.clear()
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"])

    def make_report(self) -> None:
        with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")), \
             patch.object(self.archive, "deliver") as deliver:
            self.archive.generate_report("FIRST-CALL")  # The person's button, before the final transcript.
        deliver.assert_not_called()

    def test_a_pdf_made_from_live_text_is_never_retried_after_the_final_import(self):
        self.make_report()
        self.write_final(self.final)
        self.archive.import_final_transcript(self.stored())
        with patch.object(self.archive, "deliver") as deliver:
            self.archive.retry_pending_deliveries()
        deliver.assert_not_called()
        self.finalize()  # Made again from the final text, then sent.
        self.assertEqual(self.sent, ["FIRST-CALL"])

    def test_text_read_before_a_racing_final_import_is_never_ready(self):
        stale = self.archive.report_detail("FIRST-CALL")  # A retry read the live text...
        self.write_final(self.final)
        self.archive.import_final_transcript(self.stored())  # ...then the final import landed.
        self.assertFalse(self.archive._ready_for_delivery(stale))
        self.assertTrue(self.archive._ready_for_delivery(self.archive.report_detail("FIRST-CALL")))

    def test_a_retry_of_an_outdated_pdf_has_the_report_made_again(self):
        self.write_final(self.final)
        self.finalize()
        self.archive._history_checked["FIRST-CALL"] = ("cached",)
        path = self.root / "reports/FIRST-CALL/report.json"
        path.write_text(json.dumps({**self.report(), "mail_status": "failed", "source_signature": "before-a-late-fact-check",
                                    "delivery_retry_at": iso(datetime.now(timezone.utc) - timedelta(minutes=1))}))
        with patch.object(self.archive, "deliver") as deliver:
            self.archive.retry_pending_deliveries()
        deliver.assert_not_called()
        self.assertNotIn("FIRST-CALL", self.archive._history_checked)

    def test_an_uncertain_send_stays_uncertain_while_the_report_waits(self):
        report_dir = self.root / "reports/FIRST-CALL"
        report_dir.mkdir(parents=True)
        (report_dir / "report.json").write_text(json.dumps({"mail_status": "unknown"}))
        self.make_report()
        self.assertEqual(self.report()["mail_status"], "unknown")

    def test_a_speaker_edit_opened_on_live_text_cannot_overwrite_the_final_one(self):
        live = self.archive.detail("FIRST-CALL")
        self.write_final(self.final)
        self.archive.import_final_transcript(self.stored())
        with self.assertRaises(ValueError):
            self.archive.speaker_edits.rename({**live, "segments": live["transcript"]}, "remote-1", "Synthetic Name")
        self.assertEqual(len(self.stored()["segments"]), 406)

    def test_meetings_already_sent_are_never_sent_again(self):
        # Sent from live text before this change, within and after the delivery window.
        for days in (0, 10):
            report_dir = self.root / "reports/FIRST-CALL"
            report_dir.mkdir(parents=True, exist_ok=True)
            (report_dir / "meeting-report.pdf").write_bytes(b"%PDF old")
            sent_at = (datetime.now(timezone.utc) - timedelta(days=days, hours=2)).isoformat(timespec="seconds")
            (report_dir / "report.json").write_text(json.dumps({
                "generated_at": sent_at, "delivery_started_at": sent_at, "source_signature": "live-text",
                "pdf_path": str(report_dir / "meeting-report.pdf"), "html": "x", "pdf": "y",
                "mail_status": "sent", "telegram_status": "sent", "drive_status": "uploaded"}))
            with patch.object(self.archive, "deliver") as deliver:
                self.archive.retry_pending_deliveries()
                self.finalize()
            deliver.assert_not_called()
            self.assertEqual(self.sent, [])


class LateFinalTranscriptTests(unittest.TestCase):
    """MEETONTRACK-118: a call that ended 4 days ago, never sent, whose final transcript never came."""

    def __getattr__(self, name):  # The shared call fixture: root, config, archive, finalize, sent.
        case = self.__dict__.get("case")
        if case is None:
            raise AttributeError(name)
        return getattr(case, name)

    def setUp(self):
        self.case = FinalTranscriptAfterNextCallTests("test_dropout_in_the_last_minute_is_explained_not_flagged")
        self.case.setUp(days_ago=4)
        self.addCleanup(self.case.doCleanups)
        self.final = json.loads((self.first / "transcript.json").read_text())["segments"]
        (self.first / "transcript.json").unlink()  # Only live text.
        self.next_call_ends()

    def watched_since(self, moment: datetime) -> None:
        path = self.config / "delivery-health.json"
        stored = json.loads(path.read_text()) if path.exists() else {}
        path.write_text(json.dumps({**stored, "final_wait_since": iso(moment)}))
        self.case.archive = MeetingArchive(self.root / "recordings", self.root / "archive", self.root / "reports", self.config)

    def flagged(self) -> bool:
        return "FIRST-CALL" in [item["meeting_id"] for item in self.archive.delivery_health()["undelivered"]]

    def test_still_flagged_after_the_window_and_a_late_final_sends_it(self):
        self.watched_since(datetime.now(timezone.utc) - timedelta(days=5))
        self.finalize()
        self.assertEqual(self.archive.detail("FIRST-CALL")["final_wait"]["state"], "missing")
        self.assertTrue(self.flagged())
        self.write_final(self.final)
        self.finalize()
        self.assertEqual(self.sent, ["FIRST-CALL"], "The late final sends it, as the warning promised")
        self.assertFalse(self.flagged())

    def test_history_from_before_the_change_is_not_flagged(self):
        self.watched_since(datetime.now(timezone.utc))
        self.finalize()
        self.assertIsNone(self.archive.detail("FIRST-CALL")["final_wait"])
        self.assertFalse(self.flagged())

if __name__ == "__main__":
    unittest.main()
