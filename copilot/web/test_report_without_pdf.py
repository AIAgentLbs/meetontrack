"""MEETONTRACK-120: on Windows no report was ever sent.

The PDF printer looked for Chrome only at its macOS path, so every report failed
before delivery. Now Chrome, then Edge, is found at its standard places, and a
report that still cannot become a PDF is kept and sent as one HTML file. Only a
final transcript is ever sent. All text and addresses are synthetic.
"""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import archive
from archive import MeetingArchive
import test_final_after_next_call as base

PDF = lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")  # noqa: E731
NO_PDF = archive.ReportPdfError("Не найден браузер Chrome или Edge для создания PDF")


class BrowserLookupTests(unittest.TestCase):
    def test_edge_is_used_when_chrome_is_missing(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(folder, ignore_errors=True))
        chrome, edge = folder / "chrome.exe", folder / "msedge.exe"
        edge.write_bytes(b"")
        with patch.object(MeetingArchive, "_pdf_browser_candidates", return_value=[chrome, edge]):
            self.assertEqual(MeetingArchive.pdf_browser(), edge)
            chrome.write_bytes(b"")
            self.assertEqual(MeetingArchive.pdf_browser(), chrome)

    def test_no_browser_is_a_plain_report_error(self):
        with patch.object(MeetingArchive, "_pdf_browser_candidates", return_value=[]):
            with self.assertRaisesRegex(archive.ReportPdfError, "Chrome или Edge"):
                MeetingArchive._print_pdf(Path("index.html"), Path("meeting-report.pdf"))

    @unittest.skipUnless(os.name == "nt", "Windows install places")
    def test_windows_looks_in_program_files_and_local_app_data(self):
        places = [str(path) for path in MeetingArchive._pdf_browser_candidates()]
        self.assertTrue(any(place.endswith(r"Google\Chrome\Application\chrome.exe") for place in places))
        self.assertTrue(any(place.endswith(r"Microsoft\Edge\Application\msedge.exe") for place in places))
        chrome = max(i for i, place in enumerate(places) if place.lower().endswith("chrome.exe"))
        edge = min(i for i, place in enumerate(places) if place.lower().endswith("msedge.exe"))
        self.assertLess(chrome, edge, "Chrome first, Edge only when Chrome is missing")

    @unittest.skipUnless(os.name != "nt", "macOS and Linux install places")
    def test_mac_keeps_chrome_first_and_also_accepts_edge(self):
        places = [str(path) for path in MeetingArchive._pdf_browser_candidates()]
        if places and places[0].startswith("/Applications"):
            self.assertEqual(places[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
            self.assertTrue(any("Microsoft Edge" in place for place in places))


class ReportWithoutPdfTests(unittest.TestCase):
    """A report Chrome/Edge cannot print still reaches the person, as HTML."""

    def setUp(self):
        case = base.FinalTranscriptAfterNextCallTests("test_dropout_in_the_last_minute_is_explained_not_flagged")
        case.setUp()
        self.addCleanup(case.doCleanups)
        self.case, self.archive, self.root, self.config = case, case.archive, case.root, case.config
        self.next_call_ends = case.next_call_ends
        self.calls: list[tuple] = []
        self.refuse = False
        connector = patch.object(self.archive.delivery_settings, "executable", return_value="/fake/gws-personal")
        connector.start()
        self.addCleanup(connector.stop)
        (self.config / "delivery.json").write_text(json.dumps({
            "email_enabled": True, "email_to": "synthetic@example.test", "google_account": "synthetic@example.test",
            "drive_enabled": True, "drive_folder_id": "folder-id"}))
        self.report = self.root / "reports/FIRST-CALL"

    def gws(self, *args, diagnostics=None, **_):
        self.calls.append(args)
        if args[:2] == ("gmail", "+send"):
            attached = Path(args[args.index("--attach") + 1])
            if self.refuse:  # A clear rejection, retried later (not an unknown outcome).
                diagnostics.update(provider="gws", reason="client_failed")
                return None
            self.attached = (attached.name, attached.read_text(encoding="utf-8") if attached.suffix == ".html" else "")
            return {"id": f"message-{len(self.calls)}"}
        return None

    def sends(self) -> list[tuple]:
        return [call for call in self.calls if call[:2] == ("gmail", "+send")]

    def create(self, printer) -> None:
        with patch.object(self.archive, "_print_pdf", side_effect=printer), \
             patch.object(self.archive, "_gws_call", side_effect=self.gws), \
             patch.object(self.archive, "_upload_drive_report_gws", return_value=("uploaded", {})) as drive:
            self.archive.finalize_history()
        self.drive_uploads = drive.call_count

    def backdate_failure(self) -> None:
        marker = self.report / archive.REPORT_FAILURE
        failure = json.loads(marker.read_text())
        marker.write_text(json.dumps({**failure, "failed_at": (datetime.now(timezone.utc) - timedelta(minutes=31)).isoformat()}))

    def test_live_text_is_never_sent_even_without_pdf(self):
        self.create(NO_PDF)  # The next call still records: nothing is final yet.
        self.assertEqual(self.sends(), [])
        self.assertFalse((self.report / "report.json").exists())

    def test_the_report_is_sent_as_html_with_a_note_and_the_problem_is_shown(self):
        frames = self.root / "frame.jpg"
        frames.write_bytes(b"\xff\xd8synthetic-jpeg")
        self.next_call_ends()
        with patch.object(self.archive, "_choose_frames", return_value=[{"path": str(frames), "id": "f1"}]):
            self.create(NO_PDF)
        sends = self.sends()
        self.assertEqual(len(sends), 1)
        body = sends[0][sends[0].index("--body") + 1]
        self.assertIn("PDF создать не удалось", body)
        self.assertIn("HTML", body)
        name, text = self.attached
        self.assertEqual(name, "meeting-report.html")
        self.assertIn("Final goodbye", text)
        self.assertNotIn("Live line", text)
        self.assertIn("data:image/jpeg;base64,", text, "Frames travel inside the one HTML file")
        self.assertEqual(self.drive_uploads, 0, "Drive waits for the PDF")
        report = json.loads((self.report / "report.json").read_text())
        self.assertEqual((report["mail_status"], report["pdf"]), ("sent", ""))
        failure = json.loads((self.report / archive.REPORT_FAILURE).read_text())
        self.assertEqual((failure["reason"], failure["fallback"]), ("pdf", "html"))
        item = next(item for item in self.archive.delivery_health()["undelivered"] if item["meeting_id"] == "FIRST-CALL")
        self.assertEqual(item["failed"]["fallback"], "html")
        self.assertEqual(self.archive.detail("FIRST-CALL")["library_status"], "report_ready")

    def test_a_later_pdf_reaches_drive_but_the_email_is_not_sent_twice(self):
        self.next_call_ends()
        self.create(NO_PDF)
        self.create(NO_PDF)  # Within 30 minutes: no new attempt.
        self.assertEqual(len(self.sends()), 1)
        self.backdate_failure()
        self.create(NO_PDF)  # Retried, still no PDF: the email already went out.
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(json.loads((self.report / archive.REPORT_FAILURE).read_text())["attempts"], 2)
        self.backdate_failure()
        self.create(PDF)
        self.assertEqual(len(self.sends()), 1, "The email was sent once, as HTML")
        self.assertEqual(self.drive_uploads, 1)
        self.assertFalse((self.report / archive.REPORT_FAILURE).exists())
        self.assertFalse((self.report / archive.STANDALONE_REPORT).exists())
        self.assertTrue((self.report / "meeting-report.pdf").read_bytes().startswith(b"%PDF"))

    def test_an_older_pdf_is_never_sent_for_newer_text(self):
        self.next_call_ends()
        self.refuse = True  # The first send fails, so the revised report is the one sent.
        self.create(PDF)
        self.refuse = False
        self.assertTrue((self.report / "meeting-report.pdf").is_file())
        path = self.root / "archive/FIRST-CALL/meeting.json"
        stored = json.loads(path.read_text())
        stored["segments"].append({"source": "system", "timestamp": stored["segments"][-1]["timestamp"],
                                   "text": "Added after the first PDF"})
        path.write_text(json.dumps(stored))
        with patch.object(self.archive, "_print_pdf", side_effect=NO_PDF), \
             patch.object(self.archive, "_gws_call", side_effect=self.gws):
            with self.assertRaises(archive.ReportPdfError):
                self.archive.generate_report("FIRST-CALL")
        self.assertFalse((self.report / "meeting-report.pdf").exists())
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(self.attached[0], "meeting-report.html")
        self.assertIn("Added after the first PDF", self.attached[1])

    def test_a_current_pdf_stays_when_a_refresh_cannot_print(self):
        self.next_call_ends()
        self.create(PDF)
        self.assertEqual(len(self.sends()), 1)
        with patch.object(self.archive, "_print_pdf", side_effect=NO_PDF):
            with self.assertRaises(archive.ReportPdfError):
                self.archive.generate_report("FIRST-CALL", deliver=False)
        self.assertTrue((self.report / "meeting-report.pdf").is_file())
        self.assertFalse((self.report / archive.STANDALONE_REPORT).exists())

    def test_a_manual_resend_of_an_html_only_report_attaches_the_html(self):
        self.next_call_ends()
        self.create(NO_PDF)
        from delivery_retry import DeliveryRetry
        retry = DeliveryRetry(self.archive)
        with patch.object(self.archive, "_gws_call", side_effect=self.gws):
            retry._run("FIRST-CALL", "r" * 20, {"email"}, True)
        self.assertEqual(retry.snapshot()["state"], "complete", retry.snapshot())
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(self.attached[0], "meeting-report.html")



@unittest.skipUnless(os.environ.get("MEETONTRACK_REAL_PDF"), "prints with the installed browser (CI sets MEETONTRACK_REAL_PDF)")
class RealBrowserReportTests(unittest.TestCase):
    """The fixture meeting's report printed by the real Chrome or Edge (Windows CI runs both)."""

    def test_the_fixture_meeting_gets_a_valid_pdf(self):
        expected = os.environ.get("MEETONTRACK_EXPECT_BROWSER", "")
        browser = MeetingArchive.pdf_browser()
        self.assertIsNotNone(browser, "No Chrome or Edge found")
        if expected:
            self.assertEqual(browser.stem.lower(), expected.lower(), str(browser))
        case = base.FinalTranscriptAfterNextCallTests("test_dropout_in_the_last_minute_is_explained_not_flagged")
        case.setUp()
        self.addCleanup(case.doCleanups)
        case.next_call_ends()
        with patch.object(case.archive, "deliver", return_value={}) as deliver:
            case.archive.finalize_history()  # Imports the final transcript, then prints for real.
        self.assertEqual(deliver.call_count, 1)
        report = case.root / "reports/FIRST-CALL"
        pdf = (report / "meeting-report.pdf").read_bytes()
        self.assertTrue(pdf.startswith(b"%PDF-") and b"%%EOF" in pdf[-1024:] and len(pdf) > 4096, len(pdf))
        self.assertFalse((report / archive.REPORT_FAILURE).exists())
        self.assertFalse((report / archive.STANDALONE_REPORT).exists())
        print(f"PDF {len(pdf)} bytes printed by {browser}", flush=True)


if __name__ == "__main__":
    unittest.main()
