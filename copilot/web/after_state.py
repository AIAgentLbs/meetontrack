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
        if not isinstance(state["removed"], list):
            state["removed"] = []
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
