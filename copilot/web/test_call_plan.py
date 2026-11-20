import json
import tempfile
import unittest
from pathlib import Path

from call_plan import CallPlans
from repo_preparations import RepositoryPreparations


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


if __name__ == "__main__":
    unittest.main()
