"""Stop pauses the recorder at once; the real `record stop` lands after the undo window.

After `record stop` there is nothing to resume, so Stop pauses first and stops for good `grace`
seconds later. The pending stop lives on disk, so a closed window or a
restarted server still ends the recording. Contract: "Recording control (plan 3)".
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from private_dirs import private_dir


RETRY_SECONDS = 5  # a deferred stop the recorder did not acknowledge is sent again this often
REFUSED = 3  # `record --session` exit code: the recorder is live with another session (fix wave J1)
# A recorder from before J1 rejects the option itself (ArgumentParser: exit 64, "Unknown option '--session'").
UNKNOWN_SESSION = re.compile(r"unknown option|unexpected argument|unknown verb", re.IGNORECASE)
log = logging.getLogger("recording_control")


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds).astimezone().isoformat(timespec="seconds")


class RecordingControl:
    """`current_meeting()` is the call the page shows. `session(meeting_id)` is the recorder's own live
    session for that call, read from the file the recorder writes at the moment of asking ("" once it
    ended or another recording began, None when the file cannot be read): pause, resume and the deferred
    stop act only on that session, and an unknown session is never taken for an ended one."""

    def __init__(self, binary: Path, path: Path, current_meeting: Callable[[], str],
                 session: Callable[[str], str | None], run=subprocess.run, clock=time.time, grace: float = 30.0):
        self.binary, self.path, self.current_meeting, self.session = binary, path, current_meeting, session
        self.run, self.clock, self.grace = run, clock, grace
        # One lock for every check-and-clear of `stopping`, held across the recorder command,
        # so at the window's edge exactly one of resume and the deferred stop wins. Readers take no
        # lock: `stopping` and `last_stop` are only ever replaced whole, never changed in place, so the
        # state poll never waits for a recorder command (fix wave I3).
        self.lock = threading.Lock()
        self.stopping, self.last_stop = None, None
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            if saved.get("version") == 1:
                self.stopping, self.last_stop = saved.get("stopping"), saved.get("last_stop")
        except (OSError, ValueError, AttributeError):
            pass

    def _command(self, verb: str, session: str | None) -> bool | None:
        """True: done. None: refused, the recorder's live session is not `session` (that recording is
        over). False: no answer. The recorder checks the session itself, under its own state, so a
        command can never land on a call that began after the live file was read."""
        argv = [str(self.binary), "record", verb]
        if session:
            argv += ["--session", session.split("|")[0]]  # the live file's meeting_id
        try:
            done = self.run(argv, capture_output=True, text=True, timeout=10, check=False)
        except (OSError, subprocess.SubprocessError):
            return False
        if session and done.returncode not in (0, REFUSED) and UNKNOWN_SESSION.search(
                f"{getattr(done, 'stdout', '') or ''}{getattr(done, 'stderr', '') or ''}"):
            # M2: mid-upgrade, an older recorder has no sessions; the bare verb is exactly what it did before J1.
            log.warning("the recorder does not know --session (an older version): sending the bare `record %s`", verb)
            return self._command(verb, None)
        return True if done.returncode == 0 else None if done.returncode == REFUSED else False

    def _save(self, stopping: dict | None | bool = True) -> None:
        """Writes the state; `stopping` other than True writes that instead of the one in memory."""
        private_dir(self.path.parent)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"version": 1, "stopping": self.stopping if stopping is True else stopping,
                                         "last_stop": self.last_stop}), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, self.path)

    def _same(self, pending: dict) -> bool | None:
        """Is the recording the pending stop was made for still the recorder's live one? None: unknown."""
        expected = pending.get("session")  # a state file from before sessions: the page's id only
        if not expected:
            return self.current_meeting() == pending["meeting_id"]
        live = self.session(pending["meeting_id"])
        return None if live is None else live == expected

    def _ended(self, pending: dict) -> None:
        # last_stop first: a poll between the two writes never sees neither, so never the live bar (K2).
        self.last_stop = {"meeting_id": pending["meeting_id"], "stopped_at": pending["stopped_at"]}
        self.stopping = None

    def stop(self, meeting_id: str) -> dict:
        if meeting_id != self.current_meeting():
            raise ValueError("meeting_changed")
        with self.lock:
            pending = self.stopping
            if pending and pending.get("meeting_id") == meeting_id:
                if not pending.get("failed"):
                    return {"stopped_at": pending["stopped_at"], "until": pending["until"]}
                # The deferred stop keeps failing: Stop pressed again tries it now, for this recording only.
                # Unknown (an unreadable live file) still sends it: the recorder judges the session (K1).
                if self._same(pending) is not False and self._command("stop", pending.get("session")) is False:
                    raise RuntimeError("stop_failed")
                self._ended(pending)
                self._save()
                return {"stopped_at": pending["stopped_at"], "until": None}
            session = self.session(meeting_id)
            if session is None:  # the live file cannot be read: no command for a session nobody can name
                raise RuntimeError("stop_failed")
            if not session:  # the poll still shows this call, the recorder has moved on
                raise ValueError("meeting_changed")
            stopped_at = _iso(self.clock())
            paused = self._command("pause", session)
            if paused is None:
                raise ValueError("meeting_changed")
            if paused:
                until = _iso(datetime.fromisoformat(stopped_at).timestamp() + self.grace)
                self.stopping = {"meeting_id": meeting_id, "session": session, "stopped_at": stopped_at, "until": until}
                try:
                    self._save()
                    return {"stopped_at": stopped_at, "until": until}
                except OSError:  # a pending stop a restart would forget leaves the recorder paused: stop now
                    pass
            # A recorder that cannot pause (or an unwritable state file) stops for good, no undo.
            stopped = self._command("stop", session)
            if stopped is None:
                raise ValueError("meeting_changed")
            if not stopped:
                raise RuntimeError("stop_failed")  # a paused recorder keeps its pending stop in memory
            self.last_stop, self.stopping = {"meeting_id": meeting_id, "stopped_at": stopped_at}, None
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
            if (not pending or pending.get("meeting_id") != meeting_id or pending.get("failed")
                    or self.clock() >= datetime.fromisoformat(pending["until"]).timestamp()):
                raise ValueError("too_late")
            same = self._same(pending)
            if same is None:  # unknown: keep the pending stop, the person can try again
                raise RuntimeError("resume_failed")
            if not same:  # that recording ended and another may run: resume nothing
                self._ended(pending)
                try:
                    self._save()
                except OSError:
                    pass
                raise ValueError("meeting_changed")
            # Cleared on disk before the recorder resumes: a restart must never stop a resumed call. Polls keep
            # seeing the stop until the recorder answers, so a slow resume never shows the live bar early (M3).
            try:
                self._save(stopping=None)
            except OSError:
                raise RuntimeError("resume_failed") from None  # a code, never the OS text with the path
            resumed = self._command("resume", pending.get("session"))
            if resumed is None:  # the recorder is live with another call: that recording is over
                self._ended(pending)
                try:
                    self._save()
                except OSError:
                    pass
                raise ValueError("meeting_changed")
            if not resumed:
                try:
                    self._save()
                except OSError:
                    pass  # memory stays authoritative while the server runs
                raise RuntimeError("resume_failed")
            self.stopping = None

    def tick(self) -> None:
        with self.lock:
            pending = self.stopping
            if not pending or self.clock() < datetime.fromisoformat(pending["until"]).timestamp():
                return
            # The recording may have ended by itself and the next call begun: then there is nothing to stop.
            # An unreadable live file is unknown, not ended: tried again like an unacknowledged stop.
            same = self._same(pending)
            if same is None or (same and self._command("stop", pending.get("session")) is False):
                # Not acknowledged (the app busy, or not running): kept pending and tried again in 5 s, so
                # last_stop never claims a stop that did not happen; the page shows the failure meanwhile.
                self.stopping = {**pending, "failed": int(pending.get("failed") or 0) + 1,
                                 "until": _iso(self.clock() + RETRY_SECONDS)}
            else:
                self._ended(pending)
            self._save()

    def loop(self, stop_event: threading.Event) -> None:
        while not stop_event.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the next tick retries; the loop must outlive one bad read
                pass
            stop_event.wait(1)

    def snapshot(self) -> dict:
        stopping, last_stop = self.stopping, self.last_stop
        return {"stopping": stopping and dict(stopping), "last_stop": last_stop and dict(last_stop)}
