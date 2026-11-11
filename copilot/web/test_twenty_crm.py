"""Twenty CRM integration (MEETONTRACK-146). Synthetic @example.com data; no network."""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import twenty_crm
from twenty_crm import TwentyClient, TwentyContext, TwentyError, match, note_markdown, screen

KEY = "synthetic-secret-key-123"


class FakeCRM:
    """A tiny in-memory Twenty answering the REST shapes the client parses."""

    def __init__(self, people=(), opportunities=(), fields=None, fail=None, companies=()):
        self.people, self.opportunities = list(people), list(opportunities)
        self.companies = list(companies)
        self.fields = fields
        self.fail = fail or {}
        self.calls = []

    def __call__(self, method, path, query=None, body=None):
        self.calls.append((method, path, query, body))
        for (m, prefix), error in self.fail.items():
            if m == method and path.startswith(prefix):
                raise TwentyError(error)
        flt = (query or {}).get("filter", "")
        if path == "/people":
            return {"data": {"people": [p for p in self.people if f'"{p["email"]}"' in flt
                                        or (f'"{p["name"]["firstName"]}"' in flt and f'"{p["name"]["lastName"]}"' in flt)]}}
        if path in {"/companies", "/opportunities"} and not flt:  # full listing, 60 per page
            items = self.companies if path == "/companies" else self.opportunities
            start = int((query or {}).get("starting_after") or 0)
            page = items[start:start + int(query["limit"])]
            return {"data": {path[1:]: page}, "pageInfo": {"hasNextPage": start + len(page) < len(items),
                                                           "endCursor": str(start + len(page))}}
        if path == "/companies":
            return {"data": {"companies": [c for c in self.companies
                                           if c.get("domain") and f"%{c['domain']}%" in flt]}}
        if path.startswith("/companies/") and self.companies:
            found = [c for c in self.companies if c["id"] == path.rsplit("/", 1)[-1]]
            if not found:
                raise TwentyError("not_found")
            return {"data": {"company": found[0]}}
        if path == "/opportunities":
            return {"data": {"opportunities": [o for o in self.opportunities
                                               if f'"{o.get("companyId")}"' in flt or f'"{o.get("pointOfContactId")}"' in flt
                                               or "ilike" in flt]}}
        if path.startswith("/opportunities/"):
            known = [o for o in self.opportunities if o["id"] == path.rsplit("/", 1)[-1]]
            if known and "name" in known[0]:  # named fixtures answer for themselves
                return {"data": {"opportunity": known[0]}}
            return {"data": {"opportunity": {"id": path.rsplit("/", 1)[-1], "companyId": "c-7", "stage": "MEETING"}}}
        if path.startswith("/companies"):
            return {"data": {"company": {"id": path.rsplit("/", 1)[-1], "name": "Acme",
                                         "domainName": {"primaryLinkUrl": "https://acme.example.com"}}}}
        if path == "/noteTargets" and method == "GET":
            return {"data": {"noteTargets": [{"noteId": "n-old"}]}}
        if path == "/notes" and method == "GET":
            return {"data": {"notes": [{"id": "n-old", "title": "Intro", "bodyV2": {"markdown": "We met."}}]}}
        if path == "/notes" and method == "POST":
            return {"data": {"createNote": {"id": "note-1"}}}
        if path == "/noteTargets":
            return {"data": {"createNoteTarget": {"id": "t-1"}}}
        if path == "/metadata/objects":
            if self.fields is None:
                raise TwentyError("forbidden")
            return {"data": {"objects": [{"nameSingular": "opportunity", "fields": self.fields}]}}
        if method == "PATCH":
            return {"data": {"updateOpportunity": {"id": path.rsplit("/", 1)[-1]}}}
        return {"data": {}}

    def methods(self, method, path=None):
        return [c for c in self.calls if c[0] == method and (path is None or c[1] == path)]


