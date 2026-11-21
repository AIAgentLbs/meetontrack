"""Private, meeting-scoped preparation and live checklist state."""

from __future__ import annotations

import json
import re
import threading
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from calendar_meetings import CalendarMeetings
from memo_writer import is_external
from repo_preparations import RepositoryPreparations
from private_dirs import private_dir


KINDS = {"question", "risk", "objection"}
STATUSES = {"open", "resolved", "clarify"}
UPDATE_RE = re.compile(r"(?m)^PLAN_UPDATE\s*[:—-]\s*(\{[^\n]*\})\s*$")
MEMO_LIMIT = 60_000


def _normal(value: str) -> str:
    return " ".join(re.findall(r"\w+", value.casefold()))


def _safe_link(value: str) -> bool:
    parsed = urlsplit(value)
    return parsed.scheme == "https" and bool(parsed.netloc) and not parsed.username


def _links(plan: dict) -> list[dict]:
    return [
        {"label": str(link.get("label") or "Материал")[:100], "url": link["url"]}
        for link in plan.get("links", []) if isinstance(link, dict)
        and isinstance(link.get("url"), str) and _safe_link(link["url"])
    ][:30]


def _memo(plan: dict) -> dict:
    """The memo the person reads: full Markdown text and the memo document link."""
    memo_url = str(plan.get("memo_url") or "")
    memo_url = memo_url if _safe_link(memo_url) else ""
    memo_markdown = str(plan.get("memo_markdown") or "")[:MEMO_LIMIT]
    return {
        "memo_markdown": memo_markdown, "memo_url": memo_url,
        "talk_track_markdown": str(plan.get("talk_track_markdown") or "")[:MEMO_LIMIT],
        "has_memo": bool(memo_markdown or memo_url),
    }


