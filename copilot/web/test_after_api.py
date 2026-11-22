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
from delivery_retry import DeliveryRetry
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
        self.write_report(ready_at=local(self.now - 60), mail_status="failed", delivery_retry_at=retry_at,
                          delivery_started_at=local(self.now - 60))
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

        # A CRM record the person must choose is never sent on its own: it does not hold "sent".
        self.write_report(**{**sent, "twenty_status": "needs_choice"})
        self.assertEqual(self.state(), "sent")
        self.write_report(**{**sent, "mail_status": "needs_choice", "telegram_status": "needs_choice",
                             "twenty_status": "needs_choice"})
        self.assertNotEqual(self.state(), "sent")  # nothing went at all
        self.write_report(**sent)

        self.archive.after.edit("m1", "summary", "Pilot starts in March.")
        self.assertEqual(self.state(), "sent")  # it went; Send again comes once the report is made again (H)
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

    def test_memo_not_checked_is_final(self):
        """An old meeting's report says it was not checked; without memo questions there is no line."""
        self.write_report(memo_check={"state": "unavailable", "reason": "not_checked"})
        self.assertIsNone(self.payload()["memo_check"])
        self.archive.memo_plan = lambda detail: {"items": [{"kind": "question", "id": "q1", "text": "Budget?"}]}
        self.assertEqual(self.payload()["memo_check"], {"state": "unavailable", "reason": "not_checked"})

    def test_unknown_meeting(self):
        self.assertIsNone(after_payload(self.archive, "nope", SETTINGS, self.now))

    # -- routes -------------------------------------------------------------

    def serve(self):
        for patcher in (patch.object(server, "ARCHIVE", self.archive), patch.dict(server.AFTER_CACHE, clear=True)):
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
        self.assertEqual(body["removed_journal"], [{"key": "journal:j1", "category": "RISK",
                                                    "text": "Legal review may delay the pilot."}])
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
            self.assertIs(calls[0]["after"], True)
            self.assertIsNone(self.stored()["resent_at"])  # only the finished job records it

            # Retry sends only what failed (C9).
            self.request("POST", "/api/after/send-again", {"meeting_id": "m1", "channels": ["telegram"]})
            self.assertEqual(calls[1]["channels"], ["telegram"])
            for wrong in (["twenty"], ["drive"], "telegram"):
                self.assertEqual(self.request("POST", "/api/after/send-again",
                                              {"meeting_id": "m1", "channels": wrong})[0], 400)
            self.assertEqual(len(calls), 2)

        with patch.object(server.DELIVERY_RETRY, "submit", side_effect=ValueError("delivery_busy")):
            self.assertEqual(self.request("POST", "/api/after/send-again", {"meeting_id": "m1"}),
                             (400, {"ok": False, "error": "delivery_busy"}))
        self.assertIsNone(self.stored()["resent_at"])

    def test_send_again_marks_resent_only_when_it_went(self):
        """An edit made after the send: a Send again that fails leaves the headline on "edited" (I1)."""
        self.serve()
        retry = DeliveryRetry(self.archive)
        patcher = patch.object(server, "DELIVERY_RETRY", retry)
        patcher.start()
        self.addCleanup(patcher.stop)
        sent = []
        patcher = patch.object(self.archive, "deliver", side_effect=lambda detail, meta, **kw: (
            sent.append(kw.get("channels")) or {"mail_status": "sent", "telegram_status": "sent"}))
        patcher.start()
        self.addCleanup(patcher.stop)
        (self.reports / "m1").mkdir(parents=True)
        (self.reports / "m1" / "meeting-report.pdf").write_bytes(b"%PDF synthetic")
        delivered = {"ready_at": local(self.now - 120), "mail_status": "sent", "telegram_status": "sent",
                     "twenty_status": "sent", "delivery_started_at": local(self.now - 60),
                     "delivery_checked_at": local(self.now - 60)}
        self.write_report(**delivered)
        self.archive.after.edit("m1", "summary", "Pilot starts in March.")

        def send_again() -> dict:
            self.assertEqual(self.request("POST", "/api/after/send-again", {"meeting_id": "m1"})[0], 200)
            deadline = time.monotonic() + 5
            while retry.snapshot()["state"] == "sending" and time.monotonic() < deadline:
                time.sleep(0.02)
            return retry.snapshot()

        # Pressed before the report was made again from the edit: nothing goes.
        self.assertEqual(send_again()["error"], "report_not_ready")
        self.assertEqual((sent, self.stored()["resent_at"]), ([], None))
        self.write_report(**delivered)  # the history pass makes it again
        self.assertEqual(self.state(), "edited")

        self.now += 5
        self.assertEqual(send_again()["state"], "complete")
        self.assertEqual(sent, [{"email", "telegram"}])
        self.assertEqual(self.stored()["resent_at"], self.now)
        self.assertEqual(self.state(), "sent")

        # An edit that lands while the job reads the report is not in what went out: still later.
        real = self.archive.report_matches

        def racing(detail, report):
            matched = real(detail, report)
            self.now += 1
            self.archive.after.edit("m1", "next_steps", "Call back on Monday.")
            return matched
        self.now += 5
        with patch.object(self.archive, "report_matches", side_effect=racing):
            self.assertEqual(send_again()["state"], "complete")
        self.assertLess(self.stored()["resent_at"], self.stored()["changed_at"])

    def test_controls_answer_while_a_send_holds_the_archive(self):
        """Hold is stored within 1 s while a send holds the archive, and the queued report keeps it (I2)."""
        self.serve()
        (self.reports / "m1").mkdir(parents=True)
        (self.reports / "m1" / "meeting-report.pdf").write_bytes(b"%PDF synthetic")
        self.write_report(ready_at=local(self.now - 60), pdf_path=str(self.reports / "m1" / "meeting-report.pdf"),
                          generated_at=local(self.now - 60))
        self.assertEqual(self.request("GET", "/api/after?meeting_id=m1")[0], 200)  # the page has shown it
        held, release = threading.Event(), threading.Event()

        def sending():
            with self.archive.lock:  # another report's SMTP and Drive
                held.set()
                release.wait(10)
        holder = threading.Thread(target=sending)
        holder.start()
        try:
            held.wait(5)
            began = time.monotonic()
            self.assertEqual(self.request("POST", "/api/after/hold", {"meeting_id": "m1"}), (200, {"ok": True}))
            self.assertLess(time.monotonic() - began, 2)
            self.assertTrue(self.stored()["held"])
            # Nothing shown yet for this meeting: a fixed retryable answer, not a hang.
            server.AFTER_CACHE.clear()
            began = time.monotonic()
            self.assertEqual(self.request("POST", "/api/after/send", {"meeting_id": "m1"}),
                             (503, {"ok": False, "error": "busy"}))
            self.assertLess(time.monotonic() - began, 2)
        finally:
            release.set()
            holder.join(5)
        sent = []
        with patch.object(self.archive, "deliver", side_effect=lambda *a, **k: sent.append(1) or {}):
            self.archive.retry_pending_deliveries()  # the scan that was queued behind the send
        self.assertEqual(sent, [])

    def test_hold_never_waits_for_the_archive(self):
        """Retry takes the archive lock again for each queued report and the lock is not fair:
        a Hold that waited for it could lose to the queued send. A shown meeting's Hold is written at once."""
        self.serve()
        (self.reports / "m1").mkdir(parents=True)
        (self.reports / "m1" / "meeting-report.pdf").write_bytes(b"%PDF synthetic")
        self.write_report(ready_at=local(self.now - 60), pdf_path=str(self.reports / "m1" / "meeting-report.pdf"),
                          generated_at=local(self.now - 60))
        self.assertEqual(self.request("GET", "/api/after?meeting_id=m1")[0], 200)
        sent = []
        patcher = patch.object(self.archive, "deliver", side_effect=lambda *a, **k: sent.append(1) or {})
        patcher.start()
        self.addCleanup(patcher.stop)
        held, release = threading.Event(), threading.Event()

        def sending():
            with self.archive.lock:  # another report's send
                held.set()
                release.wait(10)
        holder = threading.Thread(target=sending)
        holder.start()
        held.wait(5)
        scan = threading.Thread(target=self.archive.retry_pending_deliveries)
        scan.start()  # m1 is queued behind that send
        try:
            time.sleep(0.2)
            began = time.monotonic()
            self.assertEqual(self.request("POST", "/api/after/hold", {"meeting_id": "m1"}), (200, {"ok": True}))
            self.assertLess(time.monotonic() - began, 0.5)
            self.assertTrue(self.stored()["held"])
        finally:
            release.set()
            holder.join(5)
            scan.join(5)
        self.assertEqual(sent, [])

    # -- fix wave (MEETONTRACK-163) -------------------------------------------

    def ready_report(self, **fields) -> None:
        (self.reports / "m1").mkdir(parents=True, exist_ok=True)
        (self.reports / "m1" / "meeting-report.pdf").write_bytes(b"%PDF synthetic")
        self.write_report(ready_at=local(self.now - 60), pdf_path=str(self.reports / "m1" / "meeting-report.pdf"),
                          generated_at=local(self.now - 60), **fields)

    def test_hold_while_the_report_is_sending_is_refused(self):
        """A Hold answered 200 is never followed by a send: during the send it answers 409 "sending" (A, final I1)."""
        self.serve()
        self.ready_report()
        entered, release, sent = threading.Event(), threading.Event(), []

        def deliver(detail, meta, **kwargs):
            sent.append(1)
            entered.set()
            release.wait(10)
            return {"mail_status": "sent"}
        patcher = patch.object(self.archive, "deliver", side_effect=deliver)
        patcher.start()
        self.addCleanup(patcher.stop)
        scan = threading.Thread(target=self.archive.retry_pending_deliveries)
        scan.start()
        try:
            self.assertTrue(entered.wait(5))
            # Without a cached page the route waits 1 s for the archive, then has nothing to act on.
            self.assertEqual(self.request("POST", "/api/after/hold", {"meeting_id": "m1"}),
                             (503, {"ok": False, "error": "busy"}))
            server.AFTER_CACHE["m1"] = {"meeting_id": "m1"}  # the page has shown it: Hold goes at once
            self.assertEqual(self.request("POST", "/api/after/hold", {"meeting_id": "m1"}),
                             (409, {"ok": False, "error": "sending"}))
            self.assertFalse(self.stored()["held"])
        finally:
            release.set()
            scan.join(5)
        self.assertEqual(sent, [1])
        self.assertEqual(self.request("POST", "/api/after/hold", {"meeting_id": "m1"}), (200, {"ok": True}))

    def test_queued_send_now_never_undoes_a_later_hold(self):
        """Send now waits behind another report's send; a Hold pressed after it wins (A, Codex P1)."""
        self.serve()
        self.ready_report()
        self.assertEqual(self.request("GET", "/api/after?meeting_id=m1")[0], 200)
        held, release, answers = threading.Event(), threading.Event(), []

        def sending():
            with self.archive.lock:
                held.set()
                release.wait(10)
        holder = threading.Thread(target=sending)
        holder.start()
        held.wait(5)
        press = threading.Thread(target=lambda: answers.append(
            self.request("POST", "/api/after/send", {"meeting_id": "m1"})))
        press.start()
        try:
            time.sleep(0.2)  # Send now is waiting for the archive
            self.assertEqual(self.request("POST", "/api/after/hold", {"meeting_id": "m1"}), (200, {"ok": True}))
        finally:
            release.set()  # within the 1 s wait: Send now gets the archive after the Hold
            holder.join(5)
            press.join(5)
        self.assertEqual(answers[0][0], 200)
        self.assertTrue(self.stored()["held"])
        self.assertIsNone(self.stored()["send_now_at"])

    def test_retry_checks_the_report_again_right_before_it_sends(self):
        """A board item removed and Send now pressed while the retry prepared: the old attachment stays (A, Codex P1)."""
        self.ready_report()
        sent = []
        archive = self.archive

        class Racing:
            def acquire(self, blocking=True):
                archive.after.remove("m1", "journal:j1", True)
                archive.after.send_now("m1")
                return True

            def release(self):
                pass
        with patch.object(self.archive, "deliver", side_effect=lambda *a, **k: sent.append(1) or {}), \
                patch.object(self.archive, "report_gate", return_value=Racing()):
            self.archive.retry_pending_deliveries()
        self.assertEqual(sent, [])

    def test_first_delivery_records_the_text_it_took(self):
        """An edit and Send now in the same second: the report that went includes the edit, so it is not "edited" (E)."""
        self.now = int(self.now) + 0.6
        self.archive.after.edit("m1", "summary", "Pilot starts in March.")
        self.archive.after.send_now("m1")
        self.ready = True
        with patch.object(self.archive, "_print_pdf", side_effect=lambda html, pdf: pdf.write_bytes(b"%PDF synthetic")), \
                patch.object(self.archive, "deliver", return_value={"mail_status": "sent", "telegram_status": "sent",
                                                                    "twenty_status": "sent"}):
            self.archive.generate_report("m1")
        self.assertEqual(self.stored()["delivered_at"], self.now)
        self.assertEqual(self.state(), "sent")

    def test_send_again_that_reached_nobody_is_not_marked_sent(self):
        """resent_at moves only when a channel confirmed the edited report (E, Codex P2)."""
        retry = DeliveryRetry(self.archive)
        self.ready_report(mail_status="sent", telegram_status="sent", twenty_status="sent",
                          delivery_started_at=local(self.now - 60))
        with patch.object(self.archive, "deliver", return_value={"mail_status": "failed", "telegram_status": "failed"}):
            retry._run("m1", "r" * 16, {"email", "telegram"}, True, True)
        self.assertEqual(retry.snapshot()["state"], "complete")
        self.assertIsNone(self.stored()["resent_at"])
        with patch.object(self.archive, "deliver", return_value={"mail_status": "sent", "telegram_status": "failed"}):
            retry._run("m1", "s" * 16, {"email", "telegram"}, True, True)
        self.assertEqual(self.stored()["resent_at"], self.now)

    def test_retry_skips_a_channel_that_went_since_the_page_showed_it(self):
        """Retry names the failed channels the page saw; one that an automatic retry sent since is not sent twice (G)."""
        self.serve()
        retry = DeliveryRetry(self.archive)
        patcher = patch.object(server, "DELIVERY_RETRY", retry)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ready_report(mail_status="sent", telegram_status="sent", twenty_status="sent",
                          delivery_started_at=local(self.now - 60))
        sent = []
        with patch.object(self.archive, "deliver", side_effect=lambda d, m, **k: sent.append(k["channels"]) or {}):
            status, body = self.request("POST", "/api/after/send-again", {"meeting_id": "m1", "channels": ["telegram"]})
            self.assertEqual(status, 200)
            self.assertRegex(body["job"]["request_id"], r"^[0-9a-f]{32}$")
            deadline = time.monotonic() + 5
            while retry.snapshot()["state"] == "sending" and time.monotonic() < deadline:
                time.sleep(0.02)
        self.assertEqual(sent, [])
        self.assertEqual(retry.snapshot()["state"], "complete")

    def test_editing_pauses_the_report_at_once(self):
        """The page says the person started typing before the text is saved (F)."""
        self.serve()
        status, body = self.request("POST", "/api/after/editing", {"meeting_id": "m1"})
        self.assertEqual((status, body), (200, {"ok": True, "send_at": local(self.now + 30)}))
        self.assertEqual(self.stored()["changed_at"], self.now)

    def test_channels_and_destinations(self):
        """A channel turned on after the call began is not listed; a sent row names where it went (I)."""
        began = self.archive.report_detail("m1")["started_at"]
        later = (datetime.fromisoformat(began.replace("Z", "+00:00")) + timedelta(minutes=5)).isoformat()
        settings = {**SETTINGS, "telegram_enabled_at": later}
        self.write_report()
        self.assertEqual([row["channel"] for row in self.payload(settings)["send"]["channels"]], ["email", "twenty"])
        self.write_report(telegram_status="sent")  # sent on request: it did go
        self.assertIn("telegram", [row["channel"] for row in self.payload(settings)["send"]["channels"]])

        sent = {"mail_status": "sent", "telegram_status": "sent", "twenty_status": "sent",
                "delivery_started_at": local(self.now - 60)}
        self.write_report(**sent, mail_to="earlier@example.org", telegram_to="@synthetic_chat")
        rows = {row["channel"]: row["to"] for row in self.payload({**SETTINGS, "email_to": "new@example.org"})["send"]["channels"]}
        self.assertEqual((rows["email"], rows["telegram"]), ("earlier@example.org", "@synthetic_chat"))
        self.write_report(**sent)  # delivered before destinations were recorded
        rows = {row["channel"]: row["to"] for row in self.payload({**SETTINGS, "email_to": "new@example.org"})["send"]["channels"]}
        self.assertEqual(rows["email"], "")

    def test_next_try_only_when_one_comes(self):
        """"Next try at" only for a channel the app will retry: never unknown, auth_required or past the window (K)."""
        retry_at = local(self.now + 900)
        base = {"ready_at": local(self.now - 60), "delivery_started_at": local(self.now - 60), "delivery_retry_at": retry_at}
        self.write_report(**base, mail_status="unknown", telegram_status="auth_required")
        payload = self.payload()
        rows = {row["channel"]: row for row in payload["send"]["channels"]}
        self.assertEqual((rows["email"]["status"], rows["email"]["retry_at"]), ("unknown", None))
        self.assertEqual((rows["telegram"]["status"], rows["telegram"]["retry_at"]), ("failed", None))
        self.assertEqual(payload["send"]["state"], "failed")
        self.write_report(**{**base, "delivery_started_at": local(self.now - 4 * 86400)}, mail_status="failed")
        self.assertIsNone(self.payload()["send"]["channels"][0]["retry_at"])
        self.write_report(**base, mail_status="failed")
        self.assertEqual(self.payload()["send"]["channels"][0]["retry_at"], retry_at)

    def test_memo_quote_follows_a_speaker_correction(self):
        """The memo check keeps the line it quoted; the speaker shown is that line's current one (N)."""
        self.archive.memo_plan = lambda detail: {"items": [{"kind": "question", "id": "q1", "text": "Budget?"}]}
        line = self.archive.report_detail("m1")["transcript"][0]
        quote = {"id": "q1", "text": "Budget?", "status": "answered", "quote": "approve the budget",
                 "speaker": "Speaker 1", "at": "", "segment_id": line["segment_id"]}
        self.write_report(memo_check={"state": "done", "questions": [quote], "differs": []})
        self.assertEqual(self.payload()["memo_check"]["questions"][0]["speaker"], line["speaker_label"])

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
