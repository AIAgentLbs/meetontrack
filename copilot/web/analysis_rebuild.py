"""Rebuilding Call overview analysis of a finished meeting (MEETONTRACK-107).

The live analysis reads only the live transcript, so when the AI fails during a meeting its
analysis is lost. A failed live run marks the meeting; the mark is kept on disk, and the meeting
is rebuilt from its stored transcript once the chosen AI works again (or the owner asks).
"""
import hashlib
import json
import threading
from datetime import datetime

from archive import _atomic_json, _json

WINDOW = 14000  # transcript characters per analysis: the live analysis window


class Paused(Exception):
    """A meeting started recording: the rebuild stops between chunks and resumes later."""


def _parts(segment: dict, line, size: int) -> list[dict]:
    """A segment whose line alone is longer than `size`, as consecutive parts that each fit, with
    stable ids (id#0, id#1...) so their progress is kept like any chunk's."""
    room = size - len(line({**segment, "text": ""})) - 1
    text = str(segment.get("text") or "")
    if len(line(segment)) + 1 <= size or room <= 0:
        return [segment]
    identity = str(segment.get("id") or segment.get("timestamp") or "")
    return [{**segment, "id": f"{identity}#{number}", "text": text[start:start + room]}
            for number, start in enumerate(range(0, len(text), room))]


def transcript_chunks(segments: list[dict], line, size: int = WINDOW) -> list[list[dict]]:
    """Consecutive segments in windows of at most `size` characters of rendered lines."""
    chunks, current, length = [], [], 0
    for segment in (part for item in segments for part in _parts(item, line, size)):
        cost = len(line(segment)) + 1
        if current and length + cost > size:
            chunks.append(current)
            current, length = [], 0
        current.append(segment)
        length += cost
    return chunks + [current] if current else chunks


def chunk_key(segments: list[dict]) -> str:
    """A chunk by its segments' identity and words, not speaker labels: renaming a speaker
    does not make an analysed chunk run again."""
    material = json.dumps([[str(item.get("id") or item.get("timestamp") or ""), str(item.get("text") or "")]
                           for item in segments], ensure_ascii=False)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def transcript_signature(segments: list[dict]) -> str:
    """The final transcript a rebuild read: a rebuild done for another one is pending again."""
    return chunk_key([item for item in segments if not item.get("provisional")])


