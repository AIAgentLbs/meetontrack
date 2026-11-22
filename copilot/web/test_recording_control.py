import http.client
import json
import tempfile
import threading
import unittest
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from recording_control import RecordingControl

T0 = 1_800_000_000.0
PAUSE, STOP, RESUME = ("record", "pause"), ("record", "stop"), ("record", "resume")


def seconds(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


class Recorder:
    """Fake subprocess.run: records the verb, answers with the exit code set for it."""

    def __init__(self, codes=None, block=None):
        self.codes, self.block, self.calls, self.argv = codes or {}, block, [], []
        self.entered, self.release = threading.Event(), threading.Event()

    def __call__(self, argv, **kwargs):
        verb = tuple(argv[1:3])
        self.calls.append(verb)
        self.argv.append(list(argv[1:]))
        if verb == self.block:
            self.entered.set()
            self.release.wait(5)
        return SimpleNamespace(returncode=self.codes.get(verb, 0))


class RecordingControlTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "state" / "recording-stop.json"
        self.now = [T0]
        self.meeting = ["m1"]
        # The recorder's own live session per call, as its live file says now ("" once it ended or moved on).
        self.sessions = {"m1": "m1|t1", "m2": "m2|t2"}

    def tearDown(self):
        self.directory.cleanup()

    def control(self, run):
        return RecordingControl(Path("/opt/capture"), self.path, lambda: self.meeting[0],
                                lambda meeting_id: self.sessions.get(meeting_id, ""),
                                run=run, clock=lambda: self.now[0])

    def test_stop_pauses_and_schedules(self):
        run = Recorder()
        control = self.control(run)
        result = control.stop("m1")
        self.assertEqual(run.calls, [PAUSE])
        self.assertEqual(seconds(result["until"]) - seconds(result["stopped_at"]), 30)
        self.assertEqual(control.snapshot()["stopping"]["meeting_id"], "m1")
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["stopping"], {"meeting_id": "m1", "session": "m1|t1", **result})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_tick_sends_stop_when_due(self):
        run = Recorder()
        control = self.control(run)
        stopped_at = control.stop("m1")["stopped_at"]
        self.now[0] = T0 + 29
        control.tick()
        self.assertEqual(run.calls, [PAUSE])
        self.now[0] = T0 + 31
        control.tick()
        self.assertEqual(run.calls, [PAUSE, STOP])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"], {"meeting_id": "m1", "stopped_at": stopped_at})

    def test_resume_within_window(self):
        run = Recorder()
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 10
        control.resume("m1")
        self.now[0] = T0 + 40
        control.tick()
        self.assertEqual(run.calls, [PAUSE, RESUME])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertIsNone(json.loads(self.path.read_text())["stopping"])

    def test_resume_too_late(self):
        run = Recorder()
        control = self.control(run)
        with self.assertRaisesRegex(ValueError, "too_late"):
            control.resume("m1")  # nothing pending
        control.stop("m1")
        self.now[0] = T0 + 31
        with self.assertRaisesRegex(ValueError, "too_late"):
            control.resume("m1")
        self.assertEqual(run.calls, [PAUSE])

    def test_resume_for_another_meeting_is_refused(self):
        run = Recorder()
        control = self.control(run)
        control.stop("m1")
        self.meeting[0] = "m2"
        with self.assertRaisesRegex(ValueError, "meeting_changed"):
            control.resume("m1")
        self.assertEqual(run.calls, [PAUSE])

    def test_failed_resume_keeps_the_pending_stop(self):
        run = Recorder({RESUME: 1})
        control = self.control(run)
        control.stop("m1")
        with self.assertRaisesRegex(RuntimeError, "resume_failed"):
            control.resume("m1")
        self.assertEqual(control.snapshot()["stopping"]["meeting_id"], "m1")

    def test_resume_is_on_disk_before_the_recorder_resumes(self):
        # A write failure after the resume must never leave a pending stop that a restart sends.
        on_disk = []

        def run(argv, **kwargs):
            if argv[1:3] == ["record", "resume"]:
                on_disk.append(json.loads(self.path.read_text())["stopping"])
            return SimpleNamespace(returncode=0)
        control = self.control(run)
        control.stop("m1")
        control.resume("m1")
        self.assertEqual(on_disk, [None])
        self.now[0] = T0 + 45
        restarted = self.control(Recorder())
        restarted.tick()
        self.assertEqual(restarted.run.calls, [])

    def test_unwritable_resume_does_not_resume(self):
        run = Recorder()
        control = self.control(run)
        control.stop("m1")
        with mock.patch.object(control, "_save", side_effect=OSError("/Users/someone/.local: denied")):
            with self.assertRaisesRegex(RuntimeError, "^resume_failed$"):
                control.resume("m1")
        self.assertEqual(run.calls, [PAUSE])
        self.assertEqual(control.snapshot()["stopping"]["meeting_id"], "m1")
        self.assertEqual(json.loads(self.path.read_text())["stopping"]["meeting_id"], "m1")

    def test_failed_resume_restores_the_pending_stop_on_disk(self):
        control = self.control(Recorder({RESUME: 1}))
        control.stop("m1")
        with self.assertRaisesRegex(RuntimeError, "resume_failed"):
            control.resume("m1")
        self.assertEqual(json.loads(self.path.read_text())["stopping"]["meeting_id"], "m1")

    def test_unwritable_stop_stops_at_once(self):
        # A pending stop that cannot survive a restart would leave the recorder paused for good.
        run = Recorder()
        control = self.control(run)
        with mock.patch.object(control, "_save", side_effect=OSError("/Users/someone/.local: denied")):
            result = control.stop("m1")
        self.assertEqual(run.calls, [PAUSE, STOP])
        self.assertIsNone(result["until"])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"]["meeting_id"], "m1")

    def test_old_recorder_stops_at_once(self):
        run = Recorder({PAUSE: 64})
        control = self.control(run)
        result = control.stop("m1")
        self.assertEqual(run.calls, [PAUSE, STOP])
        self.assertIsNone(result["until"])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"], {"meeting_id": "m1", "stopped_at": result["stopped_at"]})
        with self.assertRaisesRegex(ValueError, "too_late"):
            control.resume("m1")

    def test_stop_failed_stores_nothing(self):
        run = Recorder({PAUSE: 1, STOP: 1})
        control = self.control(run)
        with self.assertRaisesRegex(RuntimeError, "stop_failed"):
            control.stop("m1")
        self.assertEqual(control.snapshot(), {"stopping": None, "last_stop": None})
        self.assertFalse(self.path.exists())

    def test_stale_meeting_refused(self):
        run = Recorder()
        control = self.control(run)
        self.meeting[0] = "m2"
        with self.assertRaisesRegex(ValueError, "meeting_changed"):
            control.stop("m1")
        self.assertEqual(run.calls, [])

    def test_double_stop_is_one_pause(self):
        run = Recorder()
        control = self.control(run)
        first = control.stop("m1")
        self.now[0] = T0 + 5
        self.assertEqual(control.stop("m1"), first)
        self.assertEqual(run.calls, [PAUSE])

    def test_restart_finishes_due_stop(self):
        self.control(Recorder()).stop("m1")
        self.now[0] = T0 + 45
        run = Recorder()
        restarted = self.control(run)
        restarted.tick()
        self.assertEqual(run.calls, [STOP])
        self.assertIsNone(restarted.snapshot()["stopping"])

    def test_unreadable_file_starts_empty(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{broken")
        self.assertEqual(self.control(Recorder()).snapshot(), {"stopping": None, "last_stop": None})

    def test_resume_and_tick_race(self):
        # Resume took the pending stop first: the tick at the window's edge sends nothing.
        run = Recorder(block=RESUME)
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 29.9
        resumer = threading.Thread(target=control.resume, args=("m1",))
        resumer.start()
        self.assertTrue(run.entered.wait(5))
        self.now[0] = T0 + 30.5
        ticker = threading.Thread(target=control.tick)
        ticker.start()
        ticker.join(0.2)
        run.release.set()
        resumer.join(5)
        ticker.join(5)
        self.assertEqual(run.calls, [PAUSE, RESUME])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertIsNone(control.snapshot()["last_stop"])

    def test_a_slow_resume_keeps_showing_the_stop_until_the_recorder_answers(self):
        # M3: polls see the stop while the recorder has not resumed; the disk already says nothing is pending (I-series).
        run = Recorder(block=RESUME)
        control = self.control(run)
        control.stop("m1")
        resumer = threading.Thread(target=control.resume, args=("m1",))
        resumer.start()
        self.assertTrue(run.entered.wait(5))
        self.assertEqual(control.snapshot()["stopping"]["meeting_id"], "m1")
        self.assertIsNone(json.loads(self.path.read_text())["stopping"], "a restart never stops a resumed call")
        run.release.set()
        resumer.join(5)
        self.assertIsNone(control.snapshot()["stopping"])
        # A failed resume shows the stop throughout and keeps it, in memory and on disk.
        run = Recorder(codes={RESUME: 1})
        self.path.unlink()
        control = self.control(run)
        control.stop("m1")
        with self.assertRaisesRegex(RuntimeError, "resume_failed"):
            control.resume("m1")
        self.assertEqual(control.snapshot()["stopping"]["meeting_id"], "m1")
        self.assertEqual(json.loads(self.path.read_text())["stopping"]["meeting_id"], "m1")

    def test_tick_and_resume_race(self):
        # The tick took the pending stop first: a resume at the edge is too late.
        run = Recorder(block=STOP)
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 30
        ticker = threading.Thread(target=control.tick)
        ticker.start()
        self.assertTrue(run.entered.wait(5))
        self.now[0] = T0 + 29.9  # the resume's own reading of the clock is still inside the window
        errors = []

        def resume():
            try:
                control.resume("m1")
            except ValueError as exc:
                errors.append(str(exc))

        resumer = threading.Thread(target=resume)
        resumer.start()
        resumer.join(0.2)
        run.release.set()
        ticker.join(5)
        resumer.join(5)
        self.assertEqual(errors, ["too_late"])
        self.assertEqual(run.calls, [PAUSE, STOP])

    def test_deferred_stop_skips_new_meeting(self):
        run = Recorder()
        control = self.control(run)
        control.stop("m1")
        self.meeting[0], self.sessions["m1"] = "m2", ""
        self.now[0] = T0 + 31
        control.tick()
        self.assertEqual(run.calls, [PAUSE])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"]["meeting_id"], "m1")

    def test_new_recording_while_a_stop_is_pending_is_not_muted(self):
        # The poll still names m1, but the recorder's own live file already holds the next call.
        run = Recorder()
        control = self.control(run)
        control.stop("m1")
        self.sessions["m1"] = ""
        with self.assertRaisesRegex(ValueError, "meeting_changed"):
            control.resume("m1")
        self.assertIsNone(control.snapshot()["stopping"])
        self.now[0] = T0 + 31
        control.tick()
        self.assertEqual(run.calls, [PAUSE])
        self.assertEqual(control.snapshot()["last_stop"]["meeting_id"], "m1")

    def test_deferred_stop_skips_a_restarted_session_under_the_same_id(self):
        run = Recorder()
        control = self.control(run)
        control.stop("m1")
        self.sessions["m1"] = "m1|t9"
        self.now[0] = T0 + 31
        control.tick()
        self.assertEqual(run.calls, [PAUSE])
        self.assertIsNone(control.snapshot()["stopping"])

    def test_stop_refused_when_the_recorder_moved_on(self):
        run = Recorder()
        control = self.control(run)
        self.sessions["m1"] = ""
        with self.assertRaisesRegex(ValueError, "meeting_changed"):
            control.stop("m1")
        self.assertEqual(run.calls, [])

    def test_tick_survives_a_missing_recorder(self):
        def run(argv, **kwargs):
            if argv[1:3] == ["record", "stop"]:
                raise FileNotFoundError(argv[0])
            return SimpleNamespace(returncode=0)
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 31
        control.tick()
        self.assertIsNone(control.snapshot()["last_stop"])
        self.assertEqual(control.snapshot()["stopping"]["failed"], 1)

    def test_failed_deferred_stop_is_retried_until_acknowledged(self):
        run = Recorder({STOP: 1})
        control = self.control(run)
        stopped_at = control.stop("m1")["stopped_at"]
        self.now[0] = T0 + 31
        control.tick()
        self.assertEqual(run.calls, [PAUSE, STOP])
        pending = control.snapshot()["stopping"]
        self.assertEqual((pending["failed"], seconds(pending["until"])), (1, T0 + 36))
        self.assertIsNone(control.snapshot()["last_stop"])
        self.assertEqual(json.loads(self.path.read_text())["stopping"]["failed"], 1)  # a restart keeps retrying
        self.now[0] = T0 + 34
        control.tick()
        self.assertEqual(run.calls, [PAUSE, STOP])
        self.now[0] = T0 + 36
        control.tick()
        self.assertEqual(run.calls, [PAUSE, STOP, STOP])
        self.assertEqual(control.snapshot()["stopping"]["failed"], 2)
        run.codes[STOP] = 0
        self.now[0] = T0 + 41
        control.tick()
        self.assertEqual(run.calls, [PAUSE, STOP, STOP, STOP])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"], {"meeting_id": "m1", "stopped_at": stopped_at})

    def test_stop_pressed_again_after_a_failed_deferred_stop_stops_now(self):
        run = Recorder({STOP: 1})
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 31
        control.tick()
        with self.assertRaisesRegex(RuntimeError, "stop_failed"):
            control.stop("m1")
        self.assertEqual(control.snapshot()["stopping"]["failed"], 1)
        with self.assertRaisesRegex(ValueError, "too_late"):  # the undo window is over
            control.resume("m1")
        run.codes[STOP] = 0
        self.assertEqual(control.stop("m1")["until"], None)
        self.assertEqual(run.calls, [PAUSE, STOP, STOP, STOP])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"]["meeting_id"], "m1")

    def test_unreadable_live_file_keeps_the_deferred_stop(self):
        # I2: a live file that cannot be read says nothing about the recording: the stop stays pending and is retried.
        run = Recorder()
        control = self.control(run)
        stopped_at = control.stop("m1")["stopped_at"]
        self.sessions["m1"] = None
        self.now[0] = T0 + 31
        control.tick()
        self.assertEqual(run.calls, [PAUSE])
        self.assertEqual(control.snapshot()["stopping"]["failed"], 1)
        self.assertIsNone(control.snapshot()["last_stop"])
        self.sessions["m1"] = "m1|t1"
        self.now[0] = T0 + 36
        control.tick()
        self.assertEqual(run.calls[-1][:2], STOP)
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"], {"meeting_id": "m1", "stopped_at": stopped_at})

    def test_unreadable_live_file_does_not_resume_or_forget(self):
        run = Recorder()
        control = self.control(run)
        control.stop("m1")
        self.sessions["m1"] = None
        with self.assertRaisesRegex(RuntimeError, "resume_failed"):
            control.resume("m1")
        self.assertEqual(run.calls, [PAUSE])
        self.assertEqual(control.snapshot()["stopping"]["meeting_id"], "m1")
        self.assertIsNone(control.snapshot()["last_stop"])

    def test_unreadable_live_file_does_not_stop_blind(self):
        run = Recorder()
        control = self.control(run)
        self.sessions["m1"] = None
        with self.assertRaisesRegex(RuntimeError, "stop_failed"):
            control.stop("m1")
        self.assertEqual(run.calls, [])

    def test_every_command_names_the_recorders_session(self):
        # J1: the recorder itself checks the session, so a stop meant for m1 can never land on the next call.
        run = Recorder({STOP: 1})
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 31
        control.tick()
        run.codes = {}
        control.stop("m1")  # pressed again after the failed deferred stop
        self.path.unlink()
        control2 = self.control(run)
        control2.stop("m1")
        control2.resume("m1")
        session = ["--session", "m1"]
        self.assertEqual(run.argv, [["record", "pause", *session], ["record", "stop", *session],
                                    ["record", "stop", *session], ["record", "pause", *session],
                                    ["record", "resume", *session]])

    def test_refused_deferred_stop_means_that_recording_ended(self):
        run = Recorder({STOP: 3})
        control = self.control(run)
        stopped_at = control.stop("m1")["stopped_at"]
        self.now[0] = T0 + 31
        control.tick()
        self.assertEqual(run.calls, [PAUSE, STOP])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"], {"meeting_id": "m1", "stopped_at": stopped_at})

    def test_refused_pause_or_resume_is_another_meeting(self):
        run = Recorder({PAUSE: 3})
        control = self.control(run)
        with self.assertRaisesRegex(ValueError, "meeting_changed"):
            control.stop("m1")
        self.assertEqual(run.calls, [PAUSE])
        self.assertIsNone(control.snapshot()["stopping"])
        run.codes = {RESUME: 3}
        control.stop("m1")
        with self.assertRaisesRegex(ValueError, "meeting_changed"):
            control.resume("m1")
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"]["meeting_id"], "m1")

    def test_a_pending_stop_from_before_sessions_names_none(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"version": 1, "last_stop": None, "stopping": {
            "meeting_id": "m1", "stopped_at": "2027-01-15T08:00:00+00:00", "until": "2027-01-15T08:00:30+00:00"}}))
        run = Recorder()
        control = self.control(run)
        self.now[0] = T0 + 10**8
        control.tick()
        self.assertEqual(run.argv, [["record", "stop"]])

    def test_state_answers_while_the_recorder_is_asked(self):
        # I3: the page's state poll never waits for a recorder command (up to 4 s for the ack, 10 s on Windows).
        run = Recorder(block=STOP)
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 31
        ticker = threading.Thread(target=control.tick)
        ticker.start()
        self.assertTrue(run.entered.wait(5))
        answered = []
        poll = threading.Thread(target=lambda: answered.append(control.snapshot()))
        poll.start()
        poll.join(0.5)
        self.assertEqual(len(answered), 1, "snapshot waited for the recorder")
        self.assertEqual(answered[0]["stopping"]["meeting_id"], "m1")
        run.release.set()
        ticker.join(5)
        self.assertIsNone(control.snapshot()["stopping"])

    def test_an_older_recorder_without_sessions_gets_the_bare_verb_once(self):
        # M2: mid-upgrade the recorder may not know --session; it has no sessions, so the bare verb is the old behaviour.
        def old(argv, **kwargs):
            seen.append(list(argv[1:]))
            if "--session" in argv:
                return SimpleNamespace(returncode=64, stdout="", stderr="Error: Unknown option '--session'\n")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        seen = []
        control = self.control(old)
        with self.assertLogs("recording_control", "WARNING") as logs:
            self.assertIsNotNone(control.stop("m1")["until"])
        self.assertEqual(seen, [["record", "pause", "--session", "m1"], ["record", "pause"]])
        self.assertIn("--session", logs.output[0])
        # Any other failure is not retried bare: that would drop the session check on a recorder that has it.
        seen.clear()
        self.path.unlink()  # a fresh server: the first control's pending stop is not this one's
        failing = self.control(lambda argv, **kwargs: seen.append(list(argv[1:])) or SimpleNamespace(
            returncode=1, stdout="", stderr="Capture command failed"))
        with self.assertRaisesRegex(RuntimeError, "stop_failed"):
            failing.stop("m1")
        self.assertEqual(seen, [["record", "pause", "--session", "m1"], ["record", "stop", "--session", "m1"]])

    def test_stop_again_with_an_unreadable_live_file_lets_the_recorder_judge(self):
        # K1: unknown is not "ended": the stop goes out with the session, and the recorder decides.
        run = Recorder({STOP: 1})
        control = self.control(run)
        control.stop("m1")
        self.now[0] = T0 + 31
        control.tick()
        self.sessions["m1"] = None
        with self.assertRaisesRegex(RuntimeError, "stop_failed"):
            control.stop("m1")
        self.assertEqual(run.argv[-1], ["record", "stop", "--session", "m1"])
        self.assertEqual(control.snapshot()["stopping"]["meeting_id"], "m1", "never ended silently")
        self.assertIsNone(control.snapshot()["last_stop"])
        run.codes = {STOP: 3}  # the recorder is live with another session: that recording is over
        self.assertIsNone(control.stop("m1")["until"])
        self.assertIsNone(control.snapshot()["stopping"])
        self.assertEqual(control.snapshot()["last_stop"]["meeting_id"], "m1")

    def test_last_stop_is_set_before_the_pending_stop_clears(self):
        # K2: a poll between the two writes never sees neither, which would show the live bar for a moment.
        control = self.control(Recorder())
        control.stop("m1")
        seen = []
        original = type(control).__setattr__

        def spy(obj, name, value):
            if name in ("stopping", "last_stop"):
                seen.append((obj.stopping, obj.last_stop))
            original(obj, name, value)
        with mock.patch.object(type(control), "__setattr__", spy):
            self.now[0] = T0 + 31
            control.tick()
        self.assertFalse(any(stopping is None and last is None for stopping, last in seen[1:]), seen)
        self.assertEqual(seen[-1][1]["meeting_id"], "m1")

    def test_loop_ticks_until_the_event(self):
        control = self.control(Recorder())
        stop = threading.Event()
        with mock.patch.object(control, "tick", side_effect=lambda: stop.set()) as tick:
            control.loop(stop)
        self.assertEqual(tick.call_count, 1)


