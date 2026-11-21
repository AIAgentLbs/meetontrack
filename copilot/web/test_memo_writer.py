import json
import subprocess
import unittest
from datetime import date
from unittest.mock import patch

from calendar_meetings import CalendarMeetings
from memo_writer import company_from, is_external, outside_attendees


def person(email, name="", self_=False, resource=False):
    return {"email": email, "name": name, "self": self_, "resource": resource}


class DetectionTests(unittest.TestCase):
    def test_outside_domain_is_external(self):
        anna = person("anna@example.com", "Anna Petrova")
        attendees = [person("me@example.org", self_=True), anna]
        self.assertTrue(is_external(attendees))
        self.assertEqual(outside_attendees(attendees), [anna])

    def test_same_domain_and_subdomain_are_internal(self):
        self.assertFalse(is_external([person("me@example.org", self_=True), person("bob@mail.example.org")]))
        self.assertFalse(is_external([person("me@example.org", self_=True), person("Bob@Example.org")]))
        # A look-alike domain is not a subdomain.
        self.assertTrue(is_external([person("me@example.org", self_=True), person("eve@badexample.org")]))

    def test_solo_event_is_internal(self):
        self.assertFalse(is_external([]))
        self.assertFalse(is_external([person("me@example.org", self_=True)]))

    def test_public_domain_user_counts_everyone_outside(self):
        self.assertTrue(is_external([person("me@gmail.com", self_=True), person("friend@gmail.com")]))
        self.assertEqual(company_from("friend@gmail.com"), "")

    def test_no_self_attendee_counts_everyone_outside(self):
        self.assertTrue(is_external([person("anna@example.com", "Anna Petrova")]))

    def test_rooms_and_groups_are_not_outside(self):
        attendees = [person("me@example.org", self_=True), person("c_1@resource.calendar.google.com", resource=True),
                     person("team@group.calendar.google.com")]
        self.assertFalse(is_external(attendees))
        self.assertEqual(outside_attendees(attendees), [])

    def test_company_from_domain(self):
        self.assertEqual(company_from("anna@example-llc.com"), "example-llc")
        self.assertEqual(company_from("anna@sales.example.co.uk"), "example")
        self.assertEqual(company_from(""), "")
        self.assertEqual(company_from("not-an-email"), "")

    def test_calendar_event_carries_id_and_resource(self):
        payload = {"items": [
            {"id": "ev1", "summary": "Pilot review",
             "start": {"dateTime": "2026-09-29T10:00:00+02:00"}, "end": {"dateTime": "2026-09-29T10:30:00+02:00"},
             "attendees": [{"email": "me@example.org", "self": True},
                           {"email": "c_1@resource.calendar.google.com", "resource": True}]},
            {"summary": "No id", "start": {"dateTime": "2026-09-29T11:00:00+02:00"},
             "end": {"dateTime": "2026-09-29T11:30:00+02:00"}},
            {"id": "x" * 2000, "summary": "Long id", "start": {"dateTime": "2026-09-29T12:00:00+02:00"},
             "end": {"dateTime": "2026-09-29T12:30:00+02:00"}},
        ]}
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")
        with patch("calendar_meetings.subprocess.run", return_value=done) as run:
            events = CalendarMeetings("/fake/gws").for_day(date(2026, 9, 29))
        self.assertIn("items(id,", json.loads(run.call_args.args[0][-1])["fields"])
        self.assertIn("resource)", json.loads(run.call_args.args[0][-1])["fields"])
        self.assertEqual([e["id"] for e in events], ["ev1", "", "x" * 1024])
        self.assertEqual([a["resource"] for a in events[0]["attendees"]], [False, True])


if __name__ == "__main__":
    unittest.main()