class CallPlans:
    def __init__(
        self, config_path: Path, state_path: Path,
        repositories_path: Path | None = None,
        calendar: CalendarMeetings | None = None,
        app_plans: Callable[[], list[dict]] | None = None,
    ) -> None:
        self.config_path = config_path
        self.state_path = state_path
        self.lock = threading.RLock()
        self.repositories = RepositoryPreparations(repositories_path) if repositories_path else None
        self.calendar = calendar
        self.app_plans = app_plans  # plans the memo writer wrote, matched to their calendar event by id

    def _plans(self, transcript: dict) -> list[dict]:
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        configured = raw.get("plans", []) if isinstance(raw, dict) and raw.get("version") == 1 else []
        if not isinstance(configured, list):
            configured = []
        plans = []
        used_sources = set()
        for original in configured:
            if not isinstance(original, dict):
                continue
            plan = dict(original)
            source = plan.get("source_file")
            if isinstance(source, str) and self.repositories:
                prepared = self.repositories.from_active_file(source)
                if prepared:
                    used_sources.add(prepared["source_path"])
                    plan["title"] = prepared["title"]
                    plan["intro"] = " ".join(part for part in (
                        str(plan.get("intro") or ""), prepared["intro"]
                    ) if part)
                    plan["source_label"] = prepared["source_label"]
                    plan["meeting_link"] = prepared.get("meeting_link", "")
                    for field in ("memo_markdown", "talk_track_markdown", "memo_url"):
                        plan[field] = plan.get(field) or prepared.get(field, "")
                    explicit_items = plan.get("items", [])
                    plan["items"] = prepared["items"] + (
                        [item for item in explicit_items if isinstance(item, dict)]
                        if isinstance(explicit_items, list) else []
                    )
                    links = plan.get("links", [])
                    merged = (links if isinstance(links, list) else []) + prepared["links"]
                    plan["links"] = list({link.get("url"): link for link in merged if isinstance(link, dict) and isinstance(link.get("url"), str)}.values())
            plans.append(plan)
        if self.repositories and transcript.get("started_at"):
            try:
                local_date = datetime.fromisoformat(
                    str(transcript["started_at"]).replace("Z", "+00:00")
                ).astimezone().date().isoformat()
            except ValueError:
                local_date = ""
            if local_date:
                plans.extend(
                    found for found in self.repositories.for_date(local_date)
                    if found["source_path"] not in used_sources
                )
        if self.app_plans:
            plans.extend(self.app_plans())  # last: a confirmed match picks a file plan first
        return plans

    def _state(self) -> dict:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"version": 1, "meetings": {}}
        meetings = raw.get("meetings") if isinstance(raw, dict) else None
        return {"version": 1, "meetings": meetings if isinstance(meetings, dict) else {}}

    def _save(self, state: dict) -> None:
        private_dir(self.state_path.parent)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(self.state_path)

    @staticmethod
    def _valid(plan: dict) -> bool:
        if not isinstance(plan.get("id"), str) or not plan["id"]:
            return False
        if plan.get("starts_at"):
            try:
                datetime.fromisoformat(str(plan["starts_at"]))
            except ValueError:
                return False
        else:
            try:
                datetime.fromisoformat(str(plan["call_date"]))
            except (KeyError, ValueError):
                return False
        items = plan.get("items")
        if not isinstance(items, list) or len(items) > 60:
            return False
        ids = [item.get("id") for item in items if isinstance(item, dict)]
        if len(ids) != len(items) or not all(isinstance(item_id, str) for item_id in ids):
            return False
        return len(set(ids)) == len(ids) and all(
            isinstance(item.get("id"), str)
            and re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", item["id"])
            and item.get("kind") in KINDS
            and isinstance(item.get("text"), str)
            and 0 < len(item["text"]) <= 500
            for item in items
        )

    @staticmethod
    def _matches(plan: dict, transcript: dict) -> bool:
        try:
            started = datetime.fromisoformat(str(transcript.get("started_at") or "").replace("Z", "+00:00"))
            if started.tzinfo is None:
                return False
            if plan.get("starts_at"):
                expected = datetime.fromisoformat(str(plan["starts_at"]))
                if expected.tzinfo is None or abs((started - expected).total_seconds()) > 2 * 3600:
                    return False
            elif started.astimezone().date().isoformat() != plan.get("call_date"):
                return False
        except (ValueError, TypeError, KeyError):
            return False
        if CallPlans._same_link(plan, transcript):
            return True
        names = _normal(" ".join(str(name) for name in transcript.get("remote_attendees", [])))
        title = _normal(str(transcript.get("meeting") or ""))
        attendee_hit = any(_normal(str(alias)) in names for alias in plan.get("attendee_aliases", []) if _normal(str(alias)))
        title_hit = any(_normal(str(alias)) in title for alias in plan.get("title_aliases", []) if _normal(str(alias)))
        return attendee_hit or title_hit

    @staticmethod
    def _same_link(plan: dict, transcript: dict) -> bool:
        meeting_link = str(transcript.get("meeting_link") or "").rstrip("/")
        return bool(meeting_link) and meeting_link == str(plan.get("meeting_link") or "").rstrip("/")

    @staticmethod
    def _generic_capture(transcript: dict) -> bool:
        if transcript.get("remote_attendees") or transcript.get("meeting_link"):
            return False
        title = _normal(str(transcript.get("meeting") or ""))
        return not title or any(generic in title for generic in ("chrome helper", "meeting", "telemost", "zoom"))

    @staticmethod
    def _time_fallback(plan: dict, transcript: dict) -> bool:
        """Show a tentative plan for a generic app title near one scheduled call."""
        try:
            expected = datetime.fromisoformat(str(plan["starts_at"]))
            started = datetime.fromisoformat(str(transcript.get("started_at") or "").replace("Z", "+00:00"))
            if expected.tzinfo is None or started.tzinfo is None:
                return False
            if abs((started - expected).total_seconds()) > 10 * 60:
                return False
        except (ValueError, TypeError, KeyError):
            return False
        return CallPlans._generic_capture(transcript)

    def _calendar_candidates(self, plans: list[dict], transcript: dict) -> list[dict]:
        if not self.calendar or not self._generic_capture(transcript):
            return []
        try:
            started = datetime.fromisoformat(str(transcript["started_at"]).replace("Z", "+00:00"))
            if started.tzinfo is None:
                return []
        except (KeyError, TypeError, ValueError):
            return []
        matches = []
        for event in self.calendar.for_day(started.astimezone().date()):
            try:
                event_start = datetime.fromisoformat(event["start"])
                event_end = datetime.fromisoformat(event["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if not event_start - timedelta(minutes=15) <= started <= event_end + timedelta(minutes=20):
                continue
            event_plans = [plan for plan in plans if self._event_matches(plan, event, started.astimezone().date())
                           and (plan.get("event_id") or self._near_scheduled_time(plan, event_start))]
            matches += [plan for plan in self._files_first(event_plans) if plan not in matches]
        return matches

    def _file_over_app(self, plan: dict | None, plans: list[dict], transcript: dict) -> dict | None:
        """A file plan that the agenda shows for an app plan's event replaces the app plan; it was
        found through the calendar event, so its match is "calendar"."""
        if not plan or plan.get("written_by") != "app" or not plan.get("event_id") or not self.calendar:
            return plan
        try:
            day = datetime.fromisoformat(str(transcript["started_at"]).replace("Z", "+00:00")).astimezone().date()
        except (KeyError, TypeError, ValueError):
            return plan
        for event in self.calendar.for_day(day):
            if event.get("id") != plan["event_id"]:
                continue
            try:
                event_start = datetime.fromisoformat(event["start"])
            except (KeyError, TypeError, ValueError):
                return plan
            file_plan = next((other for other in plans if other.get("written_by") != "app"
                              and self._event_matches(other, event, day)
                              and self._near_scheduled_time(other, event_start)), None)
            if file_plan:
                return {**file_plan, "_match": "calendar"}
            return plan if is_external(list(event.get("attendees") or [])) else None  # internal or solo now
        return plan

    @staticmethod
    def _files_first(plans: list[dict]) -> list[dict]:
        """A plan the person wrote (a file) hides the one the app wrote for the same meeting."""
        files = [plan for plan in plans if plan.get("written_by") != "app"]
        return files or plans

    @staticmethod
    def _event_matches(plan: dict, event: dict, day: date) -> bool:
        """A plan for this day whose alias is in the event title or attendee names, or whose link is the event's.
        An app-written plan belongs to its own event only, whatever day the event moved to."""
        if plan.get("event_id"):
            return plan["event_id"] == event.get("id")
        if CallPlans._scheduled_day(plan) != day:
            return False
        event_title = _normal(" ".join([str(event.get("title") or ""), *(
            str(person.get("name") or "") for person in event.get("attendees") or [] if isinstance(person, dict)
        )]))
        event_link = str(event.get("link") or "").rstrip("/")
        aliases = [
            alias for field in ("title_aliases", "attendee_aliases")
            for alias in (plan.get(field) if isinstance(plan.get(field), list) else [])
        ]
        name_hit = any(
            len(alias_normal := _normal(str(alias))) >= 4 and alias_normal in event_title
            for alias in aliases
        )
        planned_link = str(plan.get("meeting_link") or "").rstrip("/")
        return name_hit or bool(event_link and planned_link and event_link == planned_link)

    def agenda(self, now: datetime | None = None,
               memo: Callable[[dict, list[dict]], dict] | None = None) -> dict:
        """Today's and tomorrow's calendar meetings, each with its matched plans (none = no memo)
        and, when `memo` is given, its `memo` object from the meeting and its matched plans.

        Works with no live call; calendar reads and repository scans are cached by their owners.
        """
        now = now or datetime.now().astimezone()
        meetings, unscheduled, seen = [], [], set()
        for day in (now.date(), now.date() + timedelta(days=1)):
            noon = datetime.combine(day, time(12)).astimezone().isoformat()
            plans = [plan for plan in self._plans({"started_at": noon}) if self._valid(plan)]
            matched: set[str] = set()
            for event in (self.calendar.for_day(day) if self.calendar else []):
                try:
                    started, ended = datetime.fromisoformat(event["start"]), datetime.fromisoformat(event["end"])
                except (KeyError, TypeError, ValueError):
                    continue
                key = event.get("id") or (event["start"], event.get("title"))
                if key in seen:
                    continue  # An event spanning midnight comes back for both days.
                seen.add(key)
                attendees = list(event.get("attendees") or [])
                external = is_external(attendees)
                hits = self._files_first([
                    plan for plan in plans if self._event_matches(plan, event, day)
                    and (plan.get("event_id") or self._near_scheduled_time(plan, started))
                    and (external or plan.get("written_by") != "app")])  # internal or solo now: no app memo
                matched.update(plan["id"] for plan in hits)  # An ended event still owns its plan.
                if ended < now:
                    continue
                item = {
                    "event_id": str(event.get("id") or ""),
                    "start": event["start"], "end": event["end"],
                    "title": str(event.get("title") or ""), "link": str(event.get("link") or ""),
                    "attendees": attendees, "external": external,
                }
                if memo:
                    item["memo"] = memo(dict(item), hits)
                meetings.append({**item, "_sort": started, "plans": [self._summary(plan) for plan in hits]})
            unscheduled += [self._summary(plan) for plan in plans  # an app plan is never unscheduled
                            if plan["id"] not in matched and not plan.get("event_id")
                            and self._scheduled_day(plan) == day]
        return {"calendar": bool(self.calendar and self.calendar.available()),
                "meetings": [{k: v for k, v in item.items() if k != "_sort"}
                             for item in sorted(meetings, key=lambda item: item["_sort"])],
                "unscheduled_plans": unscheduled}

    @staticmethod
    def _near_scheduled_time(plan: dict, event_start: datetime) -> bool:
        """A plan with an explicit start time belongs only to an event within 2 h of it."""
        if not plan.get("starts_at"):
            return True
        try:
            expected = datetime.fromisoformat(str(plan["starts_at"]))
            return expected.tzinfo is not None and abs((event_start - expected).total_seconds()) <= 2 * 3600
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _scheduled_day(plan: dict) -> date | None:
        try:
            scheduled_at = datetime.fromisoformat(str(plan.get("starts_at") or plan.get("call_date")))
        except (TypeError, ValueError):
            return None
        return scheduled_at.astimezone().date() if scheduled_at.tzinfo else scheduled_at.date()

    @staticmethod
    def _summary(plan: dict) -> dict:
        return {"id": plan["id"], "title": str(plan.get("title") or "")[:200],
                "source_label": str(plan.get("source_label") or "")[:200],
                "written_by": "app" if plan.get("written_by") == "app" else "file",
                "links": _links(plan), **_memo(plan)}

    def _plan_for(self, transcript: dict, state: dict) -> dict | None:
        meeting_id = str(transcript.get("meeting_id") or "")
        if not meeting_id:
            return None
        bound_id = state["meetings"].get(meeting_id, {}).get("plan_id")
        plans = [plan for plan in self._plans(transcript) if self._valid(plan)]
        if bound_id:
            stored = state["meetings"][meeting_id].get("plan")  # an app plan outlives the memo store's entry
            return next((plan for plan in plans if plan["id"] == bound_id), None) or (
                stored if isinstance(stored, dict) and self._valid(stored) and stored["id"] == bound_id else None)
        if transcript.get("explicit_boundary") and transcript.get("physical_meeting_id") != meeting_id:
            return None
        matching = [plan for plan in plans if self._matches(plan, transcript)]
        # The exact meeting link decides first; app plans matched only by a shared alias stay unbound.
        candidates = self._files_first([plan for plan in matching if self._same_link(plan, transcript)] or matching)
        chosen = candidates[0] if len(candidates) == 1 or candidates and candidates[0].get("written_by") != "app" else None
        if not chosen:
            calendar_matches = self._calendar_candidates(plans, transcript)
            tentative = self._files_first([plan for plan in plans if self._time_fallback(plan, transcript)])
            chosen = (calendar_matches[0] if len(calendar_matches) == 1
                      else tentative[0] if len(tentative) == 1 else None)
        return self._file_over_app(chosen, plans, transcript)

    def snapshot(self, transcript: dict) -> dict | None:
        meeting_id = str(transcript.get("meeting_id") or "")
        if not meeting_id:
            return None
        with self.lock:
            state = self._state()
            plan = self._plan_for(transcript, state)
            if plan is None:
                return None
            if meeting_id not in state["meetings"]:
                calendar_matches = self._calendar_candidates([plan], transcript)
                state["meetings"][meeting_id] = {
                    "plan_id": plan["id"], "items": {},
                    "match": "confirmed" if self._matches(plan, transcript)
                    else "calendar" if calendar_matches or plan.get("_match") else "time-only",
                    **({"plan": plan} if plan.get("written_by") == "app" else {}),
                }
                self._save(state)
            meeting = state["meetings"][meeting_id]
            items = []
            for source in plan["items"]:
                item_state = meeting.get("items", {}).get(source["id"], {})
                items.append({
                    "id": source["id"], "kind": source["kind"], "text": source["text"],
                    "status": item_state.get("status", "open"),
                    "evidence": item_state.get("evidence", ""),
                    "updated_at": item_state.get("updated_at", ""),
                    "source": item_state.get("source", ""),
                })
            links = _links(plan)
            by_kind = {
                kind: {
                    "resolved": sum(item["kind"] == kind and item["status"] == "resolved" for item in items),
                    "clarify": sum(item["kind"] == kind and item["status"] == "clarify" for item in items),
                    "total": sum(item["kind"] == kind for item in items),
                }
                for kind in ("question", "risk", "objection")
            }
            return {
                "id": plan["id"], "meeting_id": meeting_id,
                "match": meeting.get("match", "confirmed"),
                "title": str(plan.get("title") or "Подготовка")[:200],
                "intro": str(plan.get("intro") or "")[:1500],
                "source_label": str(plan.get("source_label") or "")[:200],
                "links": links, "items": items, **_memo(plan),
                "score": {
                    "resolved": sum(item["status"] == "resolved" for item in items),
                    "clarify": sum(item["status"] == "clarify" for item in items),
                    "total": len(items),
                    "percent": round(100 * sum(item["status"] == "resolved" for item in items) / len(items)) if items else 0,
                    "by_kind": by_kind,
                },
            }

    def source_context(self, transcript: dict) -> str:
        if not self.repositories:
            return ""
        with self.lock:
            plan = self._plan_for(transcript, self._state())
            source = plan.get("source_path") if plan else None
            if not source and plan:
                source = plan.get("source_file")
            return self.repositories.context_from_active_file(source) if isinstance(source, str) else ""

    def manual_status(self, transcript: dict, item_id: str, status: str) -> dict:
        if status not in STATUSES:
            raise ValueError("Некорректный статус")
        with self.lock:
            plan = self.snapshot(transcript)
            if plan is None or item_id not in {item["id"] for item in plan["items"]}:
                raise ValueError("Пункт не найден в текущей встрече")
            state = self._state()
            state["meetings"][plan["meeting_id"]]["items"][item_id] = {
                "status": status, "evidence": "",
                "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "source": "manual",
            }
            self._save(state)
            return self.snapshot(transcript)

    def apply_analysis(self, transcript: dict, answer: str) -> int:
        """Accept only explicitly quoted evidence from this meeting's captured speech."""
        with self.lock:
            plan = self.snapshot(transcript)
            if plan is None:
                return 0
            valid_items = {item["id"]: item for item in plan["items"]}
            speech = _normal(" ".join(
                str(segment.get("text") or "") for segment in transcript.get("segments", [])
                if not segment.get("provisional")
            ))
            state = self._state()
            meeting_items = state["meetings"][plan["meeting_id"]]["items"]
            updated = 0
            for raw in UPDATE_RE.findall(answer):
                try:
                    update = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(update, dict):
                    continue
                item_id = str(update.get("id") or "")
                status = str(update.get("status") or "")
                evidence = str(update.get("evidence") or "").strip()
                quote = _normal(evidence)
                if (
                    item_id not in valid_items or status not in {"resolved", "clarify"}
                    or len(quote) < 12 or quote not in speech
                    or meeting_items.get(item_id, {}).get("source") == "manual"
                ):
                    continue
                meeting_items[item_id] = {
                    "status": status, "evidence": evidence[:400],
                    "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "source": "analysis",
                }
                updated += 1
            if updated:
                self._save(state)
            return updated
