import json
import subprocess
import tempfile
import threading
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from calendar_meetings import CalendarMeetings
from memo_writer import (MemoWriter, company_from, file_digest, folder_sources, is_external, one_line,
                         outside_attendees, past_reports, search_words, source_signature)


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


    def test_corrupt_store_loads_empty_and_bad_entries_are_dropped(self):
        self.path.write_text("[1, 2]", encoding="utf-8")
        self.assertEqual(MemoWriter(self.path, FakeAI(), lambda m: [], lambda: "en").events, {})
        self.path.write_text("{not json", encoding="utf-8")
        self.assertEqual(MemoWriter(self.path, FakeAI(), lambda m: [], lambda: "en").events, {})
        writer = self._stored({"ok": {"state": "preparing", "start": START, "attempts": 0},
                               "text": "not an entry", "bad": {"state": "preparing", "attempts": "many"},
                               "list": {"state": "failed", "attempts": [1]},
                               "huge": {"state": "preparing", "attempts": 10 ** 400},
                               "nan": {"state": "preparing", "attempts": float("nan")}})
        self.assertEqual(list(writer.events), ["ok"])
        self.assertEqual(writer.events["ok"]["state"], "failed")


MEETING_ATTENDEES = [person("me@example.org", self_=True), person("anna@example-llc.com", "Anna Petrova")]
WORDS = {"names": ["Anna Petrova"], "emails": ["anna@example-llc.com"], "company": "example-llc",
         "title": ["pilot", "example"]}
BEFORE = datetime.fromisoformat("2026-11-25T10:00:00+01:00")


class FakeArchive:
    def __init__(self, root, points):
        self.archive_root, self.points, self.details = root, points, []

    def detail(self, meeting_id):
        self.details.append(meeting_id)
        return {"overview": {"points": self.points.get(meeting_id, [])}}


