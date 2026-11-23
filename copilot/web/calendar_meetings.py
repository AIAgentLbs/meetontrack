"""Read near-term Google Calendar events for cautious preparation matching."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from datetime import date, datetime, time as clock_time, timedelta


MEETING_URL_RE = re.compile(
    r"https://(?:telemost\.yandex\.ru|meet\.google\.com|zoom\.us|teams\.microsoft\.com)/[^\s<>\"']+",
    re.IGNORECASE,
)


class CalendarUnavailable(Exception):
    """The calendar could not be read (sign-in or gws failed, timed out or answered nonsense): not an empty day."""


class CalendarMeetings:
    """Cached, read-only calendar lookup; never stores event descriptions."""

    def __init__(self, executable: str | None = None, enabled=None, oauth=None) -> None:
        # oauth: returns the app's own Google sign-in (GoogleOAuth) or None. When it is connected the calendar is
        # read through it; the gws default profile is only the fallback without one (MEETONTRACK-183).
        self.oauth = oauth
        self.executable = executable if executable is not None else shutil.which("gws")
        self._look_up = executable is None  # found on PATH: looked up again until it is there
        self.enabled = enabled
        self._cache: dict[str, tuple[float, list[dict] | None]] = {}  # None: the read failed
        self._lock = threading.Lock()

    def _signed_in(self):
        oauth = self.oauth() if self.oauth else None
        try:
            return oauth if oauth is not None and oauth.status().get("state") == "connected" else None
        except (OSError, ValueError):  # credential store unreadable: treated as no sign-in
            return None

    def available(self) -> bool:
        return bool(self.executable or self._signed_in()) and (self.enabled is None or bool(self.enabled()))

    def state(self) -> str:
        if self._signed_in() is not None:
            return "not_connected" if self.enabled is not None and not self.enabled() else "connected"
        if not self.executable and self._look_up:
            self.executable = shutil.which("gws")  # installed after start (Home's Check again)
        if not self.executable:
            return "tool_missing"
        return "not_connected" if self.enabled is not None and not self.enabled() else "connected"

    def for_day(self, day: date) -> list[dict]:
        if self.enabled is not None and not self.enabled():
            return []
        key = day.isoformat()
        with self._lock:
            cached = self._cache.get(key)
            # A failed read is kept briefly so a poll during a call does not start gws every few seconds.
            if cached and cached[1] is None and time.monotonic() - cached[0] < 15:
                raise CalendarUnavailable()
            if cached and cached[1] is not None and time.monotonic() - cached[0] < 120:
                return list(cached[1])
        oauth = self._signed_in()
        if oauth is None and not self.executable:
            return []
        start = datetime.combine(day, clock_time.min).astimezone()
        end = datetime.combine(day + timedelta(days=1), clock_time.min).astimezone()
        params = {
            "calendarId": "primary", "timeMin": start.isoformat(),
            "timeMax": end.isoformat(), "singleEvents": True,
            "maxResults": 100,
            "fields": "items(id,summary,start,end,location,description,hangoutLink,attendees(email,displayName,self,resource))",
        }
        events: list[dict] = []
        try:
            if oauth is not None:
                from google_api import read
                payload = read(oauth, ("calendar", "events", "list"), params)
            else:
                result = subprocess.run(
                    [self.executable, "calendar", "events", "list", "--params", json.dumps(params)],
                    capture_output=True, text=True, timeout=5, check=False,
                )
                payload = json.loads(result.stdout) if result.returncode == 0 else None
            if not isinstance(payload, dict):
                raise ValueError("no calendar answer")
            raw_items = payload.get("items", [])
            if not isinstance(raw_items, list):
                raw_items = []
            for raw in raw_items[:100]:
                if not isinstance(raw, dict):
                    continue
                try:
                    event_start = datetime.fromisoformat(raw["start"]["dateTime"])
                    event_end = datetime.fromisoformat(raw["end"]["dateTime"])
                except (KeyError, TypeError, ValueError):
                    continue
                if event_start.tzinfo is None or event_end.tzinfo is None:
                    continue
                location = " ".join(str(raw.get(k) or "") for k in ("location", "description", "hangoutLink"))
                match = MEETING_URL_RE.search(location)
                events.append({
                    "id": str(raw.get("id") or "")[:1024],
                    "title": str(raw.get("summary") or "")[:250],
                    "start": event_start.isoformat(), "end": event_end.isoformat(),
                    "link": match.group(0).rstrip("/.,);") if match else "",
                    # Attendees as the calendar gives them (no response status or comments).
                    "attendees": [
                        {"email": str(person.get("email") or "")[:200],
                         "name": str(person.get("displayName") or "")[:200],
                         "self": bool(person.get("self")),
                         "resource": bool(person.get("resource"))}
                        for person in (raw.get("attendees") or [])[:50] if isinstance(person, dict)
                    ] if isinstance(raw.get("attendees"), list) else [],
                })
        except (OSError, subprocess.TimeoutExpired, ValueError) as error:
            with self._lock:
                self._cache[key] = (time.monotonic(), None)
            raise CalendarUnavailable() from error
        with self._lock:
            self._cache[key] = (time.monotonic(), events)
        return list(events)
