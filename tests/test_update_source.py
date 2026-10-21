import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UPDATE_SERVICE = ROOT / "windows" / "src" / "Amanu.App" / "UpdateService.cs"


class UpdateSourceTests(unittest.TestCase):
    def test_windows_updates_use_the_public_integrated_app_releases(self) -> None:
        source = UPDATE_SERVICE.read_text(encoding="utf-8")
        sources = re.findall(
            r'new\s+GithubSource\(\s*"([^"]+)"\s*,\s*accessToken:\s*([^,\s)]+)',
            source,
        )

        self.assertEqual(
            sources,
            [("https://github.com/AIAgentLbs/meetontrack", "null")],
            "Windows updates must use the canonical public app repository anonymously.",
        )


if __name__ == "__main__":
    unittest.main()