def archived(root, meeting_id, title, started_at, participants=None):
    folder = root / meeting_id
    folder.mkdir(parents=True)
    (folder / "meeting.json").write_text(json.dumps({"meeting": title, "started_at": started_at}), encoding="utf-8")
    if participants is not None:
        (folder / "participants.json").write_text(
            json.dumps({"participants": [{"name": name} for name in participants]}), encoding="utf-8")


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_search_words_come_from_the_event(self):
        words = search_words({"title": "Pilot review with Example LLC", "attendees": MEETING_ATTENDEES})
        self.assertEqual(words, WORDS)
        self.assertEqual(search_words({"title": "Weekly sync call", "attendees": []}),
                         {"names": [], "emails": [], "company": "", "title": []})

    def test_folder_hits_need_a_strong_word(self):
        hits = [{"path": "/f/a.md", "line": 3, "text": "Pilot notes for Anna Petrova"},
                {"path": "/f/b.md", "line": 9, "text": "pilot of something else"},
                {"path": "/f/c.md", "line": 1, "text": "Example LLC signed the pilot"}]
        sources = folder_sources(hits, WORDS)
        self.assertEqual([s["label"] for s in sources], ["/f/a.md:3", "/f/c.md:1"])
        self.assertEqual(sources[0], {"kind": "folder", "label": "/f/a.md:3", "text": "Pilot notes for Anna Petrova"})
        # An event with neither a name nor a company keeps every hit, up to the limit.
        loose = {**WORDS, "names": [], "company": ""}
        self.assertEqual(len(folder_sources(hits * 3, loose)), 4)

    def test_folder_names_match_whole_words(self):
        words = {**WORDS, "names": ["Anna Petrova", "Max Li"]}
        hits = [{"path": "/f/a.md", "line": 1, "text": "Savannah annual pilot"},
                {"path": "/f/b.md", "line": 2, "text": "maximum pilot budget"},
                {"path": "/f/c.md", "line": 3, "text": "Max approved the pilot"}]
        self.assertEqual([s["label"] for s in folder_sources(hits, words)], ["/f/c.md:3"])

    def test_past_reports_by_title_when_the_event_has_no_names(self):
        archived(self.root, "m1", "Pilot review Example", "2026-11-20T09:00:00+01:00", ["Someone Else"])
        archive = FakeArchive(self.root, {"m1": ["Agreed the scope"]})
        self.assertEqual([s["text"] for s in past_reports(archive, {**WORDS, "names": []}, BEFORE)],
                         ["Agreed the scope"])

    def test_past_reports_by_participants_then_title(self):
        archived(self.root, "m1", "m1-title catch-up", "2026-11-20T09:00:00+01:00", ["Anna  Petrova"])
        archived(self.root, "m2", "m2-title Pilot review Example", "2026-11-10T09:00:00Z")
        archived(self.root, "m3", "m3-title Weekly review", "2026-11-18T09:00:00+01:00")
        archived(self.root, "m4", "m4-title Pilot review Example", "2026-11-25T10:00:00+01:00", ["Anna Petrova"])
        archived(self.root, "m5", "m5-title Pilot Example", "2026-11-19T09:00:00+01:00", ["Someone Else"])
        archive = FakeArchive(self.root, {key: ["Point one", "Point two", "Point three", "Point four"]
                                          for key in ("m1", "m2", "m3", "m4", "m5")})
        sources = past_reports(archive, WORDS, BEFORE)
        self.assertEqual([s["label"].split(" ")[0] for s in sources], ["m1-title", "m2-title"])
        self.assertEqual(sources[1], {"kind": "report", "label": "m2-title Pilot review Example 2026-11-10",
                                      "text": "Point one; Point two; Point three"})
        self.assertNotIn("m4", archive.details)  # at or after the meeting: never read

    def test_title_match_needs_two_words(self):
        archived(self.root, "m1", "Pilot", "2026-11-20T09:00:00+01:00")
        archived(self.root, "m2", "Kickoff example-llc", "2026-11-19T09:00:00+01:00")
        archive = FakeArchive(self.root, {"m1": ["Point"], "m2": ["Point"]})
        self.assertEqual([s["label"] for s in past_reports(archive, WORDS, BEFORE)],
                         ["Kickoff example-llc 2026-11-19"])  # the company word alone is enough
        self.assertEqual(len(past_reports(archive, WORDS, datetime(2026, 11, 25))), 1)  # an all-day event's start

    def test_report_without_points_is_skipped(self):
        archived(self.root, "m1", "Pilot review Example", "2026-11-20T09:00:00+01:00")
        archived(self.root, "m2", "Pilot review Example", "2026-11-19T09:00:00+01:00")
        archive = FakeArchive(self.root, {"m2": ["Agreed the scope"]})
        self.assertEqual([s["text"] for s in past_reports(archive, WORDS, BEFORE)], ["Agreed the scope"])

    def test_signature_is_order_free_and_changes_with_text_or_language(self):
        a, b = {"kind": "crm", "label": "CRM person", "text": "x"}, {"kind": "folder", "label": "/f:1", "text": "y"}
        self.assertRegex(source_signature([a, b], "en"), r"^[0-9a-f]{16}$")
        self.assertEqual(source_signature([a, b], "en"), source_signature([b, a], "en"))
        self.assertNotEqual(source_signature([a, b], "en"), source_signature([a, {**b, "text": "z"}], "en"))
        self.assertNotEqual(source_signature([a, b], "en"), source_signature([a, b], "ru"))


class FakeGoogle:
    def __init__(self, items, account="me@example.org", change=False, on_search=lambda: None):
        self._lock, self._generation = threading.RLock(), 0
        self.items, self.account, self.change, self.on_search, self.queries = items, account, change, on_search, []

    def enabled_sources(self):
        return ["calendar", "gmail", "drive"]

    def status(self):
        return {"auth": "connected", "account": self.account}

    def _preferences(self):
        return {"account": "me@example.org"}

    def _search_source(self, source, query):
        self.queries.append((source, query))
        self.on_search()
        if self.change:
            self._generation += 1
        return {"state": "ok", "items": self.items}


MEETING = {"start": "2026-11-25T10:00:00+01:00", "end": "2026-11-25T10:30:00+01:00",
           "title": "Pilot review with Example LLC", "link": "", "attendees": MEETING_ATTENDEES,
           "event_id": "ev1", "external": True}
ANNA_CRM = {"type": "person", "name": "Anna Petrova"}


