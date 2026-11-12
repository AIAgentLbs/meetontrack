from pathlib import Path
import re
import unittest

import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/windows-candidate.yml"
# Anything that creates, changes or uploads to a GitHub release.
PUBLISHING = re.compile(r"gh\s+release\s+(create|upload|edit|delete)|softprops/action-gh-release|ncipollo/release-action")


class WindowsCandidateWorkflowSafetyTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)

    def test_build_job_has_read_only_contents(self):
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        self.assertNotIn("permissions", self.workflow["jobs"]["build"])

    def test_no_job_publishes_a_release(self):
        for name, job in self.workflow["jobs"].items():
            for step in job["steps"]:
                text = f"{step.get('uses', '')}\n{step.get('run', '')}"
                self.assertIsNone(PUBLISHING.search(text), f"{name}: {step.get('name') or step.get('uses')}")

    def test_write_token_only_in_opt_in_release_asset_check(self):
        writers = {name for name, job in self.workflow["jobs"].items()
                   if job.get("permissions", {}).get("contents") == "write"}
        self.assertEqual(writers, {"installer"})
        self.assertEqual(self.workflow["jobs"]["installer"]["if"], "inputs.check_release_asset")


if __name__ == "__main__":
    unittest.main()
