"""The person's choices for one report after the call, and the send gate.

One file per report folder, ``<reports root>/<identity>/after.json``: hold,
send now, edited summary and next steps, board items left out of the report.
The gate tells the archive whether an automatic send may go now
(MEETONTRACK-163).
"""

from __future__ import annotations

import itertools
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

FIELDS = ("summary", "next_steps")
MAX_TEXT = 4000
MAX_REMOVED = 500
KEY = re.compile(r"^(journal|fact|memo|differs):[A-Za-z0-9_-]{1,80}$")


def _defaults() -> dict:
    return {"version": 1, "held": False, "send_now_at": None, "changed_at": None,
            "summary": None, "next_steps": None, "removed": [], "resent_at": None,
            # The moment the text of the first delivery was taken: an edit after it is not in that report.
            "delivered_at": None}


class AfterState:
    def __init__(self, root: Path, clock: Callable[[], float] = time.time, pause: float = 30.0):
        self.root = Path(root)
        self.clock = clock
        self.pause = pause
        self.lock = threading.Lock()
        self._blocked: dict[str, float | None] = {}
        self._sending: set[str] = set()  # reports between begin_send and end_send: a Hold can no longer stop them
        # Hold and Send now apply in the order they arrived: identity -> ticket of the last one applied.
        self._order: dict[str, int] = {}
        self._tickets = itertools.count(1)

    def _path(self, identity: str) -> Path:
        from archive import _safe  # archive imports this module; import at call time

        return self.root / _safe(identity) / "after.json"

    def _read(self, identity: str) -> dict:
        from archive import _json

        stored = _json(self._path(identity), None)
        state = _defaults()
        if isinstance(stored, dict):
            state.update({key: stored[key] for key in state if key in stored})
        # A wrong-typed field reads as its default: gate() runs inside the delivery path.
        for key in ("send_now_at", "changed_at", "resent_at", "delivered_at"):
            if isinstance(state[key], bool) or not isinstance(state[key], (int, float)):
                state[key] = None
        for key in FIELDS:
            if not isinstance(state[key], str):
                state[key] = None
        state["held"] = state["held"] is True
        state["removed"] = [key for key in state["removed"] if isinstance(key, str)] \
            if isinstance(state["removed"], list) else []
        return state

    def _change(self, identity: str, apply: Callable[[dict], None]) -> dict:
        from archive import _atomic_json  # writes 0600 inside a private_dir folder

        with self.lock:
            state = self._read(identity)
            apply(state)
            _atomic_json(self._path(identity), state)
            return state

    def read(self, identity: str) -> dict:
        with self.lock:
            return self._read(identity)

    def ticket(self) -> int:
        """Taken when a Hold or Send now arrives, before it waits for anything."""
        with self.lock:
            return next(self._tickets)

    def _ordered(self, identity: str, ticket: int | None, update: dict) -> Callable[[dict], None]:
        def apply(state: dict) -> None:
            if ticket is not None:
                if ticket < self._order.get(identity, 0):
                    return  # a later Hold or Send now already applied: this older press changes nothing
                self._order[identity] = ticket
            state.update(update)
        return apply

    def hold(self, identity: str, ticket: int | None = None) -> None:
        def apply(state: dict) -> None:
            if identity in self._sending:
                raise ValueError("sending")
            self._ordered(identity, ticket, {"held": True, "send_now_at": None})(state)
        self._change(identity, apply)

    def send_now(self, identity: str, ticket: int | None = None) -> None:
        self._change(identity, lambda s: self._ordered(identity, ticket, {"held": False, "send_now_at": self.clock()})(s))

    def touch(self, identity: str) -> float:
        """The person started typing: the report waits before the text is even saved."""
        return self._change(identity, lambda s: s.update(changed_at=self.clock()))["changed_at"] + self.pause

    def delivered(self, identity: str, at: float) -> None:
        """The first delivery went out with the text current at ``at``; later ones keep it."""
        self._change(identity, lambda s: s.update(delivered_at=at) if s["delivered_at"] is None else None)

    def resent(self, identity: str, at: float | None = None) -> None:
        """Send again went out with the text current at ``at`` (default now)."""
        self._change(identity, lambda s: s.update(resent_at=self.clock() if at is None else at))

    def edit(self, identity: str, field: str, text: str) -> float:
        if field not in FIELDS:
            raise ValueError("bad_field")
        value = str(text or "").strip()[:MAX_TEXT] or None  # empty means "not edited"
        state = self._change(identity, lambda s: s.update({field: value, "changed_at": self.clock()}))
        return state["changed_at"] + self.pause

    def remove(self, identity: str, key: str, removed: bool) -> float:
        if not isinstance(key, str) or not KEY.match(key):
            raise ValueError("bad_key")

        def apply(state: dict) -> None:
            keys = [k for k in state["removed"] if k != key]
            if removed:
                if len(keys) >= MAX_REMOVED:
                    raise ValueError("too_many")
                keys.append(key)
            state.update(removed=keys, changed_at=self.clock())

        return self._change(identity, apply)["changed_at"] + self.pause

    def gate(self, identity: str, ready_at: float | None) -> dict:
        return self._gate(self.read(identity), ready_at)

    def begin_send(self, identity: str, ready_at: float | None) -> float | None:
        """The gate check and the "sending" mark in one step (call end_send after): None when it is closed,
        else the moment the report's text was taken. A Hold after it answers "sending" (MEETONTRACK-163)."""
        with self.lock:
            if not self._gate(self._read(identity), ready_at)["open"]:
                return None
            self._sending.add(identity)
            return self.clock()

    def end_send(self, identity: str) -> None:
        with self.lock:
            self._sending.discard(identity)

    def _gate(self, state: dict, ready_at: float | None) -> dict:
        now = self.clock()
        changed_at, send_now_at = state["changed_at"], state["send_now_at"]
        if state["held"]:
            return {"open": False, "reason": "held", "send_at": None}
        if send_now_at is not None and (changed_at is None or changed_at <= send_now_at):
            return {"open": True, "reason": "", "send_at": None}
        if changed_at is not None and now < changed_at + self.pause:
            return {"open": False, "reason": "changes", "send_at": changed_at + self.pause}
        if ready_at is not None and now < ready_at + self.pause:
            return {"open": False, "reason": "showing", "send_at": ready_at + self.pause}
        return {"open": True, "reason": "", "send_at": None}

    def blocked(self, identity: str, ready_at: float | None) -> None:
        # ponytail: memory only; the 60 s full retry scan covers a restart.
        with self.lock:
            self._blocked[identity] = ready_at

    def due(self) -> set[str]:
        with self.lock:
            waiting = dict(self._blocked)
        opened = {identity for identity, ready_at in waiting.items() if self.gate(identity, ready_at)["open"]}
        with self.lock:
            for identity in opened:
                self._blocked.pop(identity, None)
        return opened


