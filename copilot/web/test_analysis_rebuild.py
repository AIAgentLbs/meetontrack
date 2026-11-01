"""MEETONTRACK-107: a meeting whose live analysis was lost is rebuilt from its stored transcript."""

import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ai_providers
import server
from ai_providers import AIService
from analysis_rebuild import WINDOW, AnalysisRebuilds, transcript_chunks
from fact_check import FactChecks
from test_ai_providers import M1, FakeAdapter

SEGMENTS = [{"id": f"s{n}", "timestamp": f"2026-10-28T13:{n // 60:02d}:{n % 60:02d}+03:00",
             "speaker": "Иван" if n % 2 else "Майк", "speaker_id": "remote-1" if n % 2 else "self",
             "text": f"Реплика номер {n}: обсуждаем пилот, сроки и бюджет проекта по поставкам"} for n in range(2684)]
DETAIL = {"meeting_id": "m-archived", "title": "Встреча 28.10.2026 13:00", "status": "finished",
          "transcript": SEGMENTS, "journal": [], "fact_checks": []}


class ScriptedAdapter(FakeAdapter):
    """Answers each window with a risk naming its last line; fails while `failing` is set."""
    def __init__(self):
        super().__init__()
        self.failing = False

    def call(self, choice, prompt, **options):
        if self.failing:
            raise RuntimeError("401 Unauthorized: sign in again")
        self.calls.append((choice, prompt, options))
        last = [line for line in prompt.split("<transcript>")[-1].split("</transcript>")[0].splitlines() if line.strip()][-1]
        return ai_providers.Reply(f"RISK — Окно до {last.split(']')[0][1:]}", "fake-m1", "thread-rebuild")


class ChunkTests(unittest.TestCase):
    def test_windows_cover_every_line_once_in_order_within_the_live_size(self):
        windows = transcript_chunks(SEGMENTS, server.transcript_line)
        self.assertGreater(len(windows), 10)
        self.assertEqual([item["id"] for window in windows for item in window], [item["id"] for item in SEGMENTS])
        for window in windows:
            self.assertLessEqual(len(server.Handler._transcript_text({"segments": window})), WINDOW)
            self.assertEqual(server.Handler._transcript_text({"segments": window}),
                             "\n".join(map(server.transcript_line, window)), "a window is never cut")


class MarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "rebuilds.json"

    def test_a_failed_meeting_stays_marked_across_a_restart(self):
        AnalysisRebuilds(self.path).failed("m1")
        self.assertEqual(AnalysisRebuilds(self.path).pending(), ["m1"])

    def test_a_later_window_reaching_back_over_the_failure_clears_the_mark(self):
        rebuilds = AnalysisRebuilds(self.path)
        rebuilds.analysed("m1", 0, 20000)
        rebuilds.failed("m1")  # nothing after character 20000 analysed yet
        rebuilds.analysed("m1", 30000, 44000)  # 20000..30000 never analysed
        self.assertEqual(rebuilds.pending(), ["m1"])
        rebuilds = AnalysisRebuilds(self.path)
        rebuilds.analysed("m2", 0, 20000)
        rebuilds.failed("m2")
        rebuilds.analysed("m2", 8000, 22000)  # covers everything after 20000
        self.assertEqual(rebuilds.pending(), ["m1"])

    def test_the_loop_retries_marked_meetings_only_when_nothing_is_recording(self):
        runs = []
        rebuilds = AnalysisRebuilds(self.path, lambda meeting_id, skip, progress: runs.append(meeting_id))
        rebuilds.failed("m1")
        stop, recording = threading.Event(), [True]
        worker = threading.Thread(target=rebuilds.loop, args=(stop, lambda: recording[0]), daemon=True)
        worker.start()
        rebuilds.wake.set()
        worker.join(0.2)
        self.assertEqual(runs, [])
        recording[0] = False
        rebuilds.wake.set()
        for _ in range(50):
            if runs:
                break
            worker.join(0.05)
        stop.set()
        rebuilds.wake.set()
        self.assertEqual(runs, ["m1"])
        self.assertEqual(rebuilds.snapshot("m1")["state"], "done")


class RebuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.adapter = ScriptedAdapter()
        service = AIService(root / "config.json", {}, adapters=[self.adapter])
        service.save(M1)
        self.copilot = server.CodexSession(root / "copilot.json")
        self.copilot.thread_id, self.copilot.meeting_id = "live-thread", "m-live"
        self.journal = server.MeetingJournal(root / "journal.json")
        self.reports = []
        archive = SimpleNamespace(
            detail=lambda meeting_id: dict(DETAIL, journal=self.journal.snapshot(meeting_id))
            if meeting_id == "m-archived" else None,
            generate_report=lambda *args, **kwargs: self.reports.append(args))
        self.rebuilds = AnalysisRebuilds(root / "rebuilds.json", server.rebuild_analysis)
        stubs = {
            "AI": service, "ARCHIVE": archive, "COPILOT": self.copilot, "JOURNAL": self.journal,
            "FACT_CHECKS": FactChecks(root / "fact-checks.json"), "REBUILDS": self.rebuilds,
            "FRAMES": SimpleNamespace(visual_context=lambda meeting_id: ""),
            "MEETING_CHAT": SimpleNamespace(snapshot=lambda meeting_id: []),
            "PLANS": SimpleNamespace(snapshot=lambda snapshot: None, apply_analysis=lambda snapshot, answer: 0),
            "REPOSITORIES": SimpleNamespace(resolve=lambda *args, **kwargs: {"kind": "all", "repositories": []}),
        }
        for name, value in stubs.items():
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for target in (server.GOOGLE_CONTEXT, server.LOCAL_CONTEXT):
            patcher = patch.object(target, "augment", return_value="")
            patcher.start()
            self.addCleanup(patcher.stop)
        self.windows = transcript_chunks(SEGMENTS, server.transcript_line)

    def risks(self):
        return [item["text"] for item in self.journal.snapshot("m-archived") if item["category"] == "RISK"]

    def test_the_whole_meeting_is_analysed_once_and_a_rerun_adds_nothing(self):
        self.assertTrue(self.rebuilds.run("m-archived"))
        self.assertEqual(len(self.adapter.calls), len(self.windows))
        self.assertEqual(sorted(self.risks()), sorted(f"Окно до {window[-1]['timestamp']}" for window in self.windows),
                         "every window reached Call overview, to the last line")
        self.assertIn(SEGMENTS[-1]["text"], self.adapter.calls[-1][1])
        self.assertEqual({options["resume"] for _, _, options in self.adapter.calls[1:]}, {"thread-rebuild"})
        state = self.rebuilds.snapshot("m-archived")
        self.assertEqual((state["state"], state["done"], state["total"]), ("done", len(self.windows), len(self.windows)))
        items = len(self.journal.snapshot("m-archived"))
        self.assertTrue(self.rebuilds.run("m-archived"))
        self.assertEqual((len(self.adapter.calls), len(self.journal.snapshot("m-archived"))), (len(self.windows), items))
        # The live meeting's thread and state are untouched; nothing was reported or delivered.
        self.assertEqual((self.copilot.thread_id, self.copilot.meeting_id, self.copilot.busy),
                         ("live-thread", "m-live", False))
        self.assertEqual(self.copilot.analysis["state"], "idle")
        self.assertEqual(self.reports, [])

    def test_a_failing_ai_keeps_the_mark_and_the_next_run_resumes(self):
        self.rebuilds.failed("m-archived")
        real = ScriptedAdapter.call
        calls = []

        def fail_on_third(adapter, choice, prompt, **options):
            calls.append(1)
            adapter.failing = len(calls) == 3
            return real(adapter, choice, prompt, **options)
        with patch.object(ScriptedAdapter, "call", fail_on_third):
            self.assertFalse(self.rebuilds.run("m-archived"))
        state = self.rebuilds.snapshot("m-archived")
        self.assertEqual((state["state"], state["done"]), ("error", 2))
        self.assertIn("401", state["message"])
        self.assertEqual(self.rebuilds.pending(), ["m-archived"])
        self.adapter.failing = False
        self.assertTrue(self.rebuilds.run("m-archived"))
        self.assertEqual(len(self.adapter.calls), len(self.windows), "the two analysed windows were not sent again")
        self.assertEqual(len(self.risks()), len(self.windows))
        self.assertEqual(self.rebuilds.pending(), [])

    def test_a_meeting_still_recording_or_gone_is_not_rebuilt(self):
        with patch.object(server.ARCHIVE, "detail", lambda meeting_id: dict(DETAIL, status="recording")):
            with self.assertRaises(ValueError):
                server.rebuild_analysis("m-archived")
        self.rebuilds.failed("gone")
        self.assertTrue(self.rebuilds.run("gone"))
        self.assertEqual(self.rebuilds.pending(), [])

    def test_the_endpoint_starts_a_rebuild_and_reports_progress(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)

        def request(method, path, body=None, headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=10)
            conn.request(method, path, json.dumps(body) if body is not None else None,
                         {"Content-Type": "application/json", **(headers or {})})
            response = conn.getresponse()
            return response.status, response.read()

        status, _ = request("POST", "/api/archive/analyze", {"meeting_id": "m-archived"}, {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, body = request("POST", "/api/archive/analyze", {"meeting_id": "nope"})
        self.assertEqual(status, 400, body)
        status, body = request("POST", "/api/archive/analyze", {"meeting_id": "m-archived"})
        self.assertEqual(status, 200, body)
        for _ in range(200):
            state = json.loads(request("GET", "/api/archive/analyze?meeting_id=m-archived")[1])["analysis_rebuild"]
            if state["state"] != "running":
                break
            threading.Event().wait(0.05)
        self.assertEqual(state["state"], "done")
        self.assertEqual(len(self.risks()), len(self.windows))


if __name__ == "__main__":
    unittest.main()