def person(pid, email, company="c-1", first="Ann", last="Lee"):
    return {"id": pid, "email": email, "companyId": company, "name": {"firstName": first, "lastName": last}}


class TwentyClientTests(unittest.TestCase):
    def setUp(self):
        twenty_crm._NAMES.clear()

    def client(self, fake):
        client = TwentyClient("https://crm.example.com/", KEY)
        client._request = fake
        return client

    def test_url_and_hard_delete_are_refused(self):
        self.assertEqual(TwentyClient("https://crm.example.com/rest/", KEY).base, "https://crm.example.com/rest")
        for bad in ("http://crm.example.com", "ftp://x", "https://u:p@crm.example.com", ""):
            with self.assertRaises(ValueError):
                twenty_crm.normalize_url(bad)
        client = TwentyClient("https://crm.example.com", KEY)
        with patch("twenty_crm._OPENER.open") as urlopen:
            with self.assertRaises(TwentyError):
                client._request("DELETE", "/notes/x")
            urlopen.assert_not_called()
        self.assertNotIn(KEY, repr(client))

    def test_401_is_auth_expired_and_429_backs_off(self):
        import urllib.error
        client = TwentyClient("https://crm.example.com", KEY)
        def http(code):
            return urllib.error.HTTPError("u", code, "x", {"Retry-After": "0"}, io.BytesIO(b""))
        with patch("twenty_crm._OPENER.open", side_effect=http(401)):
            with self.assertRaisesRegex(TwentyError, "auth_expired"):
                client._request("GET", "/people")
        with patch("twenty_crm._OPENER.open", side_effect=[http(429), http(429)]) as urlopen, \
             patch("twenty_crm.time.sleep") as sleep:
            with self.assertRaisesRegex(TwentyError, "rate_limited"):
                client._request("GET", "/people")
            self.assertEqual(urlopen.call_count, 2)
            sleep.assert_called_once()

    def test_matching_unique_ambiguous_and_none(self):
        unique = FakeCRM([person("p-1", "ann@example.com")], [{"id": "o-1", "name": "Pilot", "companyId": "c-1", "stage": "PROPOSAL"}])
        found = match(self.client(unique), ["ann@example.com"])
        self.assertEqual(found["status"], "matched")
        self.assertEqual(found["target"], {"object": "opportunity", "id": "o-1", "name": "Pilot", "stage": "PROPOSAL"})
        two = FakeCRM([person("p-1", "ann@example.com")], [{"id": "o-1", "companyId": "c-1"}, {"id": "o-2", "companyId": "c-1"}])
        found = match(self.client(two), ["ann@example.com"])
        self.assertEqual(found["status"], "needs_choice")
        self.assertEqual({c["id"] for c in found["candidates"]}, {"o-1", "o-2"})
        closed = FakeCRM([person("p-1", "ann@example.com")], [{"id": "o-1", "companyId": "c-1", "stage": "CLOSED_WON"}])
        self.assertEqual(match(self.client(closed), ["ann@example.com"])["target"]["object"], "company")
        # Redirects are refused: the key never follows them to another host.
        import urllib.error
        client = TwentyClient("https://crm.example.com", KEY)
        with patch("twenty_crm._OPENER.open", side_effect=urllib.error.HTTPError("u", 302, "x", {}, io.BytesIO(b""))):
            with self.assertRaisesRegex(TwentyError, "redirect_refused"):
                client._request("GET", "/people")
        self.assertTrue(any(isinstance(h, twenty_crm._NoRedirect) for h in twenty_crm._OPENER.handlers))
        nobody = FakeCRM()
        self.assertEqual(match(self.client(nobody), ["zed@example.com", "Single"])["status"], "needs_choice")
        # Two people with one name never pick either of them.
        twins = FakeCRM([person("p-1", "a@example.com", None), person("p-2", "b@example.com", None)])
        self.assertEqual(match(self.client(twins), ["Ann Lee"])["status"], "needs_choice")

    def test_money_filter_withholds_amounts_and_terms(self):
        lines = ["Ship the pilot on Monday", "Budget is 40k", "Цена 300 тыс", "Send the NDA", "Отправить договор",
                 "Agree on payment terms", "Discuss €5", "Demo for the team"]
        kept, withheld = screen(lines)
        self.assertEqual(kept, ["Ship the pilot on Monday", "Demo for the team"])
        self.assertEqual(withheld, 6)
        self.assertEqual(screen(lines, enabled=False), (lines, 0))
        markdown, commitments, count = note_markdown("m-1", {"decisions": ["Use plan B", "Price is $10"],
                                                            "commitments": ["Ann sends the deck"]})
        self.assertNotIn("$10", markdown)
        self.assertIn("1 lines withheld", markdown)
        self.assertIn("m-1", markdown)
        self.assertEqual(commitments, ["Ann sends the deck"])

    def deliver(self, fake, **options):
        before = []
        result = twenty_crm.deliver(self.client(fake), meeting_id="m-1", title="Sync", started=datetime(2026, 11, 11),
                                    attendees=["ann@example.com"], sections={"commitments": ["Ann sends the deck"]},
                                    choice=options.get("choice"), money_filter=True, before_write=lambda: before.append(1))
        return result, before

    def test_note_and_targets_and_next_step_gate(self):
        crm = [person("p-1", "ann@example.com")], [{"id": "o-1", "name": "Pilot", "companyId": "c-1"}]
        text_field = [{"name": "nextStep", "type": "TEXT"}, {"name": "stage", "type": "SELECT", "options": [{"value": "NEW"}]}]
        fake = FakeCRM(*crm, fields=text_field)
        result, before = self.deliver(fake)
        self.assertEqual((result["twenty_status"], result["twenty_note_id"], before), ("sent", "note-1", [1]))
        note = fake.methods("POST", "/notes")[0][3]
        self.assertEqual(note["title"], "2026-11-11 Sync")
        self.assertIn("Ann sends the deck", note["bodyV2"]["markdown"])
        targets = [c[3] for c in fake.methods("POST", "/noteTargets")]
        self.assertEqual(targets, [{"noteId": "note-1", "targetOpportunityId": "o-1"},
                                   {"noteId": "note-1", "targetCompanyId": "c-1"},
                                   {"noteId": "note-1", "targetPersonId": "p-1"}])
        self.assertEqual(fake.methods("PATCH")[0][3], {"nextStep": "Ann sends the deck"})
        # No TEXT nextStep field, or no metadata permission: nothing is patched.
        for fields in ([{"name": "nextStep", "type": "RICH_TEXT"}], None):
            fake = FakeCRM(*crm, fields=fields)
            self.assertEqual(self.deliver(fake)[0]["twenty_status"], "sent")
            self.assertEqual(fake.methods("PATCH"), [])
        self.assertFalse(any(c[0] == "DELETE" for c in fake.calls))

    def test_ambiguous_writes_nothing_and_choice_is_used(self):
        fake = FakeCRM([person("p-1", "ann@example.com")], [{"id": "o-1", "companyId": "c-1"}, {"id": "o-2", "companyId": "c-1"}])
        result, before = self.deliver(fake)
        self.assertEqual((result["twenty_status"], before), ("needs_choice", []))
        self.assertEqual(fake.methods("POST"), [])
        result, _ = self.deliver(fake, choice={"object": "opportunity", "id": "o-2", "name": "Chosen"})
        self.assertEqual(result["twenty_target"]["id"], "o-2")
        links = [c[3] for c in fake.methods("POST", "/noteTargets")]
        self.assertEqual(links[:2], [{"noteId": "note-1", "targetOpportunityId": "o-2"},
                                     {"noteId": "note-1", "targetCompanyId": "c-7"}])

    def test_money_in_the_title_is_withheld(self):
        fake = FakeCRM([person("p-1", "ann@example.com")])
        result = twenty_crm.deliver(self.client(fake), meeting_id="m-1", title="Acme contract EUR 40000",
                                    started=datetime(2026, 11, 11), attendees=["ann@example.com"], sections={},
                                    choice=None, money_filter=True, before_write=lambda: None)
        self.assertEqual(fake.methods("POST", "/notes")[0][3]["title"], "2026-11-11 Meeting")
        self.assertEqual(result["twenty_withheld"], 1)

    def test_401_and_lost_acknowledgement(self):
        fake = FakeCRM([person("p-1", "ann@example.com")], fail={("GET", "/people"): "auth_expired"})
        self.assertEqual(self.deliver(fake)[0]["twenty_status"], "auth_required")
        for error in ("timeout", "server_error"):
            fake = FakeCRM([person("p-1", "ann@example.com")], fail={("POST", "/notes"): error})
            self.assertEqual(self.deliver(fake)[0]["twenty_status"], "unknown")
        # A link failure after the note exists never creates a second note.
        fake = FakeCRM([person("p-1", "ann@example.com")], fail={("POST", "/noteTargets"): "http_error"})
        result, _ = self.deliver(fake)
        self.assertEqual((result["twenty_status"], result["twenty_error"]), ("sent", "link_partial"))
        self.assertEqual(len(fake.methods("POST", "/notes")), 1)

    def test_stage_is_only_proposed_from_workspace_options(self):
        fields = [{"name": "stage", "type": "SELECT", "options": [{"value": "MEETING", "label": "Meeting"},
                                                                {"value": "PROPOSAL", "label": "Proposal"}]}]
        fake = FakeCRM(fields=fields)
        client = self.client(fake)
        self.assertEqual(twenty_crm.propose_stage(client, "MEETING", "t", lambda p: '{"stage":"PROPOSAL"}'),
                         {"state": "proposed", "value": "PROPOSAL", "label": "Proposal"})
        self.assertEqual(twenty_crm.propose_stage(client, "MEETING", "t", lambda p: '{"stage":"WON"}'), {"state": "none"})
        self.assertEqual(fake.methods("PATCH"), [])
        with self.assertRaises(ValueError):
            twenty_crm.apply_stage(client, "o-1", "WON")
        twenty_crm.apply_stage(client, "o-1", "PROPOSAL")
        self.assertEqual(fake.methods("PATCH")[0][3], {"stage": "PROPOSAL"})

    def test_domain_match_skips_public_mail_and_never_guesses(self):
        companies = [{"id": "c-1", "name": "Acme", "domain": "acme.example.com"},
                     {"id": "c-2", "name": "Beta", "domain": "beta.example.com"},
                     {"id": "c-3", "name": "Beta Labs", "domain": "beta.example.com"}]
        deals = [{"id": "o-1", "name": "Pilot", "companyId": "c-1", "stage": "PILOT"}]
        fake = FakeCRM(companies=companies, opportunities=deals)
        found = match(self.client(fake), ["ann@acme.example.com"])
        self.assertEqual(found["target"]["id"], "o-1")
        self.assertIn("domainName.primaryLinkUrl[ilike]", fake.calls[1][2]["filter"])
        found = match(self.client(fake), ["bob@beta.example.com"])
        self.assertEqual((found["status"], {c["id"] for c in found["candidates"]}), ("needs_choice", {"c-2", "c-3"}))
        fake.calls.clear()
        self.assertEqual(twenty_crm.domains(["x@gmail.com", "y@Mail.ru", "z@acme.example.com"]), ["acme.example.com"])
        self.assertEqual(match(self.client(fake), ["x@gmail.com"])["status"], "needs_choice")
        self.assertFalse(any("domainName" in str(c[2]) for c in fake.calls))

    def test_name_match_in_titles_whole_word_and_only_when_unique(self):
        companies = [{"id": f"c-{i}", "name": f"Filler {i}"} for i in range(70)]
        companies += [{"id": "c-acme", "name": 'ООО "Акме"'}, {"id": "c-ab", "name": "AB"},
                      {"id": "c-beta", "name": "Beta Inc."}, {"id": "c-gam", "name": "Gamma"}]
        deals = [{"id": "o-1", "name": "Акме пилот", "companyId": "c-acme", "stage": "PILOT"},
                 {"id": "o-x", "name": "Closed one", "companyId": "c-gam", "stage": "WON"}]
        fake = FakeCRM(companies=companies, opportunities=deals)
        client = self.client(fake)
        # Company found on the second page of the listing (beyond 60), with quotes and legal form removed.
        found = match(client, [], texts=["Созвон «Акме» ТОО"])
        self.assertEqual(found["target"], {"object": "opportunity", "id": "o-1", "name": "Акме пилот", "stage": "PILOT"})
        self.assertTrue(any((c[2] or {}).get("starting_after") == "60" for c in fake.calls))
        # The company and its own deal both named still mean one deal.
        self.assertEqual(match(client, [], texts=["Акме пилот: kickoff"])["target"]["id"], "o-1")
        # Whole words only; names shorter than 3 characters are ignored; closed deals are not candidates.
        self.assertEqual(match(client, [], texts=["Betamax AB review"])["status"], "needs_choice")
        self.assertEqual(match(client, [], texts=["closed one retro"])["status"], "needs_choice")
        self.assertEqual(match(client, [], texts=["BETA weekly"])["target"], {"object": "company", "id": "c-beta", "name": "Beta Inc."})
        # Two records named: ask, never pick.
        found = match(client, [], texts=["Beta and Gamma sync"])
        self.assertEqual((found["status"], {c["id"] for c in found["candidates"]}), ("needs_choice", {"c-beta", "c-gam"}))
        # Participant names count too, and the lists are cached in memory.
        listings = len([c for c in fake.calls if not (c[2] or {}).get("filter")])
        self.assertEqual(match(client, ["Gamma"], texts=["Weekly"])["target"]["id"], "c-gam")
        self.assertEqual(len([c for c in fake.calls if not (c[2] or {}).get("filter")]), listings)

    def test_remembered_pick_wins_and_a_deleted_record_asks_again(self):
        with tempfile.TemporaryDirectory() as folder:
            memory = twenty_crm.Memory(Path(folder) / "twenty-records.json")
            keys = twenty_crm.memory_keys(["Ann@Acme.example.com", "x@gmail.com", "Ann Lee"], "Weekly sync 11.11")
            self.assertEqual(keys, ["email:ann@acme.example.com", "email:x@gmail.com", "domain:acme.example.com",
                                    "title:weekly sync"])
            memory.remember(keys, {"object": "opportunity", "id": "o-2", "name": "secret deal name"})
            stored = (Path(folder) / "twenty-records.json").read_text()
            self.assertNotIn("secret", stored)  # ids only, no CRM content
            deals = [{"id": "o-1", "name": "Pilot", "companyId": "c-1"}, {"id": "o-2", "name": "Other", "companyId": "c-9"}]
            fake = FakeCRM([person("p-1", "ann@acme.example.com")], deals)
            # Another meeting with the same recurring title (different date) uses the earlier pick.
            found = match(self.client(fake), ["bob@other.example.com"], memory=memory, title="Weekly sync 18.11")
            self.assertEqual((found["target"]["id"], found["company"]), ("o-2", "c-9"))
            # The record was deleted: say so and ask again; the stale mapping is gone.
            fake.fail = {("GET", "/opportunities/o-2"): "not_found"}
            found = match(self.client(fake), ["ann@acme.example.com"], memory=memory, title="")
            self.assertEqual((found["status"], found["reason"]), ("needs_choice", "remembered_not_found"))
            self.assertIsNone(memory.lookup(keys))
            result = twenty_crm.deliver(self.client(FakeCRM()), meeting_id="m", title="t", started=datetime(2026, 1, 1),
                                        attendees=[], sections={}, choice=None, money_filter=True, before_write=lambda: None)
            self.assertEqual(result["twenty_status"], "needs_choice")

    def test_open_api_fallback_when_metadata_is_refused(self):
        properties = {name: {"type": "string"} for name in (
            "amount", "closeDate", "companyId", "createdAt", "createdBy", "deletedAt", "id", "name", "ownerId",
            "pointOfContactId", "position", "salesRepoUrl", "searchVector", "updatedAt", "updatedBy")}
        properties.update({
            "stage": {"type": "string", "enum": ["NEW", "SCOPING", "PILOT", "ACTIVE", "WON", "REACTIVATED",
                                                  "STALLED", "NO_RESPONSE", "OTHER", "CLOSED"]},
            "nextStep": {"type": "string", "description": "Next step"},
            "closeDate": {"type": "string", "format": "date-time"},
            "position": {"type": "number"}})
        fake = FakeCRM()
        def answer(method, path, query=None, body=None):
            if path == "/open-api/core":
                fake.calls.append((method, path, query, body))
                return {"openapi": "3.0.3", "components": {"schemas": {"Opportunity": {"properties": properties}}}}
            return fake(method, path, query, body)
        client = self.client(answer)
        fields = client.opportunity_fields()
        self.assertEqual([c[1] for c in fake.calls], ["/metadata/objects", "/open-api/core"])
        self.assertEqual(fields["nextStep"]["type"], "TEXT")
        self.assertNotEqual(fields["closeDate"]["type"], "TEXT")
        self.assertNotEqual(fields["position"]["type"], "TEXT")
        self.assertNotIn("salesRepoUrl", fields)
        self.assertEqual(fields["stage"]["options"][4], {"value": "WON", "label": "WON"})
        self.assertEqual(twenty_crm.propose_stage(client, "SCOPING", "t", lambda p: '{"stage":"PILOT"}'),
                         {"state": "proposed", "value": "PILOT", "label": "PILOT"})
        twenty_crm.apply_stage(client, "o-1", "PILOT")
        self.assertEqual(fake.methods("PATCH")[0][3], {"stage": "PILOT"})
        # Metadata stays the first choice; a refused OpenAPI too means no stage suggestions.
        self.assertEqual(self.client(FakeCRM(fields=[{"name": "stage", "type": "SELECT", "options": [{"value": "A"}]}]))
                         .opportunity_fields()["stage"]["options"], [{"value": "A", "label": "A"}])
        self.assertIsNone(self.client(FakeCRM(fail={("GET", "/open-api"): "forbidden"})).opportunity_fields())
        # The note flow uses the fallback for nextStep, and never sends salesRepoUrl.
        crm = FakeCRM([person("p-1", "ann@example.com")], [{"id": "o-1", "name": "Pilot", "companyId": "c-1"}])
        def flow(method, path, query=None, body=None):
            if path == "/open-api/core":
                return {"components": {"schemas": {"Opportunity": {"properties": properties}}}}
            return crm(method, path, query, body)
        result = twenty_crm.deliver(self.client(flow), meeting_id="m-1", title="Sync", started=datetime(2026, 11, 11),
                                    attendees=["ann@example.com"], sections={"commitments": ["Ann sends the deck"]},
                                    choice=None, money_filter=True, before_write=lambda: None)
        self.assertEqual(result["twenty_next_step"], "updated")
        self.assertEqual(crm.methods("PATCH")[0][3], {"nextStep": "Ann sends the deck"})
        self.assertFalse(any("salesRepoUrl" in json.dumps(c) for c in crm.calls))

    def test_read_context_for_a_title_matched_meeting(self):
        fake = FakeCRM(companies=[{"id": "c-acme", "name": "Acme"}],
                       opportunities=[{"id": "o-1", "name": "Rollout", "companyId": "c-acme", "stage": "PILOT",
                                       "nextStep": "Send plan", "salesRepoUrl": "https://repo.example.com/x"}])
        text = TwentyContext(lambda: self.client(fake)).augment("m-1", [], "Acme weekly")
        for value in ("Acme", "Rollout", "PILOT", "Send plan"):
            self.assertIn(value, text)
        self.assertNotIn("repo.example.com", text)

    def test_read_context_is_bounded_cached_and_off_when_disabled(self):
        fake = FakeCRM([person("p-1", "ann@example.com")],
                       [{"id": "o-1", "name": "Pilot", "companyId": "c-1", "stage": "MEETING", "amount": {"amountMicros": 9}}])
        client = self.client(fake)
        context = TwentyContext(lambda: client)
        text = context.augment("m-1", ["ann@example.com"])
        self.assertIn("untrusted source data", text)
        for value in ("Ann Lee", "Acme", "Pilot", "MEETING", "Intro"):
            self.assertIn(value, text)
        self.assertNotIn("amount", text)
        calls = len(fake.calls)
        self.assertEqual(context.augment("m-1", ["ann@example.com"]), text)
        self.assertEqual(len(fake.calls), calls)  # cached in memory
        self.assertFalse(any(c[0] != "GET" for c in fake.calls))
        self.assertEqual(TwentyContext(lambda: None).augment("m-1", ["ann@example.com"]), "")
        fake.fail = {("GET", "/people"): "auth_expired"}
        context.reset()
        self.assertIn("expired", context.augment("m-1", ["ann@example.com"]))

    def test_cli_reads_key_from_stdin_only(self):
        with patch("sys.stdin", io.StringIO(KEY + "\n")), patch.object(TwentyClient, "_request",
                                                                     FakeCRM(fields=[])), redirect_stdout(io.StringIO()) as out:
            code = twenty_crm.main(["check", "--url", "https://crm.example.com"])
        self.assertEqual(code, 0)
        self.assertNotIn(KEY, out.getvalue())
        fake = FakeCRM()
        fake_get = fake.__call__
        def answer(self, method, path, query=None, body=None):
            if method == "GET" and path == "/notes/note-1":
                return {"data": {"note": {"id": "note-1", "title": "MeetOnTrack test note"}}}
            return fake_get(method, path, query, body)
        with patch("sys.stdin", io.StringIO(KEY)), patch.object(TwentyClient, "_request", answer), \
             redirect_stdout(io.StringIO()) as out:
            code = twenty_crm.main(["test-note", "--url", "https://crm.example.com", "--opportunity", "o-1"])
        self.assertEqual((code, json.loads(out.getvalue())["state"]), (0, "ok"))
        self.assertEqual([c[2] for c in fake.calls if c[0] == "DELETE"], [{"soft_delete": "true"}])


