import json
import subprocess
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from calendar_meetings import CalendarMeetings
from memo_writer import MemoWriter, company_from, file_digest, is_external, one_line, outside_attendees


def person(email, name="", self_=False, resource=False):
    return {"email": email, "name": name, "self": self_, "resource": resource}


class DetectionTests(unittest.TestCase):
    def test_outside_domain_is_external(self):
        anna = person("anna@example.com", "Anna Petrova")
        attendees = [person("me@example.org", self_=True), anna]
        self.assertTrue(is_external(attendees))
        self.assertEqual(outside_attendees(attendees), [anna])

    def test_same_domain_and_subdomain_are_internal(self):
        self.assertFalse(is_external([person("me@example.org", self_=True), person("bob@mail.example.org")]))
        self.assertFalse(is_external([person("me@example.org", self_=True), person("Bob@Example.org")]))
        # A look-alike domain is not a subdomain.
        self.assertTrue(is_external([person("me@example.org", self_=True), person("eve@badexample.org")]))

    def test_solo_event_is_internal(self):
        self.assertFalse(is_external([]))
        self.assertFalse(is_external([person("me@example.org", self_=True)]))

    def test_public_domain_user_counts_everyone_outside(self):
        self.assertTrue(is_external([person("me@gmail.com", self_=True), person("friend@gmail.com")]))
        self.assertEqual(company_from("friend@gmail.com"), "")

    def test_no_self_attendee_counts_everyone_outside(self):
        self.assertTrue(is_external([person("anna@example.com", "Anna Petrova")]))

    def test_rooms_and_groups_are_not_outside(self):
        attendees = [person("me@example.org", self_=True), person("c_1@resource.calendar.google.com", resource=True),
                     person("team@group.calendar.google.com")]
        self.assertFalse(is_external(attendees))
        self.assertEqual(outside_attendees(attendees), [])

    def test_company_from_domain(self):
        self.assertEqual(company_from("anna@example-llc.com"), "example-llc")
        self.assertEqual(company_from("anna@sales.example.co.uk"), "example")
        self.assertEqual(company_from("a@mail.hp.com"), "hp")
        self.assertEqual(company_from(""), "")
        self.assertEqual(company_from("not-an-email"), "")

    def test_calendar_event_carries_id_and_resource(self):
        payload = {"items": [
            {"id": "ev1", "summary": "Pilot review",
             "start": {"dateTime": "2026-09-29T10:00:00+02:00"}, "end": {"dateTime": "2026-09-29T10:30:00+02:00"},
             "attendees": [{"email": "me@example.org", "self": True},
                           {"email": "c_1@resource.calendar.google.com", "resource": True}]},
            {"summary": "No id", "start": {"dateTime": "2026-09-29T11:00:00+02:00"},
             "end": {"dateTime": "2026-09-29T11:30:00+02:00"}},
            {"id": "x" * 2000, "summary": "Long id", "start": {"dateTime": "2026-09-29T12:00:00+02:00"},
             "end": {"dateTime": "2026-09-29T12:30:00+02:00"}},
        ]}
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")
        with patch("calendar_meetings.subprocess.run", return_value=done) as run:
            events = CalendarMeetings("/fake/gws").for_day(date(2026, 9, 29))
        self.assertIn("items(id,", json.loads(run.call_args.args[0][-1])["fields"])
        self.assertIn("resource)", json.loads(run.call_args.args[0][-1])["fields"])
        self.assertEqual([e["id"] for e in events], ["ev1", "", "x" * 1024])
        self.assertEqual([a["resource"] for a in events[0]["attendees"]], [False, True])


class FakeAI:
    pass


NOW = datetime.now().astimezone()
START = (NOW + timedelta(hours=3)).isoformat(timespec="seconds")
MEMO_KEYS = {"state", "goal", "questions", "background", "source_count",
             "plan_id", "written_by", "since", "reason", "retry_at"}
