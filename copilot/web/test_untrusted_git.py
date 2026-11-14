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
        marker = self.root / "ran"
        hostile = lambda key: f"touch {marker}-{key}; cat"
        sub = self.root / "sub"  # a submodule whose own config defines a clean filter
        sub.mkdir()
        self.init(sub, "s.txt filter=subevil\n", ("s.txt",))
        self.repo_git = git = lambda *args: subprocess.run(["git", "-C", str(self.repo), *args],
                                                           check=True, capture_output=True)
        self.init(self.repo, "a.txt filter=evil\nb.txt filter=Proc diff=tc\nc.txt filter=wt\n",
                  ("a.txt", "b.txt", "c.txt"))
        git("-c", "protocol.file.allow=always", "submodule", "add", "-q", str(sub), "sub")
        git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "sub")
        for key in ("core.fsmonitor", "filter.evil.clean", "filter.Proc.process", "diff.external", "diff.tc.textconv"):
            git("config", key, hostile(key))
        git("config", "core.repositoryformatversion", "1")  # config.worktree is read only with this extension
        git("config", "extensions.worktreeConfig", "true")
        git("config", "--worktree", "filter.wt.clean", hostile("filter.wt.clean"))
        subprocess.run(["git", "-C", str(self.repo / "sub"), "config", "filter.subevil.clean",
                        hostile("filter.subevil.clean")], check=True, capture_output=True)
        for name in ("a.txt", "b.txt", "c.txt", "sub/s.txt"):
            (self.repo / name).write_text("CHANGED!\n")  # same size: status must run the clean filter
        self.marker = marker

    @staticmethod
    def init(repo, attributes, names):
        git = lambda *args: subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
        git("init", "-q")
        (repo / ".gitattributes").write_text(attributes)
        for name in names:
            (repo / name).write_text("original\n")
        git("add", ".")
        git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init")

    def ran(self):
        return sorted(path.name for path in self.root.iterdir() if path.name.startswith("ran-"))

    def test_the_unguarded_repository_does_run_its_commands(self):
        subprocess.run(["git", "-C", str(self.repo), "status", "--porcelain"], capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "core.fsmonitor=false", "diff", "--stat"], capture_output=True)
        ran = self.ran()  # the fixture is really hostile, including config.worktree and the submodule
        self.assertIn("ran-filter.wt.clean", ran)
        self.assertIn("ran-filter.subevil.clean", ran)

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