class FakeControl:
    def __init__(self):
        self.error = None
        self.calls = []

    def stop(self, meeting_id):
        self.calls.append(("stop", meeting_id))
        if self.error:
            raise self.error
        return {"stopped_at": "2026-11-21T10:00:00+00:00", "until": "2026-11-21T10:00:30+00:00"}

    def resume(self, meeting_id):
        self.calls.append(("resume", meeting_id))
        if self.error:
            raise self.error

    def snapshot(self):
        return {"stopping": None, "last_stop": {"meeting_id": "m1", "stopped_at": "2026-11-21T10:00:00+00:00"}}


class RecorderSessionTests(unittest.TestCase):
    def test_session_comes_from_the_recorders_live_file(self):
        import server
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / "live.json"
            boundaries = mock.Mock(physical_id=lambda logical: {"m1-part2": "m1"}.get(logical, logical))
            with mock.patch.object(server, "TRANSCRIPT_FILE", live), mock.patch.object(server, "BOUNDARIES", boundaries):
                # Missing or unreadable: unknown (None), never "ended" (I2).
                self.assertIsNone(server.recorder_session("m1"))
                live.write_text("{half a write")
                self.assertIsNone(server.recorder_session("m1"))
                live.write_text(json.dumps({"meeting_id": "m1", "started_at": "t1", "status": "paused"}))
                self.assertEqual(server.recorder_session("m1"), "m1|t1")
                self.assertEqual(server.recorder_session("m1-part2"), "m1|t1")
                self.assertEqual(server.recorder_session("m2"), "")
                live.write_text(json.dumps({"meeting_id": "m1", "started_at": "t1", "status": "finished"}))
                self.assertEqual(server.recorder_session("m1"), "")


