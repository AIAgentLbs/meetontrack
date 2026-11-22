"""MEETONTRACK-163: GET /api/after and the After controls.

All names, texts and addresses are invented.
"""

import http.client
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import server
from after_state import after_payload
from archive import MeetingArchive

SETTINGS = {"email_enabled": True, "email_to": "owner@example.org",
            "telegram_account": "synthetic-account", "telegram_config": "/synthetic/telegram.json",
            "telegram_target": "me",
            "twenty_enabled": True, "twenty_url": "https://crm.example.org", "twenty_key_saved": True}


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def local(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="seconds")


class AfterAPITests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.config = root / "config"
        self.config.mkdir()
        (self.config / "delivery.json").write_text(json.dumps(SETTINGS))
        self.archive = MeetingArchive(root / "recordings", root / "archive", root / "reports", self.config)
        self.reports = root / "reports"
        ended = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=15)
        started = ended - timedelta(minutes=20)
        meeting = root / "archive" / "m1"
        meeting.mkdir(parents=True)
        (meeting / "meeting.json").write_text(json.dumps({
            "version": 1, "meeting_id": "m1", "meeting": "Synthetic planning call", "status": "finished",
            "started_at": iso(started), "updated_at": iso(ended), "latest_at": iso(ended),
            "final_transcript": "synthetic-final",
            "segments": [{"source": "system", "timestamp": iso(started + timedelta(minutes=1)),
                          "text": "We can approve the budget for one quarter."}],
        }))
        (self.config / "journal.json").write_text(json.dumps({"items": [
            {"id": "j3", "meeting_id": "m1", "category": "FACT", "text": "Budget approved for one quarter.",
             "created_at": iso(started + timedelta(minutes=3))},
            {"id": "j1", "meeting_id": "m1", "category": "RISK", "text": "Legal review may delay the pilot.",
             "created_at": iso(started + timedelta(minutes=5))},
        ]}))
        self.now = time.time()
        self.archive.after.clock = lambda: self.now
        self.ready = True
        patcher = patch.object(self.archive, "_ready_for_delivery", side_effect=lambda detail: self.ready)
        patcher.start()
        self.addCleanup(patcher.stop)

    # -- fixtures -----------------------------------------------------------

    def write_report(self, **fields) -> None:
        """A report.json made from the meeting's current text, with the given outcome fields."""
        folder = self.reports / "m1"
        folder.mkdir(parents=True, exist_ok=True)
        meta = {"html": "/api/archive/report/m1/index.html",
                "source_signature": self.archive.source_signature(self.archive.report_detail("m1")),
                "mail_status": "waiting_for_end", "telegram_status": "waiting_for_end",
                "twenty_status": "waiting_for_end", "drive_status": "pending", **fields}
        (folder / "report.json").write_text(json.dumps(meta))

    def payload(self, settings: dict = SETTINGS) -> dict:
        return after_payload(self.archive, "m1", settings, self.now)

    def state(self, settings: dict = SETTINGS) -> str:
        return self.payload(settings)["send"]["state"]

    def reset(self) -> None:
        (self.reports / "m1" / "after.json").unlink(missing_ok=True)
        (self.reports / "m1" / "report.json").unlink(missing_ok=True)
        self.ready = True

    # -- payload ------------------------------------------------------------

    def test_send_states(self):
        self.assertEqual(self.state({}), "no_channels")

        self.ready = False
        self.assertEqual(self.state(), "draft")

        self.reset()
        self.assertEqual(self.state(), "preparing")  # final transcript in, no report yet

        self.write_report(ready_at=local(self.now - 10))
        payload = self.payload()
        self.assertEqual(payload["send"]["state"], "showing")
        self.assertEqual(payload["send"]["send_at"], local(self.now + 20))

        self.archive.after.edit("m1", "summary", "Pilot starts in March.")
        # The edit changed the report's text: the gate's "changes" wins over "preparing" (C10).
        self.assertEqual(self.state(), "changes")

        self.reset()
        self.write_report(ready_at=local(self.now - 60))
        self.archive.after.hold("m1")
        self.assertEqual(self.state(), "held")
        self.assertEqual({c["status"] for c in self.payload()["send"]["channels"]}, {"held"})

        self.reset()
        # Statuses still read waiting_for_end, the gate is open: the headline is the gate's.
        self.write_report(ready_at=local(self.now - 60))
        self.assertEqual(self.state(), "sending")

        retry_at = local(self.now + 900)
        self.write_report(ready_at=local(self.now - 60), mail_status="failed", delivery_retry_at=retry_at)
        payload = self.payload()
        self.assertEqual(payload["send"]["state"], "failed")
        self.assertEqual(payload["send"]["channels"][0],
                         {"channel": "email", "to": "owner@example.org", "status": "failed", "at": None,
                          "retry_at": retry_at})

        started = local(self.now - 30)
        sent = {"ready_at": local(self.now - 60), "mail_status": "sent", "telegram_status": "sent",
                "twenty_status": "sent", "delivery_started_at": started, "delivery_checked_at": started}
        self.write_report(**sent)
        payload = self.payload()
        self.assertEqual(payload["send"]["state"], "sent")
        self.assertEqual({c["at"] for c in payload["send"]["channels"]}, {started})

        self.archive.after.edit("m1", "summary", "Pilot starts in March.")
        self.assertEqual(self.state(), "preparing")  # until the report is made again (C10)
        self.write_report(**sent)
        self.assertEqual(self.state(), "edited")
        self.archive.after.resent("m1")
        self.assertEqual(self.state(), "sent")

    def test_recipients(self):
        settings = {**SETTINGS, "drive_folder_id": "synthetic-folder"}
        self.write_report(drive_status="not_configured")
        channels = self.payload(settings)["send"]["channels"]
        self.assertEqual([(c["channel"], c["to"], c["status"]) for c in channels],
                         [("email", "owner@example.org", "waiting"), ("telegram", "", "waiting"),
                          ("twenty", "", "waiting")])
        self.write_report(drive_status="not_configured", twenty_status="needs_choice",
                          twenty_target={"object": "company", "id": "c-1", "name": "Example LLC"})
        twenty = self.payload(settings)["send"]["channels"][2]
        self.assertEqual((twenty["to"], twenty["status"]), ("Example LLC", "needs_choice"))
        self.assertEqual(self.payload({**SETTINGS, "telegram_target": "@synthetic_chat"})["send"]["channels"][1]["to"],
                         "@synthetic_chat")

    def test_summary_matches_report(self):
        payload = self.payload()
        detail = self.archive.report_detail("m1")
        self.assertTrue(payload["summary"]["lines"])
        self.assertEqual(payload["summary"]["lines"], self.archive.report_summary(detail))
        self.assertEqual(payload["next_steps"]["lines"], self.archive.report_next_steps(detail))
        self.assertEqual((payload["summary"]["edited"], payload["summary"]["final"]), (False, True))
        self.archive.after.edit("m1", "summary", "Budget approved.\nPilot starts in March.")
        self.ready = False
        payload = self.payload()
        self.assertEqual(payload["summary"], {"lines": ["Budget approved.", "Pilot starts in March."],
                                              "edited": True, "final": False})
        self.assertFalse(payload["next_steps"]["edited"])
        self.assertEqual((payload["meeting_id"], payload["title"]), ("m1", "Synthetic planning call"))

    def test_memo_check_field(self):
        self.assertIsNone(self.payload()["memo_check"])
        self.archive.memo_plan = lambda detail: {"items": [{"kind": "question", "id": "q1", "text": "Budget?"}]}
        self.assertEqual(self.payload()["memo_check"], {"state": "waiting"})
        self.write_report(memo_check={"state": "failed", "reason": "timeout"})
        self.assertEqual(self.payload()["memo_check"], {"state": "failed", "reason": "timeout"})

    def test_unknown_meeting(self):
        self.assertIsNone(after_payload(self.archive, "nope", SETTINGS, self.now))

    # -- routes -------------------------------------------------------------

    def serve(self):
        patcher = patch.object(server, "ARCHIVE", self.archive)
        patcher.start()
        self.addCleanup(patcher.stop)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()

        def stop():
            httpd.shutdown()
            httpd.server_close()
            worker.join(timeout=3)
        self.addCleanup(stop)
        self.port = httpd.server_port

    def request(self, method: str, path: str, payload=None, origin=None) -> tuple[int, dict]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        connection.request(method, path, None if payload is None else json.dumps(payload), headers)
        response = connection.getresponse()
        status, body = response.status, response.read()
        connection.close()
        try:
            return status, json.loads(body)
        except ValueError:
            return status, {}

    def stored(self) -> dict:
        return self.archive.after.read("m1")

    def test_routes(self):
        self.serve()
        post = lambda path, body, origin=None: self.request("POST", path, body, origin)  # noqa: E731
        self.assertEqual(post("/api/after/hold", {"meeting_id": "m1"}, "https://example.test")[0], 403)
        self.assertFalse(self.stored()["held"])

        self.assertEqual(post("/api/after/hold", {"meeting_id": "m1"}), (200, {"ok": True}))
        self.assertTrue(self.stored()["held"])

        server.DELIVERY_WAKE.clear()
        self.assertEqual(post("/api/after/send", {"meeting_id": "m1"}), (200, {"ok": True}))
        self.assertEqual((self.stored()["held"], self.stored()["send_now_at"]), (False, self.now))
        self.assertTrue(server.DELIVERY_WAKE.is_set())

        status, body = post("/api/after/edit", {"meeting_id": "m1", "field": "summary", "text": "Pilot in March."})
        self.assertEqual((status, body), (200, {"ok": True, "send_at": local(self.now + 30)}))
        self.assertEqual(self.stored()["summary"], "Pilot in March.")
        self.assertEqual(post("/api/after/edit", {"meeting_id": "m1", "field": "summary", "text": "x" * 4001})[0], 400)
        self.assertEqual(post("/api/after/edit", {"meeting_id": "m1", "field": "summary", "text": {"a": 1}})[0], 400)
        self.assertEqual(post("/api/after/edit", {"meeting_id": "m1", "field": "title", "text": "x"})[0], 400)
        self.assertEqual(self.stored()["summary"], "Pilot in March.")

        self.assertEqual(post("/api/after/remove", {"meeting_id": "m1", "key": "journal:j1", "removed": True}),
                         (200, {"ok": True}))
        self.assertEqual(self.stored()["removed"], ["journal:j1"])
        self.assertEqual(post("/api/after/remove", {"meeting_id": "m1", "key": "x:1", "removed": True}),
                         (400, {"ok": False, "error": "bad_key"}))
        self.assertEqual(post("/api/after/remove", {"meeting_id": "m1", "key": "journal:j3", "removed": "yes"})[0], 400)

        # The report leaves the item out; the screen still lists it so it can be brought back.
        self.assertNotIn("j1", [item["id"] for item in self.archive.report_detail("m1")["journal"]])
        status, body = self.request("GET", "/api/after?meeting_id=m1")
        self.assertEqual((status, body["removed"]), (200, ["journal:j1"]))
        self.assertTrue(body["ok"])

        for path in ("/api/after/hold", "/api/after/send", "/api/after/send-again"):
            self.assertEqual(post(path, {"meeting_id": "nope"})[0], 404)
        self.assertEqual(post("/api/after/remove", {"meeting_id": "nope", "key": "journal:j1", "removed": True})[0], 404)
        self.assertFalse((self.reports / "nope").exists())
        self.assertEqual(post("/api/after/hold", {"meeting_id": "x" * 1025})[0], 400)
        self.assertEqual(post("/api/after/hold", {})[0], 400)
        self.assertEqual(self.request("GET", "/api/after?meeting_id=nope")[0], 404)
        self.assertEqual(self.request("GET", "/api/after?meeting_id=" + "x" * 1025)[0], 400)
        self.assertEqual(self.request("GET", "/api/after")[0], 400)

    def test_send_again(self):
        self.serve()
        calls = []

        def submit(payload):
            calls.append(payload)
            return {"state": "sending", "request_id": payload["request_id"], "meeting_id": payload["meeting_id"]}

        with patch.object(server.DELIVERY_RETRY, "submit", side_effect=submit):
            status, body = self.request("POST", "/api/after/send-again", {"meeting_id": "m1"})
            self.assertEqual(status, 200)
            self.assertEqual(body["job"]["state"], "sending")
            self.assertEqual(calls[0]["channels"], ["email", "telegram"])  # no Drive (off), never the CRM
            self.assertIs(calls[0]["confirm"], True)
            self.assertEqual(calls[0]["meeting_id"], "m1")
            self.assertRegex(calls[0]["request_id"], r"^[0-9a-f]{32}$")
            self.assertEqual(self.stored()["resent_at"], self.now)

            # Retry sends only what failed (C9).
            self.request("POST", "/api/after/send-again", {"meeting_id": "m1", "channels": ["telegram"]})
            self.assertEqual(calls[1]["channels"], ["telegram"])
            for wrong in (["twenty"], ["drive"], "telegram"):
                self.assertEqual(self.request("POST", "/api/after/send-again",
                                              {"meeting_id": "m1", "channels": wrong})[0], 400)
            self.assertEqual(len(calls), 2)

        self.now += 60
        with patch.object(server.DELIVERY_RETRY, "submit", side_effect=ValueError("delivery_busy")):
            self.assertEqual(self.request("POST", "/api/after/send-again", {"meeting_id": "m1"}),
                             (400, {"ok": False, "error": "delivery_busy"}))
        self.assertEqual(self.stored()["resent_at"], self.now - 60)

    def test_busy_archive_returns_last_payload(self):
        self.serve()
        status, first = self.request("GET", "/api/after?meeting_id=m1")
        self.assertEqual(status, 200)
        self.assertNotIn("stale", first)
        held, release = threading.Event(), threading.Event()

        def busy():
            with self.archive.lock:
                held.set()
                release.wait(10)
        holder = threading.Thread(target=busy)
        holder.start()
        try:
            held.wait(5)
            began = time.monotonic()
            status, body = self.request("GET", "/api/after?meeting_id=m1")
            self.assertLess(time.monotonic() - began, 2)
            self.assertEqual(status, 200)
            self.assertIs(body["stale"], True)
            self.assertEqual(body["send"], first["send"])
            self.assertEqual(self.request("GET", "/api/after?meeting_id=m2"), (503, {"ok": False, "error": "busy"}))
        finally:
            release.set()
            holder.join(5)


if __name__ == "__main__":
    unittest.main()
