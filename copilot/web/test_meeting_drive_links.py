"""The library detail exposes the Drive copies delivery recorded (synthetic data)."""

import json
import tempfile
import unittest
from pathlib import Path

from archive import MeetingArchive


class MeetingDriveLinksTests(unittest.TestCase):
    def test_detail_exposes_only_https_google_drive_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config").mkdir()
            archive = MeetingArchive(root / "recordings", root / "archive", root / "reports", root / "config")
            archive.sync_transcript({"meeting_id": "CALL", "meeting": "Synthetic call", "status": "finished",
                                     "started_at": "2026-09-29T08:00:00Z", "updated_at": "2026-09-29T08:30:00Z",
                                     "segments": [{"source": "system", "timestamp": "2026-09-29T08:01:00Z",
                                                   "text": "Synthetic line"}]})
            self.assertEqual(archive.detail("CALL")["drive_links"], {})  # Not delivered: no links.
            (root / "reports" / "CALL").mkdir(parents=True)
            (root / "reports" / "CALL" / "report.json").write_text(json.dumps({
                "drive_status": "uploaded",
                "drive_folder_url": "https://drive.google.com/drive/folders/folder123",
                "drive_pdf_url": "https://drive.google.com/file/d/pdf123/view",
                "drive_html_url": "javascript:alert(1)",
            }))
            self.assertEqual(archive.detail("CALL")["drive_links"], {
                "folder_url": "https://drive.google.com/drive/folders/folder123",
                "pdf_url": "https://drive.google.com/file/d/pdf123/view",
            })


if __name__ == "__main__":
    unittest.main()
