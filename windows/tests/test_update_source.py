import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "windows" / "src" / "Amanu.App"


class UpdateSourceTests(unittest.TestCase):
    def test_recorder_offers_no_velopack_update_check(self) -> None:
        # MEETONTRACK-81: releases carry no Velopack feed, so an in-app Velopack check can only
        # report "not installed". Updates go through the assistant's one-click Install (docs/UPDATES.md).
        offenders = [
            path.name
            for path in APP.rglob("*.cs")
            if re.search(r"\bUpdateManager\b|\bGithubSource\b|CheckForUpdates", path.read_text(encoding="utf-8"))
        ]
        self.assertEqual(offenders, [])
        tray = (APP / "TrayIconService.cs").read_text(encoding="utf-8")
        self.assertNotIn("Check for updates", tray)


if __name__ == "__main__":
    unittest.main()