APP_PLAN = {"id": "app-0123456789abcdef", "event_id": "ev1", "written_by": "app", "starts_at": START,
            "title": "Pilot review", "intro": "Agree the pilot scope.", "meeting_link": "",
            "attendee_aliases": ["Anna Petrova"], "title_aliases": ["Pilot review"], "source_label": "MeetOnTrack",
            "items": [{"id": "q1", "kind": "question", "text": "Who signs off?"}],
            "memo_markdown": "# Pilot review\nAgree the pilot scope."}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "memos.json"
        self.writer = MemoWriter(self.path, FakeAI(), lambda m: [], lambda: "en")

    def tearDown(self):
        self.temp.cleanup()

    def _stored(self, events):
        self.path.write_text(json.dumps({"version": 1, "events": events}), encoding="utf-8")
        return MemoWriter(self.path, FakeAI(), lambda m: [], lambda: "en")

    def test_crash_between_write_and_rename_keeps_previous_file(self):
        self.writer._update("ev1", state="nothing_found", start=START)
        before = self.path.read_bytes()
        with patch("pathlib.Path.replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                self.writer._update("ev1", state="failed", reason="error")
            with self.assertRaises(OSError):
                self.writer._update("ev2", state="failed", reason="error")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.writer.events["ev1"]["state"], "nothing_found")
        self.assertNotIn("ev2", self.writer.events)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(before)["events"]["ev1"]["state"], "nothing_found")

    def test_preparing_on_disk_becomes_retryable_failure(self):
        writer = self._stored({"ev1": {"state": "preparing", "start": START, "since": START, "attempts": 0}})
        e = writer.events["ev1"]
        self.assertEqual((e["state"], e["reason"], e["attempts"]), ("failed", "error", 1))
        self.assertIsNotNone(e["retry_at"])
        # The retry was cut short by a restart again: no further automatic retry.
        writer = self._stored({"ev1": {"state": "preparing", "start": START, "since": START, "attempts": 1}})
        e = writer.events["ev1"]
        self.assertEqual((e["state"], e["reason"], e["attempts"], e["retry_at"]), ("failed", "error", 2, None))

    def test_old_entries_are_pruned(self):
        old = (NOW - timedelta(days=3)).isoformat(timespec="seconds")
        recent = (NOW - timedelta(days=1)).isoformat(timespec="seconds")
        writer = self._stored({"old": {"state": "nothing_found", "start": old},
                               "recent": {"state": "nothing_found", "start": recent}})
        writer._update("ev1", state="nothing_found", start=START)
        self.assertEqual(set(writer.events), {"recent", "ev1"})
        self.assertEqual(set(json.loads(self.path.read_text())["events"]), {"recent", "ev1"})
        writer._update("stale", state="nothing_found", start=old)
        self.assertNotIn("stale", writer.events)

    def test_new_entry_carries_every_stored_field(self):
        self.writer._update("ev1", state="nothing_found", start=START)
        self.assertEqual(set(self.writer.events["ev1"]), {
            "state", "start", "since", "reason", "retry_at", "attempts", "rebuild", "rechecked", "signature",
            "language", "provider", "model", "written_at", "digest", "plan"})

    def test_plans_are_those_of_ready_entries(self):
        self.writer._update("ev1", state="ready", start=START, plan=APP_PLAN)
        self.writer._update("ev2", state="failed", start=START, reason="error",
                            plan={**APP_PLAN, "id": "app-old", "event_id": "ev2"})
        self.assertEqual(self.writer.plans(), [APP_PLAN])

    def test_file_digest_from_goal_and_question_items(self):
        plan = {"intro": "Agree the pilot scope.\nmore", "memo_markdown": "# Pilot review\nFirst line.",
                "items": [{"id": "r1", "kind": "risk", "text": "R"}] + [
                    {"id": f"q{i}", "kind": "question", "text": f"Q{i}?"} for i in range(5)]}
        self.assertEqual(file_digest(plan), {"goal": "Agree the pilot scope.", "questions": ["Q0?", "Q1?", "Q2?"],
                                             "background": "", "source_count": 1})
        self.assertEqual(file_digest({"memo_markdown": "# T\n\n**Bold** first line.", "items": []})["goal"],
                         "Bold first line.")
        long = file_digest({"intro": "word " * 60, "items": []})["goal"]
        self.assertLessEqual(len(long), 160)
        self.assertTrue(long.endswith("word"))
        self.assertEqual(one_line("abc defghi jkl", 10), "abc defghi")  # a space exactly at the limit
        self.assertEqual(one_line("abc defghij kl", 10), "abc")

    def test_memo_for_each_state(self):
        meeting = {"event_id": "ev1", "external": True, "start": START, "title": "Pilot review"}
        since = NOW.isoformat(timespec="seconds")
        retry = (NOW + timedelta(minutes=20)).isoformat(timespec="seconds")
        file_plan = {"id": "repo-0123", "intro": "Agree the pilot scope.",
                     "items": [{"id": "q1", "kind": "question", "text": "Who signs off?"}]}

        def memo(event_id="ev1", hits=(), now=None, **changes):
            result = self.writer.memo_for({**meeting, "event_id": event_id, **changes}, list(hits), now)
            self.assertEqual(set(result), MEMO_KEYS)
            return result

        with self.subTest("internal"):
            result = memo(external=False)
            self.assertEqual((result["state"], result["plan_id"], result["written_by"]), ("none", "", "app"))
        with self.subTest("external, no entry"):
            result = memo()
            self.assertEqual((result["state"], result["since"]), ("preparing", None))
        with self.subTest("external, no entry, already started"):
            self.assertEqual(memo(now=NOW + timedelta(hours=4))["state"], "none")
        with self.subTest("preparing"):
            self.writer._update("ev1", state="preparing", start=START, since=since)
            result = memo()
            self.assertEqual((result["state"], result["since"]), ("preparing", since))
        with self.subTest("nothing_found"):
            self.writer._update("ev1", state="nothing_found", since=None)
            result = memo()
            self.assertEqual((result["state"], result["source_count"], result["goal"]), ("nothing_found", 0, ""))
        with self.subTest("failed"):
            self.writer._update("ev1", state="failed", reason="ai_needs_choice", retry_at=retry,
                                digest={"goal": "Old goal", "questions": [], "background": "", "source_count": 2})
            result = memo()
            self.assertEqual((result["state"], result["reason"], result["retry_at"], result["goal"]),
                             ("failed", "ai_needs_choice", retry, ""))
        with self.subTest("ready"):
            digest = {"goal": "Agree the pilot scope", "questions": ["Q1?", "Q2?"],
                      "background": "Met once before.", "source_count": 3}
            self.writer._update("ev1", state="ready", reason="", retry_at=None, digest=digest, plan=APP_PLAN)
            self.assertEqual(memo(hits=[APP_PLAN]), {
                "state": "ready", **digest, "plan_id": APP_PLAN["id"], "written_by": "app",
                "since": None, "reason": "", "retry_at": None})
        with self.subTest("file hit"):
            result = memo(hits=[file_plan])
            self.assertEqual((result["state"], result["written_by"], result["plan_id"]),
                             ("ready", "file", "repo-0123"))
            self.assertEqual({k: result[k] for k in ("goal", "questions", "background", "source_count")},
                             file_digest(file_plan))
        with self.subTest("no event id, no file hit"):
            self.assertEqual(memo(event_id="")["state"], "none")


if __name__ == "__main__":
    unittest.main()
