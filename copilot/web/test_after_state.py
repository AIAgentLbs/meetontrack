import os
import tempfile
import unittest
from pathlib import Path

from after_state import AfterState


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class AfterStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.clock = Clock()
        self.after = AfterState(self.root, clock=self.clock)

    def tearDown(self):
        self.temp.cleanup()

    def defaults(self):
        return {"version": 1, "held": False, "send_now_at": None, "changed_at": None,
                "summary": None, "next_steps": None, "removed": [], "resent_at": None, "delivered_at": None}

    def test_defaults_and_bad_file(self):
        self.assertEqual(self.after.read("m1"), self.defaults())
        folder = self.root / "m2"
        folder.mkdir()
        (folder / "after.json").write_text("[", encoding="utf-8")
        self.assertEqual(self.after.read("m2"), self.defaults())

    def test_wrong_types_read_as_defaults(self):
        folder = self.root / "m3"
        folder.mkdir()
        (folder / "after.json").write_text(
            '{"held": "yes", "changed_at": "x", "send_now_at": true, "resent_at": [1], '
            '"summary": 5, "next_steps": "Call back.", "removed": ["journal:j1", 7, null]}', encoding="utf-8")
        state = self.after.read("m3")
        self.assertEqual(state, {**self.defaults(), "next_steps": "Call back.", "removed": ["journal:j1"]})
        self.assertTrue(self.after.gate("m3", None)["open"])  # never raises inside the delivery path

    def test_gate_order(self):
        t = self.clock.now
        self.assertEqual(self.after.gate("m1", None), {"open": True, "reason": "", "send_at": None})
        self.after.hold("m1")
        self.assertEqual(self.after.gate("m1", None)["reason"], "held")
        self.clock.now = t + 3600
        self.assertEqual(self.after.gate("m1", None), {"open": False, "reason": "held", "send_at": None})
        self.after.send_now("m1")
        self.assertTrue(self.after.gate("m1", t + 3600)["open"])  # Send now skips the showing pause
        self.clock.now = t + 3700
        self.assertEqual(self.after.edit("m1", "summary", "Pilot starts in March."), t + 3730)
        self.assertEqual(self.after.gate("m1", None),
                         {"open": False, "reason": "changes", "send_at": t + 3730})
        self.clock.now = t + 3731
        self.assertTrue(self.after.gate("m1", None)["open"])

        self.clock.now = t
        self.assertEqual(self.after.gate("m2", t), {"open": False, "reason": "showing", "send_at": t + 30})
        self.clock.now = t + 29
        self.assertEqual(self.after.gate("m2", t)["reason"], "showing")
        self.clock.now = t + 30
        self.assertTrue(self.after.gate("m2", t)["open"])

    def test_change_after_send_now_pauses_again(self):
        self.after.send_now("m1")
        self.clock.now += 5
        self.after.edit("m1", "next_steps", "Send the proposal on Friday.")
        gate = self.after.gate("m1", None)
        self.assertEqual((gate["open"], gate["reason"]), (False, "changes"))

    def test_edit_rules(self):
        self.after.edit("m1", "summary", "a" * 5000)
        self.assertEqual(len(self.after.read("m1")["summary"]), 4000)
        self.assertEqual(self.after.edit("m1", "summary", "   "), self.clock.now + 30)
        state = self.after.read("m1")
        self.assertIsNone(state["summary"])
        self.assertEqual(state["changed_at"], self.clock.now)
        with self.assertRaisesRegex(ValueError, "bad_field"):
            self.after.edit("m1", "title", "x")

    def test_remove_keys(self):
        self.assertEqual(self.after.remove("m1", "journal:6f1c-a", True), self.clock.now + 30)
        self.assertEqual(self.after.read("m1")["removed"], ["journal:6f1c-a"])
        for key in ("journal:../x", "other:1", "journal:", "memo:" + "a" * 81):
            with self.assertRaisesRegex(ValueError, "^bad_key$"):
                self.after.remove("m1", key, True)
        self.after.remove("m1", "journal:6f1c-a", True)
        self.after.remove("m1", "journal:6f1c-a", False)
        self.assertEqual(self.after.read("m1")["removed"], [])

    def test_remove_limit(self):
        for index in range(500):
            self.after.remove("m1", f"fact:{index}", True)
        self.after.remove("m1", "fact:0", True)  # already removed: no new key
        with self.assertRaisesRegex(ValueError, "^too_many$"):
            self.after.remove("m1", "fact:500", True)
        self.assertEqual(len(self.after.read("m1")["removed"]), 500)

    def test_choices_survive_reload(self):
        self.after.hold("m1")
        self.after.edit("m1", "next_steps", "Обзор пилота в марте.")
        again = AfterState(self.root, clock=self.clock)
        state = again.read("m1")
        self.assertTrue(state["held"])
        self.assertEqual(state["next_steps"], "Обзор пилота в марте.")
        self.assertEqual(again.gate("m1", None)["reason"], "held")
        path = self.root / "m1" / "after.json"
        if os.name != "nt":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_identity_is_made_safe(self):
        self.after.hold("../meetings/2026 Обзор")
        self.assertEqual([p.parent.parent for p in self.root.rglob("after.json")], [self.root])

    def test_resent(self):
        self.after.resent("m1")
        self.assertEqual(self.after.read("m1")["resent_at"], self.clock.now)

    def test_due_returns_opened_once(self):
        t = self.clock.now
        self.after.blocked("m1", t)
        self.clock.now = t + 10
        self.assertEqual(self.after.due(), set())
        self.clock.now = t + 31
        self.assertEqual(self.after.due(), {"m1"})
        self.assertEqual(self.after.due(), set())

    def test_due_keeps_held(self):
        self.after.hold("m1")
        self.after.blocked("m1", None)
        self.clock.now += 3600
        self.assertEqual(self.after.due(), set())
        self.after.send_now("m1")
        self.assertEqual(self.after.due(), {"m1"})

    def test_hold_during_a_send_is_refused(self):
        """The gate check and the sending mark are one step: a Hold after it answers "sending" (final I1)."""
        taken = self.after.begin_send("m1", None)
        self.assertEqual(taken, self.clock.now)
        with self.assertRaises(ValueError) as caught:
            self.after.hold("m1")
        self.assertEqual(str(caught.exception), "sending")
        self.assertFalse(self.after.read("m1")["held"])
        self.after.end_send("m1")
        self.after.hold("m1")
        self.assertTrue(self.after.read("m1")["held"])
        self.assertIsNone(self.after.begin_send("m1", None), "a held report is not taken")

    def test_older_send_now_never_undoes_a_later_hold(self):
        """Commands apply in the order they arrived, not the order they got through (Codex P1)."""
        send_now, hold = self.after.ticket(), self.after.ticket()
        self.after.hold("m1", hold)
        self.after.send_now("m1", send_now)  # queued behind the archive lock
        self.assertTrue(self.after.read("m1")["held"])
        self.after.send_now("m1", self.after.ticket())
        self.assertFalse(self.after.read("m1")["held"])

    def test_editing_closes_the_gate_before_the_text_is_saved(self):
        self.after.touch("m1")
        self.assertEqual(self.after.gate("m1", None)["reason"], "changes")
        self.assertIsNone(self.after.read("m1")["summary"])

    def test_delivered_keeps_the_first_revision(self):
        self.after.delivered("m1", 10.5)
        self.after.delivered("m1", 20.0)
        self.assertEqual(self.after.read("m1")["delivered_at"], 10.5)


if __name__ == "__main__":
    unittest.main()
