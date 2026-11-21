"""Pre-call memo writer: decides which calendar meetings involve outside participants and keeps
the memo the app wrote for each of them in `memos.json`."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from archive import _atomic_json, _json
from twenty_crm import PUBLIC_DOMAINS

# Calendar addresses of rooms and groups: never a participant.
NOT_PEOPLE = ("resource.calendar.google.com", "group.calendar.google.com")
GENERIC_SECOND_LABELS = {"co", "com", "org", "net", "gov", "ac"}


def _domain(email: object) -> str:
    return str(email or "").rpartition("@")[2].strip().lower()


def outside_attendees(attendees: list[dict]) -> list[dict]:
    """Attendees from outside the user's own domain (everyone else when the user's domain is public)."""
    own = next((_domain(a.get("email")) for a in attendees if a.get("self")), "")
    people = [a for a in attendees if not a.get("self") and not a.get("resource")
              and not _domain(a.get("email")).endswith(NOT_PEOPLE)]
    if not own or own in PUBLIC_DOMAINS:
        return people
    return [a for a in people if (d := _domain(a.get("email"))) != own and not d.endswith("." + own)]


def is_external(attendees: list[dict]) -> bool:
    return bool(outside_attendees(attendees))


def company_from(email: str) -> str:
    """The company label of an e-mail domain; empty for a public mailbox or no domain."""
    if "@" not in str(email or ""):
        return ""
    labels = _domain(email).split(".")
    if len(labels) < 2 or ".".join(labels) in PUBLIC_DOMAINS:
        return ""
    top = labels.pop()
    # ponytail: no public-suffix list; misnames rare ccTLD forms
    if len(top) == 2 and len(labels) > 1 and (len(labels[-1]) == 2 or labels[-1] in GENERIC_SECOND_LABELS):
        labels.pop()
    return labels[-1]


def one_line(text: str, limit: int) -> str:
    """The first non-empty line, whitespace collapsed, cut at the last space before `limit`."""
    line = " ".join(next((line for line in str(text or "").splitlines() if line.strip()), "").split())
    if len(line) <= limit:
        return line
    return line[:limit].rpartition(" ")[0] or line[:limit]


def file_digest(plan: dict) -> dict:
    """The Home digest of a picked-up plan (a -prep.md file or preparations.json), without the AI."""
    goal = one_line(str(plan.get("intro") or ""), 160)
    if not goal:
        body = next((line for line in str(plan.get("memo_markdown") or "").splitlines()
                     if line.strip() and not line.lstrip().startswith("#")), "")
        goal = one_line(body.translate(str.maketrans("", "", "*_`")), 160)
    questions = [str(item.get("text") or "") for item in plan.get("items") or []
                 if isinstance(item, dict) and item.get("kind") == "question"]
    return {"goal": goal, "questions": questions[:3], "background": "", "source_count": 1}


def _time(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else None


NEW_ENTRY = {
    "state": "", "start": "", "since": None, "reason": "", "retry_at": None, "attempts": 0,
    "rebuild": False, "rechecked": False, "signature": "", "language": "", "provider": "", "model": "",
    "written_at": None, "plan": None,
}


class MemoWriter:
    """Memos the app writes for upcoming external meetings, one entry per calendar event id."""
    RETRY = timedelta(minutes=20)
    RECHECK = timedelta(hours=2)
    KEEP = timedelta(days=2)
    TICK = 60
    AI_TIMEOUT = 300

    def __init__(self, path: Path, ai, gather: Callable[[dict], list[dict]], language: Callable[[], str]) -> None:
        self.path, self.ai, self.gather, self.language = path, ai, gather, language
        self.lock = threading.Lock()
        self.wake = threading.Event()
        payload = _json(path, {})
        events = payload.get("events") if isinstance(payload, dict) else None
        self.events: dict[str, dict] = {
            key: value for key, value in (events if isinstance(events, dict) else {}).items()
            if isinstance(value, dict)}
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        for entry in self.events.values():
            if entry.get("state") == "preparing":  # cut short by a restart: retry once
                entry.update(state="failed", reason="error", attempts=1, retry_at=now, since=None)

    def _update(self, event_id: str, **values) -> None:
        with self.lock:
            before = dict(self.events)
            self.events[event_id] = {
                **NEW_ENTRY, "digest": {"goal": "", "questions": [], "background": "", "source_count": 0},
                **self.events.get(event_id, {}), **values}
            oldest = datetime.now().astimezone() - self.KEEP
            for key in [key for key, entry in self.events.items()
                        if (start := _time(entry.get("start"))) and start < oldest]:
                del self.events[key]
            try:
                _atomic_json(self.path, {"version": 1, "events": self.events})
            except Exception:  # not saved: memory keeps what the file says
                self.events.clear()
                self.events.update(before)
                raise

    def plans(self) -> list[dict]:
        with self.lock:
            return [entry["plan"] for entry in self.events.values()
                    if entry.get("state") == "ready" and isinstance(entry.get("plan"), dict)]

    def memo_for(self, meeting: dict, hits: list[dict], now: datetime | None = None) -> dict:
        """The agenda `memo` object of one meeting; `hits` are the plans matched to it."""
        file_plan = next((hit for hit in hits if hit.get("written_by") != "app"), None)
        if file_plan:
            return self._memo("ready", file_digest(file_plan), plan_id=str(file_plan.get("id") or ""),
                              written_by="file")
        event_id = str(meeting.get("event_id") or "")
        with self.lock:
            entry = dict(self.events.get(event_id) or {}) if event_id else {}
        if not entry:
            start = _time(meeting.get("start"))
            future = start is not None and start > (now or datetime.now().astimezone())
            return self._memo("preparing" if event_id and meeting.get("external") and future else "none")
        state = entry.get("state")
        if state == "ready":
            plan = entry.get("plan") if isinstance(entry.get("plan"), dict) else {}
            return self._memo("ready", entry.get("digest") or {}, plan_id=str(plan.get("id") or ""))
        if state == "failed":
            return self._memo("failed", reason=entry.get("reason") or "", retry_at=entry.get("retry_at"))
        if state == "preparing":
            return self._memo("preparing", since=entry.get("since"))
        return self._memo("nothing_found" if state == "nothing_found" else "none")

    @staticmethod
    def _memo(state: str, digest: dict | None = None, plan_id: str = "", written_by: str = "app",
              since: str | None = None, reason: str = "", retry_at: str | None = None) -> dict:
        digest = digest or {}
        return {"state": state, "goal": str(digest.get("goal") or ""),
                "questions": [str(q) for q in digest.get("questions") or []][:3],
                "background": str(digest.get("background") or ""),
                "source_count": int(digest.get("source_count") or 0),
                "plan_id": plan_id, "written_by": written_by,
                "since": since, "reason": reason, "retry_at": retry_at}