class RecordingRoutesTests(unittest.TestCase):
    def test_routes(self):
        import server
        fake = FakeControl()
        with mock.patch.object(server, "RECORDING_CONTROL", fake):
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()

            def post(path, payload, origin=None):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=3)
                headers = {"Content-Type": "application/json"}
                if origin:
                    headers["Origin"] = origin
                connection.request("POST", path, json.dumps(payload), headers)
                response = connection.getresponse()
                status, body = response.status, response.read()
                connection.close()
                return status, json.loads(body) if body.startswith(b"{") else body

            try:
                status, body = post("/api/recording/stop", {"meeting_id": "m1"})
                self.assertEqual(status, 200)
                self.assertTrue(body["ok"])
                self.assertEqual(body["stopped_at"], "2026-11-21T10:00:00+00:00")
                self.assertEqual(body["until"], "2026-11-21T10:00:30+00:00")
                self.assertEqual(post("/api/recording/stop", {"meeting_id": 5})[0], 400)
                self.assertEqual(post("/api/recording/stop", {"meeting_id": "x" * 1025})[0], 400)
                self.assertEqual(post("/api/recording/stop", {"meeting_id": "m1"}, "https://example.com")[0], 403)
                self.assertEqual(post("/api/recording/resume", {"meeting_id": "m1"}, "https://example.com")[0], 403)
                self.assertEqual(fake.calls, [("stop", "m1")])
                self.assertEqual(post("/api/recording/resume", {"meeting_id": "m1"}), (200, {"ok": True}))
                fake.error = ValueError("meeting_changed")
                self.assertEqual(post("/api/recording/stop", {"meeting_id": "m1"}),
                                 (409, {"ok": False, "error": "meeting_changed"}))
                fake.error = ValueError("too_late")
                self.assertEqual(post("/api/recording/resume", {"meeting_id": "m1"}),
                                 (409, {"ok": False, "error": "too_late"}))
                fake.error = RuntimeError("stop_failed")
                self.assertEqual(post("/api/recording/stop", {"meeting_id": "m1"}),
                                 (500, {"ok": False, "error": "stop_failed"}))
                fake.error = RuntimeError("resume_failed")
                self.assertEqual(post("/api/recording/resume", {"meeting_id": "m1"}),
                                 (500, {"ok": False, "error": "resume_failed"}))
            finally:
                httpd.shutdown()
                httpd.server_close()

    def test_state_carries_recording_control(self):
        import server
        seen = {}
        real_json = server.Handler._json

        def capture(handler, payload, status=200):
            seen.update(payload)
            real_json(handler, {"ok": True}, status)

        stubs = {name: mock.MagicMock() for name in (
            "FRAMES", "ARCHIVE", "COPILOT", "REPOSITORIES", "PLANS", "JOURNAL", "MEETING_CHAT", "UPDATES",
            "RECOGNITION_GUARD", "interface_preferences", "fact_check_state", "repository_count")}
        with mock.patch.multiple(server, RECORDING_CONTROL=FakeControl(), **stubs), \
                mock.patch.object(server, "annotated_snapshot", return_value={"meeting_id": "m1", "meeting": "", "segments": []}), \
                mock.patch.object(server.Handler, "_json", capture):
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=3)
                connection.request("GET", "/api/state")
                self.assertEqual(connection.getresponse().status, 200)
                connection.close()
            finally:
                httpd.shutdown()
                httpd.server_close()
        self.assertEqual(seen["recording_control"], FakeControl().snapshot())


if __name__ == "__main__":
    unittest.main()
