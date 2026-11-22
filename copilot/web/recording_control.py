"""Stop pauses the recorder at once; the real `record stop` lands after the undo window.

After `record stop` there is nothing to resume, so Stop pauses first and stops for good `grace`
seconds later. The pending stop lives on disk, so a closed window or a
restarted server still ends the recording. Contract: "Recording control (plan 3)".
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from private_dirs import private_dir


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds).astimezone().isoformat(timespec="seconds")


class RecordingControl:
    """`current_meeting()` is the call the page shows. `session(meeting_id)` is the recorder's own live
    session for that call, read from the file the recorder writes at the moment of asking ("" once it
    ended or another recording began): pause, resume and the deferred stop act only on that session."""

    def __init__(self, binary: Path, path: Path, current_meeting: Callable[[], str],
                 session: Callable[[str], str], run=subprocess.run, clock=time.time, grace: float = 30.0):
        self.binary, self.path, self.current_meeting, self.session = binary, path, current_meeting, session
        self.run, self.clock, self.grace = run, clock, grace
        # One lock for every check-and-clear of `stopping`, held across the recorder command,
        # so at the window's edge exactly one of resume and the deferred stop wins.
        self.lock = threading.Lock()
        self.stopping, self.last_stop = None, None
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            if saved.get("version") == 1:
                self.stopping, self.last_stop = saved.get("stopping"), saved.get("last_stop")
        except (OSError, ValueError, AttributeError):
            pass

    def _command(self, verb: str) -> bool:
        try:
            done = self.run([str(self.binary), "record", verb],
                            capture_output=True, text=True, timeout=10, check=False)
        except (OSError, subprocess.SubprocessError):
            return False
        return done.returncode == 0

    def _save(self) -> None:
        private_dir(self.path.parent)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(
            {"version": 1, "stopping": self.stopping, "last_stop": self.last_stop}), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, self.path)

    def _same(self, pending: dict) -> bool:
        """Is the recording the pending stop was made for still the recorder's live one?"""
        expected = pending.get("session")  # a state file from before sessions: the page's id only
        return self.session(pending["meeting_id"]) == expected if expected else \
            self.current_meeting() == pending["meeting_id"]

    def _ended(self, pending: dict) -> None:
        self.stopping = None
        self.last_stop = {"meeting_id": pending["meeting_id"], "stopped_at": pending["stopped_at"]}

    def stop(self, meeting_id: str) -> dict:
        if meeting_id != self.current_meeting():
            raise ValueError("meeting_changed")
        with self.lock:
            pending = self.stopping
            if pending and pending.get("meeting_id") == meeting_id:
                return {"stopped_at": pending["stopped_at"], "until": pending["until"]}
            session = self.session(meeting_id)
            if not session:  # the poll still shows this call, the recorder has moved on
                raise ValueError("meeting_changed")
            stopped_at = _iso(self.clock())
            if self._command("pause"):
                until = _iso(datetime.fromisoformat(stopped_at).timestamp() + self.grace)
                self.stopping = {"meeting_id": meeting_id, "session": session, "stopped_at": stopped_at, "until": until}
                try:
                    self._save()
                    return {"stopped_at": stopped_at, "until": until}
                except OSError:  # a pending stop a restart would forget leaves the recorder paused: stop now
                    pass
            # A recorder that cannot pause (or an unwritable state file) stops for good, no undo.
            if not self._command("stop"):
                raise RuntimeError("stop_failed")  # a paused recorder keeps its pending stop in memory
            self.stopping, self.last_stop = None, {"meeting_id": meeting_id, "stopped_at": stopped_at}
            try:
                self._save()
            except OSError:
                pass  # nothing pending is lost: the recording has already ended
            return {"stopped_at": stopped_at, "until": None}

    def resume(self, meeting_id: str) -> None:
        if meeting_id != self.current_meeting():
            raise ValueError("meeting_changed")
        with self.lock:
            pending = self.stopping
            if (not pending or pending.get("meeting_id") != meeting_id
                    or self.clock() >= datetime.fromisoformat(pending["until"]).timestamp()):
                raise ValueError("too_late")
            if not self._same(pending):  # that recording ended and another may run: resume nothing
                self._ended(pending)
                try:
                    self._save()
                except OSError:
                    pass
                raise ValueError("meeting_changed")
            # Cleared on disk before the recorder resumes: a restart must never stop a resumed call.
            self.stopping = None
            try:
                self._save()
            except OSError:
                self.stopping = pending
                raise RuntimeError("resume_failed") from None  # a code, never the OS text with the path
            if not self._command("resume"):
                self.stopping = pending
                try:
                    self._save()
                except OSError:
                    pass  # memory stays authoritative while the server runs
                raise RuntimeError("resume_failed")

    def tick(self) -> None:
        with self.lock:
            pending = self.stopping
            if not pending or self.clock() < datetime.fromisoformat(pending["until"]).timestamp():
                return
            same_call = self._same(pending)
            self._ended(pending)
            if same_call:  # the recording may have ended by itself and the next call begun
                self._command("stop")  # a failure means it already ended: nothing to undo
            self._save()

    def loop(self, stop_event: threading.Event) -> None:
        while not stop_event.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the next tick retries; the loop must outlive one bad read
                pass
            stop_event.wait(1)

    def snapshot(self) -> dict:
        with self.lock:
            return {"stopping": self.stopping and dict(self.stopping),
                    "last_stop": self.last_stop and dict(self.last_stop)}
