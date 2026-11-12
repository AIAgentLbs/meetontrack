"""MEETONTRACK-129: reading a repository never runs commands from its own .git/config."""
import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import server

ROOT = Path(__file__).resolve().parents[2]


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(shutil.which("git") and shutil.which("touch"), "needs git and a POSIX shell")
class UntrustedRepositoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "code" / "evil"
        self.repo.mkdir(parents=True)
        git = lambda *args: subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)
        git("init", "-q")
        (self.repo / ".gitattributes").write_text("a.txt filter=evil\nb.txt filter=Proc diff=tc\n")
        for name in ("a.txt", "b.txt"):
            (self.repo / name).write_text("original\n")
        git("add", ".")
        git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init")
        marker = self.root / "ran"
        for key in ("core.fsmonitor", "filter.evil.clean", "filter.Proc.process", "diff.external", "diff.tc.textconv"):
            git("config", key, f"touch {marker}-{key}; cat")
        for name in ("a.txt", "b.txt"):
            (self.repo / name).write_text("changed\n")
        self.marker = marker

    def ran(self):
        return sorted(path.name for path in self.root.iterdir() if path.name.startswith("ran-"))

    def test_the_unguarded_repository_does_run_its_commands(self):
        subprocess.run(["git", "-C", str(self.repo), "status", "--porcelain"], capture_output=True)
        self.assertTrue(self.ran())  # the fixture is really hostile

    def test_server_git_metadata_runs_none_of_them(self):
        text = server.git_metadata([self.repo])
        self.assertIn("a.txt", text)  # still reads the change
        self.assertEqual(self.ran(), [])

    def test_macos_repository_refresh_runs_none_of_them(self):
        refresh = load(ROOT / "copilot/config/refresh-repos.py", "refresh_repos_mac")
        self.assertEqual(refresh.working_tree_status(self.repo)[0], "dirty")
        refresh.command(self.repo, "rev-parse", "HEAD")
        self.assertEqual(self.ran(), [])

    def test_windows_repository_refresh_runs_none_of_them(self):
        refresh = load(ROOT / "scripts/windows/refresh-repos.py", "refresh_repos_windows")
        self.assertEqual([row["status"] for row in refresh.inventory([self.root / "code"])], ["dirty"])
        self.assertEqual(self.ran(), [])


if __name__ == "__main__":
    unittest.main()
