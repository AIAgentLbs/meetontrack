"""The person's choices for one report after the call, and the send gate.

One file per report folder, ``<reports root>/<identity>/after.json``: hold,
send now, edited summary and next steps, board items left out of the report.
The gate tells the archive whether an automatic send may go now
(MEETONTRACK-163).
"""

from __future__ import annotations

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
            "summary": None, "next_steps": None, "removed": [], "resent_at": None}


class AfterState:
    def __init__(self, root: Path, clock: Callable[[], float] = time.time, pause: float = 30.0):
        self.root = Path(root)
        self.clock = clock
        self.pause = pause
        self.lock = threading.Lock()
        self._blocked: dict[str, float | None] = {}

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
        for key in ("send_now_at", "changed_at", "resent_at"):
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

    def hold(self, identity: str) -> None:
        self._change(identity, lambda s: s.update(held=True, send_now_at=None))

    def send_now(self, identity: str) -> None:
        self._change(identity, lambda s: s.update(held=False, send_now_at=self.clock()))

    def resent(self, identity: str) -> None:
        self._change(identity, lambda s: s.update(resent_at=self.clock()))

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
        state = self.read(identity)
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
    from archive import _date, _safe
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

    on = [name for name, _ in CHANNELS if enabled(settings, name)]
    channels = []
    for name, field in CHANNELS:
        status = report.get(field)
        if name not in on or status == "not_configured":
            continue
        row = {"channel": name, "to": "", "status": "failed", "at": None, "retry_at": None}
        if status in {"sent", "uploaded"}:
            row.update(status="sent", at=report.get("delivery_checked_at") or None)
        elif status in {None, "pending", "waiting_for_end"}:
            row["status"] = "held" if after["held"] else "waiting"
        elif status == "needs_choice":
            row["status"] = "needs_choice"
        else:
            row["retry_at"] = report.get("delivery_retry_at") or None
        if name == "email":
            row["to"] = str(settings.get("email_to") or "")
        elif name == "telegram":
            target = str(settings.get("telegram_target") or "")
            row["to"] = "" if target == "me" else target
        elif name == "twenty":
            target = report.get("twenty_target")
            row["to"] = str(target.get("name") or "") if isinstance(target, dict) else ""
        channels.append(row)

    sent = bool(channels) and all(row["status"] == "sent" for row in channels)
    changed, resent = after["changed_at"], after["resent_at"]
    started = _date(str(report.get("delivery_started_at") or ""))
    edited = changed is not None and (not started or changed > started.timestamp()) \
        and (resent is None or changed > resent)
    # First rule that matches; the gate's "changes" before "preparing" (ruling C10).
    if not on:
        state = "no_channels"
    elif after["held"] and not sent:
        state = "held"
    elif sent:
        state = ("edited" if matches else "preparing") if edited else "sent"
    elif not ready:
        state = "draft"
    elif gate["reason"] == "changes":
        state = "changes"
    elif not matches:
        state = "preparing"
    elif any(row["status"] == "failed" for row in channels):
        state = "failed"
    elif gate["reason"] == "showing":
        state = "showing"
    else:
        state = "sending"

    memo = report.get("memo_check")
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
        "memo_check": memo,
    }
