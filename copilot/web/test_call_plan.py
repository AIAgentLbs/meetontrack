import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from call_plan import CallPlans
from repo_preparations import RepositoryPreparations

APP_PLAN_FOR_EV1 = {
    "id": "app-0123456789abcdef", "event_id": "ev1", "written_by": "app",
    "starts_at": "2026-09-29T10:00:00+02:00", "title": "Pilot review", "intro": "Agree the pilot scope.",
    "meeting_link": "", "attendee_aliases": ["Anna Petrova"], "title_aliases": ["Pilot review"],
    "source_label": "MeetOnTrack", "items": [{"id": "q1", "kind": "question", "text": "Who signs off?"}],
    "memo_markdown": "# Pilot review\nAgree the pilot scope.",
}
NOW = datetime.fromisoformat("2026-09-29T09:00:00+02:00")
EXTERNAL = [{"email": "me@example.org", "self": True}, {"email": "anna@example-llc.com", "name": "Anna Petrova"}]


def calendar_of(events_by_day):
    class FakeCalendar:
        def available(self):
            return True

        def for_day(self, day):
            return [dict(event) for event in events_by_day.get(str(day), [])]

    return FakeCalendar()


def event(event_id, title, at):
    hour, minute = map(int, at.split(":"))
    return {"id": event_id, "title": title, "start": f"2026-09-29T{at}:00+02:00",
            "end": f"2026-09-29T{hour:02d}:{minute + 30:02d}:00+02:00", "link": "", "attendees": EXTERNAL}


class CallPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "preparations.json"
        self.state = self.root / "call-plans-state.json"
        self.config.write_text(json.dumps({"version": 1, "plans": [{
            "id": "sample-2026-09-29", "starts_at": "2026-09-29T10:00:00+02:00",
            "attendee_aliases": ["Alex Sample"], "title_aliases": ["documents demo"],
            "title": "Sample preparation", "intro": "Prepare the demo.",
            "links": [{"label": "Brief", "url": "https://example.com/brief"},
                      {"label": "Unsafe", "url": "file:///private/brief"}],
            "items": [{"id": "q1", "kind": "question", "text": "What format do you use?"},
                      {"id": "r1", "kind": "risk", "text": "Is access approved?"}],
        }]}), encoding="utf-8")
        self.plan = CallPlans(self.config, self.state)
        self.meeting = {
            "meeting_id": "meeting-a", "meeting": "Generic video call",
            "started_at": "2026-09-29T08:04:00Z",
            "remote_attendees": ["Alex Sample"],
            "segments": [{"text": "We use PDF scans for our current document intake.", "provisional": False}],
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_calendar_match_and_private_links(self):
        result = self.plan.snapshot(self.meeting)
        self.assertEqual(result["id"], "sample-2026-09-29")
        self.assertEqual(len(result["links"]), 1)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

    def test_other_meeting_does_not_inherit_plan(self):
        other = {**self.meeting, "meeting_id": "meeting-b", "remote_attendees": ["Another Person"]}
        self.assertIsNone(self.plan.snapshot(other))
        later = {**self.meeting, "meeting_id": "meeting-c", "started_at": "2026-09-30T08:04:00Z"}
        self.assertIsNone(self.plan.snapshot(later))

    def test_explicit_new_logical_meeting_does_not_reuse_old_preparation(self):
        self.plan.snapshot(self.meeting)
        new = {**self.meeting, "meeting_id": "new-part", "physical_meeting_id": "meeting-a", "explicit_boundary": True}
        self.assertIsNone(self.plan.snapshot(new))

    def test_generic_capture_title_uses_tentative_near_time_only(self):
        generic = {**self.meeting, "meeting_id": "generic", "meeting": "Google Chrome Helper", "remote_attendees": []}
        self.assertEqual(self.plan.snapshot(generic)["match"], "time-only")
        outside = {**generic, "meeting_id": "later", "started_at": "2026-09-29T08:20:00Z"}
        self.assertIsNone(self.plan.snapshot(outside))

    def test_explicit_evidence_updates_only_current_meeting(self):
        answer = 'PLAN_UPDATE: {"id":"q1","status":"resolved","evidence":"We use PDF scans for our current document intake"}'
        self.assertEqual(self.plan.apply_analysis(self.meeting, answer), 1)
        self.assertEqual(self.plan.snapshot(self.meeting)["items"][0]["status"], "resolved")
        self.assertEqual(self.plan.snapshot(self.meeting)["score"], {
            "resolved": 1, "clarify": 0, "total": 2, "percent": 50,
            "by_kind": {
                "question": {"resolved": 1, "clarify": 0, "total": 1},
                "risk": {"resolved": 0, "clarify": 0, "total": 1},
                "objection": {"resolved": 0, "clarify": 0, "total": 0},
            },
        })
        other = {**self.meeting, "meeting_id": "meeting-b", "remote_attendees": ["Another Person"]}
        self.assertIsNone(self.plan.snapshot(other))
        self.assertEqual(self.plan.apply_analysis(self.meeting, 'PLAN_UPDATE: {"id":"r1","status":"resolved","evidence":"not in captured speech"}'), 0)
        self.assertEqual(self.plan.snapshot(self.meeting)["items"][1]["status"], "open")

    def test_manual_override_is_persistent_and_wins(self):
        self.plan.manual_status(self.meeting, "q1", "clarify")
        fresh = CallPlans(self.config, self.state)
        self.assertEqual(fresh.snapshot(self.meeting)["items"][0]["status"], "clarify")
        answer = 'PLAN_UPDATE: {"id":"q1","status":"resolved","evidence":"We use PDF scans for our current document intake"}'
        self.assertEqual(fresh.apply_analysis(self.meeting, answer), 0)
        self.assertEqual(fresh.snapshot(self.meeting)["items"][0]["status"], "clarify")

    def test_invalid_config_does_not_crash(self):
        self.config.write_text('{"version":1,"plans":[{"id":"bad","starts_at":"2026-09-29T10:00:00+02:00","items":[{"id":{},"kind":"question","text":"Hi"}]}]}')
        self.assertIsNone(self.plan.snapshot(self.meeting))

    def test_discover_existing_repository_preparation(self):
        repo = self.root / "selected-repo"
        repo.mkdir()
        source = repo / "PREP.md"
        source.write_text("""---
call_date: 2026-09-29
---
# Sales kit: Acme / Alex Sample

[Brief](https://example.com/brief)

## Мемо перед встречей
**Цель встречи.** Уточнить процесс и следующий шаг.

## Опросник
### Обязательные вопросы
1. Как устроена обработка одного документа?
2. Кто проверяет результат?

## Ответы на вопросы и возражения
**«У нас уже есть Excel».**

## Проверка перед встречей
- [ ] Разрешён внешний показ образцов.
""", encoding="utf-8")
        active = self.root / "active-repos.json"
        active.write_text(json.dumps({"repositories": [{"name": "sales", "path": str(repo)}]}), encoding="utf-8")
        found = RepositoryPreparations(active).for_date("2026-09-29")
        self.assertEqual(len(found), 1)
        self.assertEqual([item["kind"] for item in found[0]["items"]], [
            "question", "question", "risk", "objection",
        ])
        self.assertEqual(found[0]["links"][0]["url"], "https://example.com/brief")
        discovered = CallPlans(self.root / "absent.json", self.root / "discovered-state.json", active)
        self.assertEqual(discovered.snapshot(self.meeting)["source_label"], "sales/PREP.md")
        self.assertEqual(discovered.snapshot(self.meeting)["score"]["total"], 4)
        other = {**self.meeting, "meeting_id": "unrelated", "remote_attendees": [], "meeting": "Another call"}
        self.assertIsNone(discovered.snapshot(other))

    def test_configured_call_reads_current_repository_file(self):
        repo = self.root / "selected-repo"
        repo.mkdir()
        source = repo / "PREP.md"
        source.write_text("---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n## Опросник\n1. Первый вопрос?\n", encoding="utf-8")
        active = self.root / "active-repos.json"
        active.write_text(json.dumps({"repositories": [{"name": "sales", "path": str(repo)}]}), encoding="utf-8")
        self.config.write_text(json.dumps({"version": 1, "plans": [{
            "id": "sample-2026-09-29", "starts_at": "2026-09-29T10:00:00+02:00",
            "attendee_aliases": ["Alex Sample"], "title_aliases": ["Acme"],
            "source_file": str(source),
            "items": [{"id": "manual-risk", "kind": "risk", "text": "Проверить доступ."}],
        }]}), encoding="utf-8")
        plans = CallPlans(self.config, self.state, active)
        first = plans.snapshot(self.meeting)
        self.assertEqual(first["score"]["total"], 2)
        self.assertIn("Первый вопрос", first["items"][0]["text"])
        source.write_text("---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n## Опросник\n1. Обновлённый вопрос?\n", encoding="utf-8")
        second = plans.snapshot(self.meeting)
        self.assertIn("Обновлённый вопрос", second["items"][0]["text"])

    def test_calendar_matches_repository_preparation_when_capture_title_is_generic(self):
        repo = self.root / "selected-repo"
        repo.mkdir()
        (repo / "PREP.md").write_text(
            "---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n"
            "## Опросник\n1. Кто проверяет документы?\n", encoding="utf-8",
        )
        active = self.root / "active-repos.json"
        active.write_text(json.dumps({"repositories": [{"name": "sales", "path": str(repo)}]}), encoding="utf-8")

        class FakeCalendar:
            def for_day(self, day):
                return [{"title": "Demo documents — Acme / Alex Sample",
                         "start": "2026-09-29T10:00:00+02:00",
                         "end": "2026-09-29T10:30:00+02:00", "link": ""}]

        plans = CallPlans(self.root / "absent.json", self.state, active, FakeCalendar())
        generic = {**self.meeting, "meeting_id": "calendar-match", "meeting": "Google Chrome Helper",
                   "remote_attendees": [], "started_at": "2026-09-29T08:18:00Z"}
        matched = plans.snapshot(generic)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["match"], "calendar")
        self.assertEqual(matched["source_label"], "sales/PREP.md")
        unrelated = {**generic, "meeting_id": "unrelated", "started_at": "2026-09-29T09:20:00Z"}
        self.assertIsNone(plans.snapshot(unrelated))

    def _repo(self, files):
        repo = self.root / "selected-repo"
        (repo / "consultations").mkdir(parents=True)
        for name, text in files.items():
            (repo / name).write_text(text, encoding="utf-8")
        active = self.root / "active-repos.json"
        active.write_text(json.dumps({"repositories": [{"name": "sales", "path": str(repo)}]}), encoding="utf-8")
        return active

    def test_consultation_prep_file_with_plain_date_is_a_plan_with_full_memo(self):
        active = self._repo({
            "consultations/2026-09-29-sample-prep.md": (
                "---\ndate: 2026-09-29\nclient: Sample Co\n---\n# Prep-мемо: Sprint request (Sample Co)\n\n"
                "[Мемо PDF](https://drive.example.com/memo)\n\n## 1. Кто они\nSample context line.\n\n"
                "## 4. Вопросы на звонке\n1. What is the main goal?\n"),
            # Name dated only, no frontmatter: still a prep file.
            "consultations/2026-09-29-other-prep.md": "# Prep-мемо: Other request\n## 1. Кто они\nText.\n",
            # A plain note with `date:` is not a plan.
            "consultations/2026-09-29-notes.md": "---\ndate: 2026-09-29\n---\n# Notes\n## Questions\n1. Why?\n",
        })
        found = {plan["source_label"]: plan for plan in RepositoryPreparations(active).for_date("2026-09-29")}
        self.assertEqual(set(found), {"sales/2026-09-29-sample-prep.md", "sales/2026-09-29-other-prep.md"})
        plan = found["sales/2026-09-29-sample-prep.md"]
        self.assertEqual(plan["title"], "Sprint request (Sample Co)")
        self.assertIn("Sample Co", plan["title_aliases"])  # From `client:`, not from the parentheses.
        context = RepositoryPreparations(active).context_from_active_file(plan["source_path"])
        self.assertIn("Sample context line.", context)
        self.assertIn("Sample context line.", plan["memo_markdown"])
        self.assertIn("## 4. Вопросы на звонке", plan["memo_markdown"])
        self.assertEqual(plan["memo_url"], "https://drive.example.com/memo")
        self.assertEqual([item["kind"] for item in plan["items"]], ["question"])
        self.assertEqual(found["sales/2026-09-29-other-prep.md"]["items"], [])

    def test_sales_kit_memo_section_reaches_the_live_plan(self):
        active = self._repo({"PREP.md": (
            "---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n"
            "[Brief](https://example.com/brief)\n"
            "## Мемо перед встречей\n**Цель встречи.** Agree next step.\nSecond memo line.\n"
            "## Опросник\n1. Who checks documents?\n")})
        plans = CallPlans(self.root / "absent.json", self.state, active)
        result = plans.snapshot(self.meeting)
        self.assertIn("Second memo line.", result["memo_markdown"])
        self.assertEqual(result["memo_url"], "https://example.com/brief")
        self.assertTrue(result["has_memo"])

    def test_agenda_lists_upcoming_meetings_with_matched_memo(self):
        active = self._repo({"PREP.md": (
            "---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n"
            "## Мемо перед встречей\nMemo body.\n## Опросник\n1. Who checks documents?\n")})

        class FakeCalendar:
            def available(self):
                return True

            def for_day(self, day):
                if str(day) != "2026-09-29":
                    return []
                return [
                    {"title": "Earlier call", "start": "2026-09-29T07:00:00+02:00",
                     "end": "2026-09-29T07:30:00+02:00", "link": "", "attendees": []},
                    {"title": "Weekly sync", "start": "2026-09-29T11:00:00+02:00",
                     "end": "2026-09-29T11:30:00+02:00", "link": "",
                     "attendees": [{"email": "a@example.com", "name": "Alex Sample", "self": False}]},
                    {"title": "Internal", "start": "2026-09-29T12:00:00+02:00",
                     "end": "2026-09-29T12:30:00+02:00", "link": "", "attendees": []},
                ]

        from datetime import datetime
        plans = CallPlans(self.root / "absent.json", self.state, active, FakeCalendar())
        result = plans.agenda(datetime.fromisoformat("2026-09-29T09:00:00+02:00"))
        self.assertTrue(result["calendar"])
        self.assertEqual([item["title"] for item in result["meetings"]], ["Weekly sync", "Internal"])
        matched, unmatched = result["meetings"]
        self.assertEqual(matched["attendees"][0]["name"], "Alex Sample")
        self.assertEqual(len(matched["plans"]), 1)
        self.assertTrue(matched["plans"][0]["has_memo"])
        self.assertIn("Memo body.", matched["plans"][0]["memo_markdown"])
        self.assertEqual(unmatched["plans"], [])
        self.assertEqual(result["unscheduled_plans"], [])
        self.assertFalse(self.state.exists())  # The agenda binds nothing to a meeting.

    def test_agenda_orders_by_time_and_ended_event_keeps_its_plan(self):
        active = self._repo({"PREP.md": (
            "---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n"
            "## Опросник\n1. Who checks documents?\n")})

        class FakeCalendar:
            def available(self):
                return True

            def for_day(self, day):
                if str(day) != "2026-09-29":
                    return []
                return [
                    {"title": "Acme review", "start": "2026-09-29T06:00:00+00:00",
                     "end": "2026-09-29T06:30:00+00:00", "link": "", "attendees": []},
                    {"title": "Later UTC", "start": "2026-09-29T10:00:00+00:00",
                     "end": "2026-09-29T10:30:00+00:00", "link": "", "attendees": []},
                    {"title": "Earlier CEST", "start": "2026-09-29T11:00:00+02:00",
                     "end": "2026-09-29T11:30:00+02:00", "link": "", "attendees": []},
                ]

        from datetime import datetime
        plans = CallPlans(self.root / "absent.json", self.state, active, FakeCalendar())
        result = plans.agenda(datetime.fromisoformat("2026-09-29T09:00:00+02:00"))
        self.assertEqual([item["title"] for item in result["meetings"]], ["Earlier CEST", "Later UTC"])
        self.assertEqual(result["unscheduled_plans"], [])

    def test_agenda_items_carry_event_id_and_external(self):
        class FakeCalendar:
            def available(self):
                return True

            def for_day(self, day):
                if str(day) != "2026-09-29":
                    return []
                return [
                    {"id": "ev1", "title": "Pilot review", "start": "2026-09-29T10:00:00+02:00",
                     "end": "2026-09-29T10:30:00+02:00", "link": "",
                     "attendees": [{"email": "me@example.org", "name": "", "self": True, "resource": False},
                                   {"email": "anna@example.com", "name": "Anna Petrova", "self": False,
                                    "resource": False}]},
                    {"id": "", "title": "Focus time", "start": "2026-09-29T11:00:00+02:00",
                     "end": "2026-09-29T11:30:00+02:00", "link": "", "attendees": []},
                ]

        from datetime import datetime
        now = datetime.fromisoformat("2026-09-29T09:00:00+02:00")
        plans = CallPlans(self.root / "absent.json", self.state, calendar=FakeCalendar())
        meetings = plans.agenda(now)["meetings"]
        self.assertEqual([(m["event_id"], m["external"]) for m in meetings], [("ev1", True), ("", False)])

    def test_two_events_same_start_and_title_but_different_ids_both_listed(self):
        overnight = {"id": "ev3", "title": "Overnight", "start": "2026-09-29T23:30:00+02:00",
                     "end": "2026-09-30T00:30:00+02:00", "link": "", "attendees": []}

        class FakeCalendar:
            def available(self):
                return True

            def for_day(self, day):
                if str(day) == "2026-09-30":
                    return [dict(overnight)]  # An event spanning midnight comes back for both days.
                return [
                    {"id": "ev1", "title": "Pilot review", "start": "2026-09-29T10:00:00+02:00",
                     "end": "2026-09-29T10:30:00+02:00", "link": "", "attendees": []},
                    {"id": "ev2", "title": "Pilot review", "start": "2026-09-29T10:00:00+02:00",
                     "end": "2026-09-29T10:30:00+02:00", "link": "", "attendees": []},
                    dict(overnight),
                ]

        from datetime import datetime
        plans = CallPlans(self.root / "absent.json", self.state, calendar=FakeCalendar())
        meetings = plans.agenda(datetime.fromisoformat("2026-09-29T09:00:00+02:00"))["meetings"]
        self.assertEqual([m["event_id"] for m in meetings], ["ev1", "ev2", "ev3"])


    def test_app_plan_is_third_source_matched_by_event_id(self):
        same = {"title": "Pilot review", "start": "2026-09-29T10:00:00+02:00",
                "end": "2026-09-29T10:30:00+02:00", "link": "", "attendees": EXTERNAL}
        calendar = calendar_of({"2026-09-29": [{**same, "id": "ev1"}, {**same, "id": "ev2"}]})
        plans = CallPlans(self.root / "absent.json", self.state, None, calendar,
                          app_plans=lambda: [APP_PLAN_FOR_EV1])
        result = plans.agenda(NOW)
        first, second = result["meetings"]
        self.assertEqual([p["id"] for p in first["plans"]], [APP_PLAN_FOR_EV1["id"]])
        self.assertEqual(first["plans"][0]["written_by"], "app")
        self.assertEqual(second["plans"], [])  # Same title and time, another event: not its plan.
        self.assertEqual(result["unscheduled_plans"], [])

    def test_agenda_memo_gets_the_item_and_its_raw_hits(self):
        calendar = calendar_of({"2026-09-29": [{"id": "ev1", "title": "Pilot review",
                                                "start": "2026-09-29T10:00:00+02:00",
                                                "end": "2026-09-29T10:30:00+02:00", "link": "", "attendees": EXTERNAL}]})
        plans = CallPlans(self.root / "absent.json", self.state, None, calendar,
                          app_plans=lambda: [APP_PLAN_FOR_EV1])
        calls = []
        meeting = plans.agenda(NOW, memo=lambda item, hits: calls.append((item, hits)) or {"state": "x"})["meetings"][0]
        self.assertEqual(meeting["memo"], {"state": "x"})
        item, hits = calls[0]
        self.assertNotIn("plans", item)
        self.assertNotIn("_sort", item)
        self.assertEqual(item["event_id"], "ev1")
        self.assertEqual(hits, [APP_PLAN_FOR_EV1])
        self.assertNotIn("memo", plans.agenda(NOW)["meetings"][0])

    def test_file_plan_wins_over_app_plan_for_same_meeting(self):
        active = self._repo({"PREP.md": (
            "---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n"
            "## Опросник\n1. Who checks documents?\n")})
        calendar = calendar_of({"2026-09-29": [{"id": "ev1", "title": "Weekly sync",
                                                "start": "2026-09-29T10:00:00+02:00",
                                                "end": "2026-09-29T10:30:00+02:00", "link": "",
                                                "attendees": [{"email": "a@example.com", "name": "Alex Sample"}]}]})
        app_plan = {**APP_PLAN_FOR_EV1, "attendee_aliases": ["Alex Sample"]}
        plans = CallPlans(self.root / "absent.json", self.state, active, calendar, app_plans=lambda: [app_plan])
        meeting = plans.agenda(NOW)["meetings"][0]
        self.assertEqual([p["written_by"] for p in meeting["plans"]], ["file"])
        file_plan_id = meeting["plans"][0]["id"]
        # A live call with a generic capture title during ev1: both plans are calendar candidates.
        generic = {**self.meeting, "meeting_id": "live-generic", "meeting": "Google Chrome Helper",
                   "remote_attendees": [], "started_at": "2026-09-29T08:02:00Z"}
        self.assertEqual(plans.snapshot(generic)["id"], file_plan_id)
        # A live call whose attendee names match both plans.
        named = {**self.meeting, "meeting_id": "live-named", "started_at": "2026-09-29T08:02:00Z"}
        self.assertEqual(plans.snapshot(named)["id"], file_plan_id)

    def test_live_call_matching_only_app_aliases_gets_the_file_plan(self):
        calendar = calendar_of({"2026-09-29": [{"id": "ev1", "title": "Pilot review",
                                                "start": "2026-09-29T10:00:00+02:00",
                                                "end": "2026-09-29T10:30:00+02:00", "link": "",
                                                "attendees": [{"email": "a@example.com", "name": "Alex Sample"}]}]})
        plans = CallPlans(self.config, self.state, None, calendar, app_plans=lambda: [APP_PLAN_FOR_EV1])
        self.assertEqual([(p["id"], p["written_by"]) for p in plans.agenda(NOW)["meetings"][0]["plans"]],
                         [("sample-2026-09-29", "file")])
        live = {**self.meeting, "meeting_id": "live", "meeting": "Pilot review", "remote_attendees": [],
                "started_at": "2026-09-29T08:02:00Z"}
        snapshot = plans.snapshot(live)
        self.assertEqual((snapshot["id"], snapshot["match"]), ("sample-2026-09-29", "calendar"))

    def test_file_plan_of_adjacent_meeting_does_not_hide_app_plan(self):
        active = self._repo({"PREP.md": (
            "---\ncall_date: 2026-09-29\n---\n# Sales kit: Acme / Alex Sample\n"
            "## Опросник\n1. Who checks documents?\n")})
        calendar = calendar_of({"2026-09-29": [
            {"id": "ev0", "title": "Weekly sync", "start": "2026-09-29T09:30:00+02:00",
             "end": "2026-09-29T10:00:00+02:00", "link": "",
             "attendees": [{"email": "a@example.com", "name": "Alex Sample"}]},
            {"id": "ev1", "title": "Pilot review", "start": "2026-09-29T10:00:00+02:00",
             "end": "2026-09-29T10:30:00+02:00", "link": "", "attendees": EXTERNAL}]})
        plans = CallPlans(self.root / "absent.json", self.state, active, calendar,
                          app_plans=lambda: [APP_PLAN_FOR_EV1])
        generic = {**self.meeting, "meeting_id": "live-generic", "meeting": "Google Chrome Helper",
                   "remote_attendees": [], "started_at": "2026-09-29T08:02:00Z"}
        self.assertEqual(plans.snapshot(generic)["id"], APP_PLAN_FOR_EV1["id"])

    def test_app_plan_without_event_id_stays_chosen(self):
        calendar = calendar_of({"2026-09-29": [{"id": "ev1", "title": "Pilot review",
                                                "start": "2026-09-29T10:00:00+02:00",
                                                "end": "2026-09-29T10:30:00+02:00", "link": "", "attendees": []}]})
        plans = CallPlans(self.config, self.state, None, calendar)
        plan = {key: value for key, value in APP_PLAN_FOR_EV1.items() if key != "event_id"}
        live = {**self.meeting, "meeting_id": "live", "started_at": "2026-09-29T08:02:00Z"}
        self.assertIs(plans._file_over_app(plan, [plan], live), plan)

    def test_app_plan_follows_rescheduled_event(self):
        calendar = calendar_of({"2026-09-30": [{"id": "ev1", "title": "Moved call",
                                                "start": "2026-09-30T15:00:00+02:00",
                                                "end": "2026-09-30T15:30:00+02:00", "link": "", "attendees": EXTERNAL}]})
        plans = CallPlans(self.root / "absent.json", self.state, None, calendar,
                          app_plans=lambda: [APP_PLAN_FOR_EV1])
        result = plans.agenda(NOW)
        self.assertEqual([p["id"] for p in result["meetings"][0]["plans"]], [APP_PLAN_FOR_EV1["id"]])
        self.assertEqual(result["unscheduled_plans"], [])

    def app_plans(self, *plans, events=None, bound=True):
        """CallPlans over app plans for events ev1 (10:00) and ev2 (11:00), both external, unless `events`."""
        if events is None:
            events = [event("ev1", "Pilot review", "10:00"), event("ev2", "Contract follow-up", "11:00")]
        self.current = [dict(plan) for plan in plans]
        return CallPlans(self.root / "absent.json", self.state, None, calendar_of({"2026-09-29": events}),
                         app_plans=lambda: list(self.current), bound_dir=self.root / "data/bound-memos" if bound else None)

    def live(self, meeting_id, at, title="Generic video call", attendees=("Anna Petrova",), link=""):
        return {**self.meeting, "meeting_id": meeting_id, "meeting": title, "remote_attendees": list(attendees),
                "meeting_link": link, "started_at": f"2026-09-29T{at}:00+02:00"}

    def test_bound_app_plan_keeps_its_revision_in_the_data_directory(self):
        plans = self.app_plans(APP_PLAN_FOR_EV1)
        live = self.live("live", "10:02")
        bound = plans.snapshot(live)
        self.assertEqual(bound["id"], APP_PLAN_FOR_EV1["id"])
        self.assertNotIn("plan", json.loads(self.state.read_text())["meetings"]["live"])  # not in settings
        self.assertEqual(len(list((self.root / "data/bound-memos").glob("*.json"))), 1)
        # A rebuild publishes another revision: the bound call keeps the one its checklist ids point at.
        self.current = [{**APP_PLAN_FOR_EV1, "items": [{"id": "q1", "kind": "question", "text": "What is the budget?"}]}]
        self.assertEqual(plans.snapshot(live)["items"][0]["text"], "Who signs off?")
        self.current = []  # the memo store prunes the entry
        self.assertEqual(plans.snapshot(live), bound)

    def test_existing_binding_keeps_a_memo_whose_event_was_cancelled(self):
        plans = self.app_plans(APP_PLAN_FOR_EV1)
        live = self.live("live", "10:02")
        bound = plans.snapshot(live)
        plans.calendar = calendar_of({})
        self.assertEqual(plans.snapshot(live), bound)

    def test_cancelled_or_internal_event_memo_is_not_offered_to_a_new_recording(self):
        internal = {**event("ev1", "Pilot review", "10:00"), "attendees": [{"email": "me@example.org", "self": True}]}
        for events in ([], [internal]):
            with self.subTest(events=events):
                plans = self.app_plans(APP_PLAN_FOR_EV1, events=events)
                self.assertIsNone(plans.snapshot(self.live("new", "10:02", title="Pilot review")))

    def test_back_to_back_memos_with_a_shared_attendee_bind_by_title(self):
        second = {**APP_PLAN_FOR_EV1, "id": "app-fedcba9876543210", "event_id": "ev2",
                  "starts_at": "2026-09-29T11:00:00+02:00", "title": "Contract follow-up",
                  "title_aliases": ["Contract follow-up"]}
        plans = self.app_plans(APP_PLAN_FOR_EV1, second)
        self.assertEqual(plans.snapshot(self.live("first", "10:02", title="Pilot review"))["id"], APP_PLAN_FOR_EV1["id"])
        # Only the shared attendee: the nearest start decides.
        self.assertEqual(plans.snapshot(self.live("second", "10:58"))["id"], second["id"])

    def test_shared_meeting_link_binds_by_title_then_nearest_start(self):
        link = "https://meet.example.com/standing"
        first = {**APP_PLAN_FOR_EV1, "meeting_link": link}
        second = {**first, "id": "app-fedcba9876543210", "event_id": "ev2", "starts_at": "2026-09-29T11:00:00+02:00",
                  "title": "Contract follow-up", "title_aliases": ["Contract follow-up"], "attendee_aliases": []}
        plans = self.app_plans(first, second)
        # 10:40 is nearer to 11:00, but only the first memo's title is the call's.
        self.assertEqual(plans.snapshot(self.live("titled", "10:40", title="Pilot review", link=link + "/"))["id"],
                         first["id"])
        self.assertEqual(plans.snapshot(self.live("near", "10:55", attendees=(), link=link))["id"], second["id"])

    def test_true_tie_between_app_memos_stays_unbound(self):
        twin = {**APP_PLAN_FOR_EV1, "id": "app-fedcba9876543210", "event_id": "ev2"}
        plans = self.app_plans(APP_PLAN_FOR_EV1, twin, events=[event("ev1", "Pilot review", "10:00"),
                                                                event("ev2", "Pilot review", "10:00")])
        self.assertIsNone(plans.snapshot(self.live("tie", "10:02", title="Pilot review")))
        self.assertNotIn("tie", json.loads(self.state.read_text())["meetings"] if self.state.exists() else {})

    def test_file_plan_beats_the_app_plan_when_calendar_is_off_or_failing(self):
        self.config.write_text(json.dumps({"version": 1, "plans": [{
            "id": "file-plan", "starts_at": "2026-09-29T10:00:00+02:00", "title_aliases": ["Pilot review"],
            "title": "Pilot review", "items": [{"id": "q1", "kind": "question", "text": "Who signs off?"}]}]}),
            encoding="utf-8")
        app = {**APP_PLAN_FOR_EV1, "meeting_link": "https://meet.example.com/abc"}
        live = self.live("live", "10:02", title="Pilot review", link="https://meet.example.com/abc")
        for n, calendar in enumerate((None, calendar_of({}))):
            with self.subTest(calendar=calendar):
                plans = CallPlans(self.config, self.root / f"state-{n}.json", None, calendar, app_plans=lambda: [app],
                                  bound_dir=self.root / "data/bound-memos")
                self.assertEqual(plans.snapshot(live)["id"], "file-plan")

    def test_malformed_aliases_of_another_plan_are_skipped(self):
        raw = json.loads(self.config.read_text())
        raw["plans"].append({"id": "broken", "starts_at": "2026-09-29T10:30:00+02:00", "title_aliases": None,
                             "attendee_aliases": None, "items": []})
        self.config.write_text(json.dumps(raw), encoding="utf-8")
        self.assertEqual(self.plan.snapshot(self.meeting)["id"], "sample-2026-09-29")

    def test_file_plan_hours_away_does_not_hide_the_app_plan_of_the_live_call(self):
        self.config.write_text(json.dumps({"version": 1, "plans": [{
            "id": "afternoon", "starts_at": "2026-09-29T15:00:00+02:00", "title_aliases": ["Pilot review"],
            "title": "Afternoon", "items": [{"id": "q1", "kind": "question", "text": "Who signs off?"}]}]}),
            encoding="utf-8")
        calendar = calendar_of({"2026-09-29": [{"id": "ev1", "title": "Pilot review",
                                                "start": "2026-09-29T10:00:00+02:00",
                                                "end": "2026-09-29T10:30:00+02:00", "link": "",
                                                "attendees": EXTERNAL}]})
        plans = CallPlans(self.config, self.state, None, calendar, app_plans=lambda: [APP_PLAN_FOR_EV1])
        self.assertEqual([p["id"] for p in plans.agenda(NOW)["meetings"][0]["plans"]], [APP_PLAN_FOR_EV1["id"]])
        generic = {**self.meeting, "meeting_id": "live-generic", "meeting": "Google Chrome Helper",
                   "remote_attendees": [], "started_at": "2026-09-29T08:02:00Z"}
        self.assertEqual(plans.snapshot(generic)["id"], APP_PLAN_FOR_EV1["id"])

    def test_app_plan_of_an_event_that_became_internal_is_hidden(self):
        internal = [{"email": "me@example.org", "self": True}, {"email": "kate@example.org", "name": "Kate Example"}]
        calendar = calendar_of({"2026-09-29": [{"id": "ev1", "title": "Pilot review",
                                                "start": "2026-09-29T10:00:00+02:00",
                                                "end": "2026-09-29T10:30:00+02:00", "link": "",
                                                "attendees": internal}]})
        plans = CallPlans(self.root / "absent.json", self.state, None, calendar, app_plans=lambda: [APP_PLAN_FOR_EV1])
        hits = []
        meeting = plans.agenda(NOW, memo=lambda item, found: hits.append(found) or {})["meetings"][0]
        self.assertEqual((meeting["plans"], hits), ([], [[]]))
        live = {**self.meeting, "meeting_id": "live", "remote_attendees": ["Anna Petrova"],
                "started_at": "2026-09-29T08:02:00Z"}
        self.assertIsNone(plans.snapshot(live))

    def test_preparations_json_untouched(self):
        calendar = calendar_of({"2026-09-29": [{"id": "ev1", "title": "Pilot review",
                                                "start": "2026-09-29T10:00:00+02:00",
                                                "end": "2026-09-29T10:30:00+02:00", "link": "", "attendees": EXTERNAL}]})
        plans = CallPlans(self.config, self.state, None, calendar, app_plans=lambda: [APP_PLAN_FOR_EV1])
        before = (self.config.read_bytes(), self.config.stat().st_mtime_ns)
        plans.agenda(NOW)
        live = {**self.meeting, "meeting_id": "live", "remote_attendees": ["Anna Petrova"],
                "started_at": "2026-09-29T08:02:00Z"}
        self.assertIsNotNone(plans.snapshot(live))
        self.assertEqual((self.config.read_bytes(), self.config.stat().st_mtime_ns), before)
        self.assertEqual(list(self.root.glob("*-prep.md")), [])


if __name__ == "__main__":
    unittest.main()