class TwentyChannelTests(unittest.TestCase):
    def setUp(self):
        from archive import MeetingArchive
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.config = root / "config"
        self.config.mkdir()
        self.archive = MeetingArchive(root / "recordings", root / "archive", root / "reports", self.config)
        self.store = {}
        keys = self.archive.delivery_settings.twenty_keys
        for name, fn in (("get", lambda: self.store.get("k", "")), ("set", lambda v: self.store.update(k=v)),
                         ("delete", lambda: self.store.pop("k", None))):
            patcher = patch.object(keys, name, side_effect=fn)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.detail = {"meeting_id": "meeting-1", "title": "Sync", "status": "finished", "final_transcript": "1:1",
                       "started_at": (datetime.now().astimezone() + timedelta(minutes=1)).isoformat(),
                       "remote_attendees": ["ann@example.com"],
                       "journal": [{"category": "DECISION", "text": "Go with plan B"},
                                   {"category": "COMMITMENT", "text": "Budget is 40k"}]}
        (root / "reports" / "meeting-1").mkdir(parents=True)

    def test_settings_hide_key_and_require_url_and_key(self):
        settings = self.archive.delivery_settings
        self.assertFalse(settings.snapshot()["twenty_enabled"])
        with self.assertRaisesRegex(ValueError, "twenty_settings_required"):
            settings.configure({"twenty_enabled": True})
        with redirect_stdout(io.StringIO()) as out:
            snapshot = settings.configure({"twenty_url": "https://crm.example.com", "twenty_key": KEY, "twenty_enabled": True})
        self.assertTrue(snapshot["twenty_enabled"] and snapshot["twenty_key_saved"] and snapshot["twenty_money_filter"])
        for text in (json.dumps(snapshot), (self.config / "delivery.json").read_text(), out.getvalue()):
            self.assertNotIn(KEY, text)
        self.assertEqual(self.store["k"], KEY)
        self.assertTrue(settings.read()["twenty_enabled_at"])
        # A different workspace needs a new key; the old one is removed.
        with self.assertRaisesRegex(ValueError, "twenty_settings_required"):
            settings.configure({"twenty_url": "https://other.example.com", "twenty_enabled": True})
        self.assertEqual(self.store["k"], KEY)  # a rejected form keeps the saved key
        snapshot = settings.configure({"twenty_url": "https://other.example.com"})
        self.assertFalse(snapshot["twenty_enabled"] or snapshot["twenty_key_saved"])
        self.assertNotIn("k", self.store)

    def enable(self):
        self.archive.delivery_settings.configure({"twenty_url": "https://crm.example.com", "twenty_key": KEY,
                                                  "twenty_enabled": True})

    def test_receipt_before_write_and_no_duplicate(self):
        self.enable()
        fake = FakeCRM([person("p-1", "ann@example.com")], [{"id": "o-1", "name": "Pilot", "companyId": "c-1"}])
        seen = []
        def spy(method, path, query=None, body=None):
            if method == "POST" and path == "/notes":
                receipts = json.loads((self.archive.reports_root / "meeting-1" / "delivery-receipts.json").read_text())
                seen.append(receipts.get("twenty_status"))
            return fake(method, path, query, body)
        with patch.object(TwentyClient, "_request", lambda self, *a, **k: spy(*a, **k)):
            result = self.archive.deliver(self.detail, {"pdf_path": ""})
            self.assertEqual(seen, ["unknown"])  # on disk before the write
            self.assertEqual(result["twenty_status"], "sent")
            self.assertEqual(result["twenty_withheld"], 1)
            # A restart that lost report.json still finds the receipt: no second note.
            self.archive.deliver(self.detail, {"pdf_path": ""})
        self.assertEqual(len(fake.methods("POST", "/notes")), 1)

    def test_needs_choice_waits_for_the_person_and_old_meetings_are_not_backfilled(self):
        self.enable()
        fake = FakeCRM()
        with patch.object(TwentyClient, "_request", lambda self, *a, **k: fake(*a, **k)):
            result = self.archive.deliver(self.detail, {"pdf_path": ""})
            self.assertEqual(result["twenty_status"], "needs_choice")
            calls = len(fake.calls)
            self.archive.deliver(self.detail, {"pdf_path": ""}, previous=result)
            self.assertEqual(len(fake.calls), calls)
            old = {**self.detail, "started_at": (datetime.now().astimezone() - timedelta(days=1)).isoformat()}
            self.assertNotIn("twenty_status", self.archive.deliver(old, {"pdf_path": ""}))
            chosen = self.archive.deliver(self.detail, {"pdf_path": ""}, manual=True,
                                          previous={**result, "twenty_choice": {"object": "company", "id": "c-9"}})
        self.assertEqual(chosen["twenty_status"], "sent")
        self.assertEqual(chosen["twenty_choice"], {"object": "company", "id": "c-9"})


if __name__ == "__main__":
    unittest.main()
