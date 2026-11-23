"""MEETONTRACK-183: the calendar is read through the app's own Google sign-in when it is connected."""
import json
import subprocess
import unittest
from datetime import date
from unittest import mock

from calendar_meetings import CalendarMeetings, CalendarUnavailable

EVENT = {
    "id": "evt-1", "summary": "Пилот с Анной Петровой",
    "start": {"dateTime": "2026-11-26T10:00:00+01:00"}, "end": {"dateTime": "2026-11-26T10:30:00+01:00"},
    "hangoutLink": "https://meet.google.com/abc-defg-hij",
    "attendees": [{"email": "anna@example.com", "displayName": "Анна Петрова"}],
}


class FakeOAuth:
    def __init__(self, state="connected", answer=None, error=None, account="me@example.com"):
        self.state, self.answer, self.error, self.calls, self.account = state, answer, error, [], account

    def status(self):
        return {"state": self.state, "client_configured": True, "account": self.account,
                "permissions": ["context"], "login_pending": False}

    def request(self, permission, method, url, *, params=None, timeout=20, **_):
        self.calls.append((permission, method, url, params))
        if self.error:
            raise ValueError(self.error)
        return self.answer


class OAuthCalendarTests(unittest.TestCase):
    def test_connected_sign_in_reads_events_without_gws(self):
        oauth = FakeOAuth(answer={"items": [EVENT]})
        with mock.patch("calendar_meetings.shutil.which", return_value=None), \
                mock.patch("calendar_meetings.subprocess.run") as run:
            calendar = CalendarMeetings(oauth=lambda: oauth)
            events = calendar.for_day(date(2026, 11, 26))
        run.assert_not_called()
        self.assertEqual([e["title"] for e in events], ["Пилот с Анной Петровой"])
        self.assertEqual(events[0]["link"], "https://meet.google.com/abc-defg-hij")
        self.assertEqual(events[0]["attendees"][0]["email"], "anna@example.com")
        permission, method, url, params = oauth.calls[0]
        self.assertEqual((permission, method), ("context", "GET"))
        self.assertTrue(url.endswith("/calendars/primary/events"))
        self.assertEqual(params["singleEvents"], "true")
        self.assertTrue(calendar.available())

    def test_sign_in_read_error_is_calendar_unavailable_not_an_empty_day(self):
        oauth = FakeOAuth(error="authorization_expired")
        calendar = CalendarMeetings(executable="", oauth=lambda: oauth)
        with self.assertRaises(CalendarUnavailable):
            calendar.for_day(date(2026, 11, 26))
        # The failure is remembered briefly: no second request during a poll.
        with self.assertRaises(CalendarUnavailable):
            calendar.for_day(date(2026, 11, 26))
        self.assertEqual(len(oauth.calls), 1)

    def test_nonsense_answer_from_sign_in_is_calendar_unavailable(self):
        calendar = CalendarMeetings(executable="", oauth=lambda: FakeOAuth(answer=["not", "a", "dict"]))
        with self.assertRaises(CalendarUnavailable):
            calendar.for_day(date(2026, 11, 26))

    def test_without_sign_in_gws_still_reads(self):
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps({"items": [EVENT]}), stderr="")
        with mock.patch("calendar_meetings.subprocess.run", return_value=done) as run:
            events = CalendarMeetings(executable="/bin/gws", oauth=lambda: None).for_day(date(2026, 11, 26))
        self.assertEqual(run.call_args[0][0][:4], ["/bin/gws", "calendar", "events", "list"])
        self.assertEqual(len(events), 1)

    def test_expired_sign_in_never_falls_back_to_another_account_in_gws(self):
        oauth = FakeOAuth(state="authorization_expired")
        with mock.patch("calendar_meetings.subprocess.run") as run:
            calendar = CalendarMeetings(executable="/bin/gws", oauth=lambda: oauth)
            self.assertEqual(calendar.for_day(date(2026, 11, 26)), [])
            self.assertEqual(calendar.state(), "not_connected")  # Home offers to reconnect
            self.assertFalse(calendar.available())
        run.assert_not_called()
        self.assertEqual(oauth.calls, [])

    def test_cached_day_belongs_to_the_account_that_read_it(self):
        first = FakeOAuth(answer={"items": [EVENT]})
        second = FakeOAuth(answer={"items": []}, account="other@example.com")
        current = [first]
        calendar = CalendarMeetings(executable="", oauth=lambda: current[0])
        self.assertEqual(len(calendar.for_day(date(2026, 11, 26))), 1)
        current[0] = second
        self.assertEqual(calendar.for_day(date(2026, 11, 26)), [])
        self.assertEqual(len(second.calls), 1)

    def test_state_values(self):
        connected, signed_out = FakeOAuth(), FakeOAuth(state="authorization_required")
        self.assertEqual(CalendarMeetings(executable="", oauth=lambda: connected).state(), "connected")
        self.assertEqual(CalendarMeetings(executable="", enabled=lambda: True, oauth=lambda: connected).state(), "connected")
        self.assertEqual(CalendarMeetings(executable="", enabled=lambda: False, oauth=lambda: connected).state(), "not_connected")
        self.assertEqual(CalendarMeetings(executable="", oauth=lambda: signed_out).state(), "not_connected")
        self.assertEqual(CalendarMeetings(executable="", oauth=lambda: None).state(), "tool_missing")
        self.assertEqual(CalendarMeetings(executable="/bin/gws", oauth=lambda: None).state(), "connected")
        self.assertFalse(CalendarMeetings(executable="", oauth=lambda: signed_out).available())


if __name__ == "__main__":
    unittest.main()