# report.json status field of each channel, in the order the screen lists them.
CHANNELS = (("email", "mail_status"), ("telegram", "telegram_status"),
            ("twenty", "twenty_status"), ("drive", "drive_status"))


def _iso(epoch: float | None) -> str | None:
    return None if epoch is None else datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="seconds")


def after_payload(archive, meeting_id: str, settings: dict, now: float) -> dict | None:
    """What the After screen shows for one report (GET /api/after); None for an unknown meeting.

    ``now`` is unused: the gate keeps its own clock, the one ``ready_at`` was written with.
    """
    import memo_check
    from archive import _date, _safe, auto_send_allowed
    from delivery_settings import enabled

    detail = archive.report_detail(meeting_id)
    if detail is None:
        return None
    identity = _safe(str(detail.get("meeting_id") or meeting_id))
    report = detail.get("report") if isinstance(detail.get("report"), dict) else {}
    after = archive.after.read(identity)
    ready = archive._ready_for_delivery(detail)
    matches = bool(report) and archive.report_matches(detail, report)
    ready_at = _date(str(report.get("ready_at") or ""))
    gate = archive.after.gate(identity, ready_at.timestamp() if ready_at else None)

    started = _date(str(report.get("delivery_started_at") or ""))
    # The app retries a failed channel on its own only inside the window from the first send (as retry does).
    window = started or _date(str(report.get("generated_at") or ""))
    retrying = bool(window) and (datetime.now().astimezone() - window).total_seconds() \
        <= archive.delivery_retry_days * 86400
    channels = []
    for name, field in CHANNELS:
        status = report.get(field)
        went = status in {"sent", "uploaded"}
        # The sender's own rule: a channel turned on after the call began does not send it by itself.
        if not enabled(settings, name) or status == "not_configured" or not (
                went or auto_send_allowed(settings, name, detail.get("started_at"))):
            continue
        row = {"channel": name, "to": "", "status": "failed", "at": None, "retry_at": None}
        if went:
            row.update(status="sent", at=report.get("delivery_checked_at") or None)
        elif status in {None, "pending", "waiting_for_end"}:
            row["status"] = "held" if after["held"] else "waiting"
        elif status == "needs_choice":
            row["status"] = "needs_choice"
        elif status == "unknown":
            row["status"] = "unknown"  # may already have arrived; never retried on its own (MEETONTRACK-122)
        elif status != "auth_required" and retrying:
            row["retry_at"] = report.get("delivery_retry_at") or None
        # A delivered row names where it went (recorded then); older deliveries recorded none.
        if name == "email":
            row["to"] = str((report.get("mail_to") if went else settings.get("email_to")) or "")
        elif name == "telegram":
            target = str((report.get("telegram_to") if went else settings.get("telegram_target")) or "")
            row["to"] = "" if target == "me" else target
        elif name == "twenty":
            target = report.get("twenty_target")
            row["to"] = str(target.get("name") or "") if isinstance(target, dict) else ""
        channels.append(row)

    # A CRM record the person must choose never goes on its own, so it does not hold "sent" back.
    sent = any(row["status"] == "sent" for row in channels) \
        and all(row["status"] in {"sent", "needs_choice"} for row in channels)
    # Later than the text that went: the first delivery's (precise), Send again's, else the send's start (older reports).
    went_with = [mark for mark in (after["delivered_at"], after["resent_at"]) if mark is not None] \
        or ([started.timestamp()] if started else [])
    changed = after["changed_at"]
    edited = changed is not None and all(changed > mark for mark in went_with)
    # First rule that matches; the gate's "changes" before "preparing" (ruling C10).
    if not channels:
        state = "no_channels"
    elif after["held"] and not sent:
        state = "held"
    elif sent:
        # While the edited report is made again it stays "sent": Send again comes once it is ready (H).
        state = "edited" if edited and matches else "sent"
    elif not ready:
        state = "draft"
    elif gate["reason"] == "changes":
        state = "changes"
    elif not matches:
        state = "preparing"
    elif any(row["status"] in {"failed", "unknown"} for row in channels):
        state = "failed"
    elif gate["reason"] == "showing":
        state = "showing"
    else:
        state = "sending"

    memo = memo_check.current(report.get("memo_check"), detail.get("transcript") or [])
    if not isinstance(memo, dict) or memo == memo_check.NOT_CHECKED:
        # Waiting until the check has run; "not checked" is final, and shown only with memo questions.
        memo = (memo or {"state": "waiting"}) if memo_check.memo_questions(archive.memo_plan(detail)) else None
    return {
        "ok": True, "meeting_id": identity, "title": detail.get("title") or "",
        "started_at": detail.get("started_at") or "", "ended_at": detail.get("ended_at") or "",
        "duration_seconds": detail.get("duration_seconds") or 0,
        "send": {"state": state, "send_at": _iso(gate["send_at"]), "send_now": after["send_now_at"] is not None,
                 "channels": channels},
        "summary": {"lines": archive.report_summary(detail), "edited": after["summary"] is not None, "final": ready},
        "next_steps": {"lines": archive.report_next_steps(detail), "edited": after["next_steps"] is not None,
                       "final": ready},
        "removed": list(after["removed"]),
        # report_detail leaves these out; a past meeting's After still shows them to bring back.
        "removed_journal": [{"key": f"journal:{item.get('id')}", "category": str(item.get("category") or ""),
                             "text": str(item.get("text") or "")} for item in detail.get("removed_journal", [])],
        "memo_check": memo,
    }
