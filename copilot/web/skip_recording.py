"""Calls the person chose not to record, in a file both recorders read before they start."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime
from pathlib import Path

from private_dirs import private_dir


def _zoned(value) -> datetime:
    """An ISO time with a zone, else ValueError with a fixed message (the input is never echoed)."""
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        moment = None
    if moment is None or moment.tzinfo is None:
        raise ValueError("A call time must be an ISO time with a time zone.")
    return moment


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

    def set(self, meeting: dict, skip: bool, now: datetime) -> None:
        start, end = _zoned(meeting.get("start")), _zoned(meeting.get("end"))
        if not start < end:
            raise ValueError("A call must end after it starts.")
        key = self.key(meeting)

        def current(call: dict) -> bool:
            try:
                return call["key"] != key and _zoned(call.get("end")) > now
            except ValueError:
                return False

        with self.lock:
            calls = [call for call in self._calls() if current(call)]
            if skip:
                calls.append({"key": key, "event_id": str(meeting.get("event_id") or ""),
                              "start": meeting["start"], "end": meeting["end"]})
            private_dir(self.path.parent)
            handle, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".skip-recording-")  # 0600
            try:
                with os.fdopen(handle, "w", encoding="utf-8") as stream:
                    json.dump({"version": 1, "calls": calls}, stream, ensure_ascii=False)
                os.replace(temporary, self.path)
            finally:
                Path(temporary).unlink(missing_ok=True)
