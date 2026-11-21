"""Calls the person chose not to record, in a file both recorders read before they start."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timedelta
from pathlib import Path

from private_dirs import private_dir

# The recorders count a call from five minutes before its start (SkipRecording.swift / .cs `lead`).
LEAD = timedelta(minutes=5)
# An ended call stays a day: a recorder holding its skip through an overrun keeps it until the mic is let go,
# and drops it only when the call is gone from the file (Undo).
KEEP = timedelta(days=1)


def _zoned(value) -> datetime:
    """An ISO time with a zone, else ValueError with a fixed message (the input is never echoed)."""
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        moment = None
    if moment is None or moment.tzinfo is None:
        raise ValueError("A call time must be an ISO time with a time zone.")
    return moment


def is_call(meeting: dict) -> bool:
    """Someone else is invited, or there is a call link: a solo calendar block is not a call (home.js homeIsCall)."""
    return any(isinstance(person, dict) and not person.get("self") for person in meeting.get("attendees") or []) \
        or bool(meeting.get("link"))


def covers(meeting: dict, now: datetime) -> bool:
    """The recorders already count `now` as this call."""
    return _zoned(meeting.get("start")) - LEAD <= now < _zoned(meeting.get("end"))


def _clipped(calls: list[dict], meetings, restore: bool) -> list[dict]:
    """Each skip ends five minutes before the next call that is not skipped, so joining that call early records it.
    The end the person chose stays in `scheduled_end`. A shortened skip gets its window back only with `restore`
    (a connected calendar that read both days no longer has the call that shortened it); a partial read or a
    calendar turned off keeps the shorter skip. A call inside a skip without its own calendar event stays skipped."""
    skipped = {call["key"] for call in calls}
    starts = []
    for meeting in meetings:
        if SkipRecording.key(meeting) in skipped or not is_call(meeting):
            continue
        try:
            starts.append(_zoned(meeting.get("start")) - LEAD)
        except ValueError:
            continue
    result = []
    for call in calls:
        try:
            start, end = _zoned(call.get("start")), _zoned(call.get("scheduled_end") or call.get("end"))
            current = _zoned(call.get("end")) if not restore else end
        except ValueError:
            result.append(call)
            continue
        limit = min((moment for moment in starts if start < moment < current), default=current)
        result.append({**call, "end": limit.isoformat(), "scheduled_end": end.isoformat()})
    return result


class SkipRecording:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()

    @staticmethod
    def key(meeting: dict) -> str:
        return str(meeting.get("event_id") or "") or f'{meeting.get("start", "")}|{meeting.get("title", "")}'

    def _calls(self) -> list[dict]:
        """The stored calls; a missing, unreadable or wrong-shaped file holds none."""
        try:
            calls = json.loads(self.path.read_text(encoding="utf-8")).get("calls")
        except (OSError, ValueError, AttributeError):
            return []
        return [call for call in calls if isinstance(call, dict) and isinstance(call.get("key"), str)] \
            if isinstance(calls, list) else []

    def skipped(self, meeting: dict) -> bool:
        key = self.key(meeting)
        return any(call["key"] == key for call in self._calls())

    def set(self, meeting: dict, skip: bool, now: datetime, meetings=(), restore: bool = False) -> None:
        """Store or drop one call's skip; `meetings` (the days of the agenda that loaded) end every skip before the
        next call, and `restore` (see _clipped) lets a shortened skip have its window back."""
        start, end = _zoned(meeting.get("start")), _zoned(meeting.get("end"))
        if not start < end:
            raise ValueError("A call must end after it starts.")
        key = self.key(meeting)

        def current(call: dict) -> bool:
            try:
                return call["key"] != key and _zoned(call.get("scheduled_end") or call.get("end")) > now - KEEP
            except ValueError:
                return False

        with self.lock:
            calls = [call for call in self._calls() if current(call)]
            if skip:
                calls.append({"key": key, "event_id": str(meeting.get("event_id") or ""),
                              "start": meeting["start"], "end": meeting["end"], "scheduled_end": meeting["end"]})
            self._write(_clipped(calls, meetings, restore))

    def clip(self, meetings, restore: bool = False) -> None:
        """End stored skips before a call booked after them, or give a skip its window back when that call is gone;
        writes only when something changes."""
        with self.lock:
            calls = self._calls()
            clipped = _clipped(calls, meetings, restore)
            if clipped != calls:
                self._write(clipped)

    def _write(self, calls: list[dict]) -> None:
        private_dir(self.path.parent)
        handle, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".skip-recording-")  # 0600
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump({"version": 1, "calls": calls}, stream, ensure_ascii=False)
            os.replace(temporary, self.path)
        finally:
            Path(temporary).unlink(missing_ok=True)