class MemoSourcesTests(unittest.TestCase):
    def setUp(self):
        import server
        from types import SimpleNamespace
        self.server, self.ns = server, SimpleNamespace
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        archived(self.root, "m1", "Pilot review Example", "2026-11-20T09:00:00+01:00")
        self.archive = FakeArchive(self.root, {"m1": ["Agreed the scope"]})
        self.searches = []
        self.twenty = self.ns(_lock=threading.RLock(), _generation=0)

    def gather(self, google, folder=lambda: "same", crm=(ANNA_CRM,), on_records=lambda: None):
        local = self.ns(generation=folder, search=lambda query: self.searches.append(query) or {"items": [
            {"path": "/f/a.md", "line": 3, "text": "Notes on Anna Petrova"}]})
        self.twenty.records = lambda attendees, title="": on_records() or list(crm)
        with patch.object(self.server, "LOCAL_CONTEXT", local), patch.object(self.server, "GOOGLE_CONTEXT", google), \
                patch.object(self.server, "TWENTY_CONTEXT", self.twenty), \
                patch.object(self.server, "ARCHIVE", self.archive):
            return self.server.memo_sources(MEETING)

    def test_sources_dropped_when_access_changes_mid_gather(self):
        history = [{"title": "Intro call", "date": "2026-11-01T10:00:00+01:00", "excerpt": "First talk"}]
        google = FakeGoogle(history, change=True)
        folders = iter(["before", "after"])
        sources = self.gather(google, folder=lambda: next(folders))
        self.assertEqual([s["kind"] for s in sources], ["crm", "report"])
        self.assertEqual({q[0] for q in google.queries}, {"calendar"})  # never Gmail or Drive
        # A folder removed during the CRM read, the CRM key changed during the calendar read.
        state = {"folder": "before"}
        def crm_changes():
            self.twenty._generation += 1
        google = FakeGoogle(history, on_search=crm_changes)
        sources = self.gather(google, folder=lambda: state["folder"], on_records=lambda: state.update(folder="after"))
        self.assertEqual([s["kind"] for s in sources], ["calendar", "report"])

    def test_calendar_history_keeps_only_events_before_the_meeting(self):
        google = FakeGoogle([{"title": "Intro call", "date": "2026-11-01T10:00:00+01:00", "excerpt": "First talk"},
                             {"title": "Pilot review", "date": "2026-11-25T10:00:00+01:00", "excerpt": "This one"},
                             {"title": "Other zone", "date": "2026-11-25T09:30:00+00:00", "excerpt": "After, in UTC"},
                             {"title": "Undated", "date": "soon", "excerpt": "?"},
                             {"title": "Kickoff", "date": "2026-10-20", "excerpt": ""},
                             {"title": "Follow-up", "date": "2026-12-02T10:00:00+01:00", "excerpt": "Later"},
                             {"title": "Prep", "date": "2026-11-25T09:30:00+01:00", "excerpt": "Just before"}])
        crm = [{"type": "person", "name": f"Person {n}"} for n in range(5)]
        sources = self.gather(google, crm=crm)
        self.assertEqual(sources, [
            {"kind": "folder", "label": "/f/a.md:3", "text": "Notes on Anna Petrova"},
            *({"kind": "crm", "label": f"CRM person: Person {n}", "text": json.dumps(crm[n])} for n in range(3)),
            {"kind": "calendar", "label": "Intro call 2026-11-01", "text": "First talk"},
            {"kind": "calendar", "label": "Kickoff 2026-10-20", "text": ""},
            {"kind": "calendar", "label": "Prep 2026-11-25", "text": "Just before"},
            {"kind": "report", "label": "Pilot review Example 2026-11-20", "text": "Agreed the scope"}])
        self.assertEqual(google.queries, [("calendar", "anna@example-llc.com")])
        self.assertEqual(self.searches, ["Anna Petrova example-llc pilot example"])

    def test_calendar_is_not_read_for_another_account(self):
        google = FakeGoogle([{"title": "Intro call", "date": "2026-11-01", "excerpt": "x"}], account="b@example.com")
        self.assertNotIn("calendar", [s["kind"] for s in self.gather(google)])
        self.assertEqual(google.queries, [])


if __name__ == "__main__":
    unittest.main()