class AnalysisRebuilds:
    """Per meeting {"state": needed|running|done|error, "chunks": [analysed keys], "done", "total",
    "message", "at", "from", "source"}. `rebuild(meeting_id, skip, progress)` does the work and
    returns the transcript_signature it read; it raises LookupError when the meeting no longer exists."""
    RETRY, MAX_RETRY = 300, 7200

    def __init__(self, path, rebuild=None):
        self.path, self.rebuild = path, rebuild
        self.lock = threading.Lock()  # state
        self.run_lock = threading.Lock()  # one rebuild at a time
        self.wake = threading.Event()
        self.analysed_to: dict[str, int] = {}  # ponytail: in memory, a restart mid-meeting may rebuild more than lost
        payload = _json(path, {})
        meetings = payload.get("meetings") if isinstance(payload, dict) else None
        self.meetings = {key: value for key, value in (meetings or {}).items() if isinstance(value, dict)}
        for item in self.meetings.values():
            if item.get("state") == "running":
                item["state"] = "needed"  # cut short by a restart

    def _save_locked(self) -> None:
        _atomic_json(self.path, {"version": 1, "meetings": self.meetings})

    def _update(self, meeting_id: str, **values) -> None:
        with self.lock:
            before = self.meetings.get(meeting_id)
            item = dict(before or {"chunks": [], "from": 0})
            item.update(values, at=datetime.now().astimezone().isoformat(timespec="seconds"))
            self.meetings[meeting_id] = item
            try:
                self._save_locked()
            except Exception:  # not saved: memory keeps what the file says, so a retry still sees it
                if before is None:
                    del self.meetings[meeting_id]
                else:
                    self.meetings[meeting_id] = before
                raise

    def snapshot(self, meeting_id: str, source: str = "") -> dict:
        """`source`: the meeting's transcript_signature now; a rebuild of an earlier transcript
        (final import, retranscription) shows as needed. Its analysed chunks are not sent again."""
        with self.lock:
            item = dict(self.meetings.get(meeting_id) or {"state": "idle"})
        item.pop("chunks", None)
        if source and item["state"] == "done" and item.get("source") and item["source"] != source:
            item["state"] = "needed"
        return item

    def pending(self) -> list[str]:
        with self.lock:
            return [key for key, item in self.meetings.items() if item.get("state") in {"needed", "error"}]

    def analysed(self, meeting_id: str, start: int, end: int) -> None:
        """A live analysis read characters start..end. When a marked meeting's later window reaches
        back to what was analysed before the failure, nothing was lost and the mark goes."""
        if not meeting_id:
            return
        with self.lock:
            item = self.meetings.get(meeting_id)
            if item and item.get("state") == "needed" and not item.get("chunks") and start <= item.get("from", 0):
                del self.meetings[meeting_id]
                self._save_locked()
            self.analysed_to[meeting_id] = end

    def failed(self, meeting_id: str) -> None:
        """A live analysis of this meeting failed: what it read is lost until a rebuild."""
        if not meeting_id:
            return
        with self.lock:
            item = self.meetings.setdefault(meeting_id, {"chunks": [], "from": self.analysed_to.get(meeting_id, 0)})
            if item.get("state") != "running":
                item["state"] = "needed"
            item["at"] = datetime.now().astimezone().isoformat(timespec="seconds")
            self._save_locked()

    def _progress(self, meeting_id: str, key: str, done: int, total: int) -> None:
        with self.lock:
            item = self.meetings[meeting_id]
            if key not in item["chunks"]:
                item["chunks"].append(key)
            item.update(done=done, total=total)
            self._save_locked()

    def _run_locked(self, meeting_id: str, busy=lambda: False) -> bool:
        def progress(key, done, total):
            self._progress(meeting_id, key, done, total)
            if done < total and busy():
                raise Paused
        try:
            with self.lock:
                skip = set(self.meetings.get(meeting_id, {}).get("chunks", []))
            source = self.rebuild(meeting_id, skip, progress)
            self._update(meeting_id, state="done", message="", source=source if isinstance(source, str) else "")
            return True
        except Paused:  # analysed chunks are kept; the rest follows when nothing is recording
            self._update(meeting_id, state="needed", message="")
            return True
        except LookupError:
            with self.lock:
                self.meetings.pop(meeting_id, None)  # the meeting is gone: nothing to rebuild
                self._save_locked()
            return True
        except Exception as error:  # the AI failed: the meeting stays marked for the next attempt
            self._update(meeting_id, state="error", message=str(error)[:300])
            return False
        finally:
            with self.lock:
                item = self.meetings.get(meeting_id)
                if item and item.get("state") == "running":  # its final state could not be saved
                    item["state"] = "needed"
            self.run_lock.release()

    def start(self, meeting_id: str) -> None:
        """Rebuild in the background; the state shows progress."""
        if not self.run_lock.acquire(blocking=False):
            raise ValueError("An analysis is already being built. Wait for it to finish")
        try:
            self._update(meeting_id, state="running", message="")
        except Exception:
            self.run_lock.release()
            raise
        threading.Thread(target=self._run_locked, args=(meeting_id,), name="analysis-rebuild", daemon=True).start()

    def run(self, meeting_id: str, busy=lambda: False) -> bool:
        """Rebuild now, waiting for any other rebuild; False when the AI failed. Stops between
        chunks once `busy()` (a meeting is recording)."""
        self.run_lock.acquire()
        try:
            self._update(meeting_id, state="running", message="")
        except Exception:
            self.run_lock.release()
            raise
        return self._run_locked(meeting_id, busy)

    def loop(self, stop: threading.Event, busy=lambda: False) -> None:
        """Retry marked meetings while no meeting is recording: every 5 minutes, doubling after a
        failure up to 2 hours, and at once when woken (the owner checked the AI)."""
        delay = self.RETRY
        while not stop.is_set():
            if self.wake.wait(delay):
                delay = self.RETRY
            self.wake.clear()
            ok = True
            for meeting_id in self.pending():
                if stop.is_set() or busy():
                    break
                try:
                    ok = self.run(meeting_id, busy)
                except Exception as error:  # e.g. the state file cannot be written: keep the worker alive
                    print(f"analysis rebuild failed: {type(error).__name__}: {error}", flush=True)
                    ok = False
                if not ok:
                    break  # the AI fails: the others would fail the same way
            delay = self.RETRY if ok else min(delay * 2, self.MAX_RETRY)
