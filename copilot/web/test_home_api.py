import http.client
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import server
from calendar_meetings import CalendarMeetings, CalendarUnavailable
from skip_recording import SkipRecording

NOW = datetime(2026, 11, 21, 10, 0, tzinfo=timezone.utc)


def meeting(event_id='', title='Pilot review', start=NOW + timedelta(hours=1), minutes=30):
    return {'event_id': event_id, 'title': title, 'start': start.isoformat(),
            'end': (start + timedelta(minutes=minutes)).isoformat()}


ANNA = {'email': 'anna@example.com', 'name': 'Anna Petrova', 'self': False}


def call(event_id, start, minutes=30, **extra):
    """An agenda meeting with someone else in it: a call, not a solo block."""
    return {**meeting(event_id, start=start, minutes=minutes), 'attendees': [ANNA], 'link': '', **extra}


def serve(test):
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    test.addCleanup(httpd.server_close)
    test.addCleanup(httpd.shutdown)
    return httpd.server_port


def request(port, method, path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    connection.request(method, path, body=json.dumps(body).encode() if body is not None else None,
                       headers={'Content-Type': 'application/json'})
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, json.loads(payload)


class StaticFilesTests(unittest.TestCase):
    def test_shell_files_served_with_csp(self):
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            for path, content_type in (('/shell.js', 'text/javascript; charset=utf-8'),
                                       ('/home.js', 'text/javascript; charset=utf-8'),
                                       ('/call.js', 'text/javascript; charset=utf-8'),
                                       ('/screens.css', 'text/css; charset=utf-8')):
                connection = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=3)
                connection.request('GET', path)
                response = connection.getresponse()
                response.read()
                connection.close()
                with self.subTest(path=path):
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader('Content-Type'), content_type)
                    self.assertIn("script-src 'self'", response.getheader('Content-Security-Policy') or '')
        finally:
            httpd.shutdown()
            httpd.server_close()


class CalendarStateTests(unittest.TestCase):
    def test_calendar_state_three_cases(self):
        self.assertEqual(CalendarMeetings(executable='').state(), 'tool_missing')
        self.assertEqual(CalendarMeetings(executable='/bin/gws', enabled=lambda: False).state(), 'not_connected')
        self.assertEqual(CalendarMeetings(executable='/bin/gws', enabled=lambda: True).state(), 'connected')
        self.assertEqual(CalendarMeetings(executable='/bin/gws').state(), 'connected')

    def test_gws_installed_after_start_is_found_on_the_next_read(self):
        # Home's Check again after installing the calendar reader: no restart needed.
        with mock.patch('calendar_meetings.shutil.which', return_value=None):
            calendar = CalendarMeetings()
            self.assertEqual(calendar.state(), 'tool_missing')
        with mock.patch('calendar_meetings.shutil.which', return_value='/opt/bin/gws'):
            self.assertEqual(calendar.state(), 'connected')
            self.assertEqual(calendar.executable, '/opt/bin/gws')
        # A reader given by the caller (tests, Windows path) is never looked up again.
        with mock.patch('calendar_meetings.shutil.which', return_value='/opt/bin/gws'):
            self.assertEqual(CalendarMeetings(executable='').state(), 'tool_missing')


class SkipRecordingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'skip-recording.json'
        self.skips = SkipRecording(self.path)

    def test_skip_set_and_clear_by_event_id(self):
        call = meeting('evt-1')
        self.assertFalse(self.skips.skipped(call))
        self.skips.set(call, True, NOW)
        self.assertTrue(self.skips.skipped(call))
        self.assertTrue(self.skips.skipped({**call, 'title': 'Renamed'}))
        self.assertEqual(json.loads(self.path.read_text()), {'version': 1, 'calls': [
            {'key': 'evt-1', 'event_id': 'evt-1', 'start': call['start'], 'end': call['end'], 'scheduled_end': call['end']}]})
        self.assertNotIn('Pilot review', self.path.read_text())
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.skips.set(call, False, NOW)
        self.assertFalse(self.skips.skipped(call))
        self.assertEqual(json.loads(self.path.read_text())['calls'], [])

    def test_skip_key_falls_back_to_start_and_title(self):
        first, second = meeting(title='Pilot review'), meeting(title='Example LLC sync')
        self.assertEqual(SkipRecording.key(first), first['start'] + '|Pilot review')
        self.skips.set(first, True, NOW)
        self.assertTrue(self.skips.skipped(first))
        self.assertFalse(self.skips.skipped(second))

    def test_skip_prunes_calls_ended_a_day_ago(self):
        # An ended call stays a day: a recorder holding its skip through an overrun keeps it until the mic is let go.
        early = meeting('evt-early', start=NOW, minutes=30)
        self.skips.set(early, True, NOW)
        self.skips.set(meeting('evt-late'), True, NOW + timedelta(hours=1))
        self.assertEqual([call['key'] for call in json.loads(self.path.read_text())['calls']], ['evt-early', 'evt-late'])
        self.skips.set(meeting('evt-next', start=NOW + timedelta(days=3)), True, NOW + timedelta(days=2))
        self.assertEqual([call['key'] for call in json.loads(self.path.read_text())['calls']], ['evt-next'])

    def stored(self):
        return {item['key']: item['end'] for item in json.loads(self.path.read_text())['calls']}

    def test_skip_ends_five_minutes_before_the_next_call(self):
        # Skip 10:00-10:30; the next call at 10:20 is joined early, so the skip ends at 10:15.
        skipped, following = call('evt-a', NOW), call('evt-b', NOW + timedelta(minutes=20))
        self.skips.set(skipped, True, NOW - timedelta(hours=1), meetings=[skipped, following])
        self.assertEqual(self.stored(), {'evt-a': (NOW + timedelta(minutes=15)).isoformat()})
        # A call that starts inside the skip without its own calendar event stays skipped: no clip without an event.
        self.skips.set(skipped, True, NOW - timedelta(hours=1), meetings=[skipped])
        self.assertEqual(self.stored(), {'evt-a': skipped['end']})

    def test_skip_is_not_clipped_by_a_skipped_call_a_solo_block_or_a_call_too_close(self):
        skipped = call('evt-a', NOW)
        later = call('evt-later', NOW + timedelta(minutes=40))
        solo = {**meeting('evt-solo', start=NOW + timedelta(minutes=20)), 'attendees': [{'email': 'me@example.com', 'self': True}], 'link': ''}
        close = call('evt-close', NOW + timedelta(minutes=3))
        both = call('evt-b', NOW + timedelta(minutes=20))
        self.skips.set(skipped, True, NOW - timedelta(hours=1), meetings=[skipped, later, solo, close])
        self.assertEqual(self.stored(), {'evt-a': skipped['end']})
        self.skips.set(both, True, NOW - timedelta(hours=1), meetings=[skipped, both])
        self.assertEqual(self.stored(), {'evt-a': skipped['end'], 'evt-b': both['end']})

    def test_a_cancelled_next_call_gives_the_skip_its_full_window_back(self):
        skipped, following = call('evt-a', NOW), call('evt-b', NOW + timedelta(minutes=20))
        self.skips.set(skipped, True, NOW - timedelta(hours=1), meetings=[skipped, following])
        self.assertEqual(self.stored(), {'evt-a': (NOW + timedelta(minutes=15)).isoformat()})
        # evt-b is gone, but the read was partial or the calendar is off: the clip stays.
        self.skips.clip([skipped])
        self.skips.set(call('evt-c', NOW + timedelta(hours=3)), True, NOW - timedelta(hours=1), meetings=[skipped])
        self.assertEqual(self.stored()['evt-a'], (NOW + timedelta(minutes=15)).isoformat())
        # A connected calendar read both days and evt-b is gone (cancelled): the full window comes back.
        self.skips.clip([skipped], restore=True)
        self.assertEqual(self.stored()['evt-a'], skipped['end'])

    def test_clip_applies_to_a_call_booked_after_the_skip(self):
        skipped = call('evt-a', NOW)
        self.skips.set(skipped, True, NOW - timedelta(hours=1), meetings=[skipped])
        before = self.path.stat().st_mtime_ns
        self.skips.clip([skipped])
        self.assertEqual(self.path.stat().st_mtime_ns, before, 'nothing to clip writes nothing')
        self.skips.clip([skipped, call('evt-b', NOW + timedelta(minutes=20))])
        self.assertEqual(self.stored(), {'evt-a': (NOW + timedelta(minutes=15)).isoformat()})
        self.assertTrue(self.skips.skipped(skipped))

    def test_skip_rejects_bad_times(self):
        for call in ({**meeting('evt-1'), 'start': '2026-11-21T11:00:00'},
                     meeting('evt-1', minutes=0), meeting('evt-1', minutes=-30),
                     {**meeting('evt-1'), 'end': 'soon'}):
            with self.subTest(call=call), self.assertRaises(ValueError):
                self.skips.set(call, True, NOW)
        self.assertFalse(self.path.exists())

    def test_unreadable_file_reads_as_nothing_skipped(self):
        for text in ('not json', '[]', '{"calls": "x"}', '{"calls": [1, {"key": 2}]}'):
            with self.subTest(text=text):
                self.path.write_text(text)
                self.assertFalse(self.skips.skipped(meeting('evt-1')))
                self.skips.set(meeting('evt-1'), True, NOW)
                self.assertTrue(self.skips.skipped(meeting('evt-1')))


class FakeCalendar:
    def __init__(self, state='not_connected'):
        self.value = state

    def state(self):
        return self.value


class FakePlans:
    calendar = FakeCalendar()

    def agenda(self, now=None, memo=None):
        return {'calendar': False, 'meetings': [meeting('evt-1'), meeting('evt-2')], 'unscheduled_plans': []}


class FakeSkips:
    def __init__(self):
        self.clipped = None

    def skipped(self, call):
        return call['event_id'] == 'evt-2'

    def clip(self, meetings, restore=False):
        self.clipped, self.restore = meetings, restore


class FailingPlans(FakePlans):
    """Today was read, tomorrow could not be."""
    calendar = CalendarMeetings(executable='/bin/gws')

    def agenda(self, now=None, memo=None):
        return {'calendar': True, 'meetings': [meeting('evt-1')], 'unscheduled_plans': [],
                'failed_days': [(NOW + timedelta(days=1)).date().isoformat()]}


class FakeProbe:
    def __init__(self, supported):
        self.supported = supported

    def snapshot(self):
        return {'microphone': 'granted', 'call_audio': 'granted', 'skip_recording': self.supported}


class SkipSwitchedOffTests(unittest.TestCase):
    """R35: "Do not record" is off in this release whatever the recorder says (MEETONTRACK-173)."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'skip-recording.json'
        self.path.write_text('{"version": 1, "calls": []}')

    def test_shipped_default_is_off(self):
        self.assertIs(server.SKIP_RECORDING_ENABLED, False)

    def test_agenda_offers_no_skip_and_shows_no_stored_one(self):
        skips = FakeSkips()
        with mock.patch.object(server, 'PLANS', FakePlans()), mock.patch.object(server, 'SKIPS', skips), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)):
            payload = server.agenda_payload(NOW)
        self.assertIs(payload['skip_recording_supported'], False)
        self.assertEqual([item['skip_recording'] for item in payload['meetings']], [False, False])
        self.assertIsNone(skips.clipped, 'the skip file is not touched')

    def test_route_answers_409_and_never_writes_the_file(self):
        before = self.path.read_bytes()
        port = serve(self)
        with mock.patch.object(server, 'SKIPS', SkipRecording(self.path)), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)):
            status, body = request(port, 'POST', '/api/agenda/skip-recording', {**meeting('evt-1'), 'skip': True})
        self.assertEqual((status, body), (409, {'ok': False, 'error': 'recorder_cannot_skip'}))
        self.assertEqual(self.path.read_bytes(), before)


class AgendaRouteTests(unittest.TestCase):
    def setUp(self):
        # Test seam: these cover the skip code kept for MEETONTRACK-173, so they switch it on explicitly.
        switch = mock.patch.object(server, 'SKIP_RECORDING_ENABLED', True)
        switch.start()
        self.addCleanup(switch.stop)

    def test_agenda_payload_fields(self):
        with mock.patch.object(server, 'PLANS', FakePlans()), mock.patch.object(server, 'SKIPS', FakeSkips()), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)):
            payload = server.agenda_payload(NOW)
            status, body = request(serve(self), 'GET', '/api/agenda')
        self.assertEqual(payload['calendar_state'], 'not_connected')
        self.assertIs(payload['skip_recording_supported'], True)
        self.assertEqual([item['skip_recording'] for item in payload['meetings']], [False, True])
        self.assertEqual(status, 200)
        self.assertEqual((body['ok'], body['calendar_state'], body['meetings'][1]['skip_recording']),
                         (True, 'not_connected', True))

    def test_agenda_payload_clips_stored_skips_against_its_meetings(self):
        skips = FakeSkips()
        with mock.patch.object(server, 'PLANS', FakePlans()), mock.patch.object(server, 'SKIPS', skips), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)):
            server.agenda_payload(NOW)
        self.assertEqual([item['event_id'] for item in skips.clipped], ['evt-1', 'evt-2'])
        self.assertFalse(skips.restore, 'a calendar that is not connected never restores a clipped skip')
        plans = FakePlans()
        plans.calendar = FakeCalendar('connected')
        with mock.patch.object(server, 'PLANS', plans), mock.patch.object(server, 'SKIPS', skips), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)):
            server.agenda_payload(NOW)
        self.assertTrue(skips.restore, 'connected, both days read')

    def test_a_failed_calendar_day_is_not_an_empty_day_and_keeps_the_day_that_loaded(self):
        skips = FakeSkips()
        with mock.patch.object(server, 'PLANS', FailingPlans()), mock.patch.object(server, 'SKIPS', skips), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)):
            payload = server.agenda_payload(NOW)
        self.assertEqual((payload['calendar_state'], [item['event_id'] for item in payload['meetings']], payload['failed_days']),
                         ('failed', ['evt-1'], [(NOW + timedelta(days=1)).date().isoformat()]))
        self.assertEqual(([item['event_id'] for item in skips.clipped], skips.restore), (['evt-1'], False),
                         'a partial agenda clips against the day that loaded and never restores')

    def test_agenda_payload_without_calendar_is_tool_missing(self):
        plans = FakePlans()
        plans.calendar = None
        with mock.patch.object(server, 'PLANS', plans), mock.patch.object(server, 'SKIPS', FakeSkips()), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(False)):
            payload = server.agenda_payload(NOW)
        self.assertEqual((payload['calendar_state'], payload['skip_recording_supported']), ('tool_missing', False))

    def test_skip_route_refuses_when_recorder_cannot_honour_it(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / 'skip-recording.json'
        path.write_text('{"version": 1, "calls": []}')
        port = serve(self)
        with mock.patch.object(server, 'SKIPS', SkipRecording(path)), \
                mock.patch.object(server, 'PERMISSIONS', FakeProbe(False)):
            status, body = request(port, 'POST', '/api/agenda/skip-recording', {**meeting('evt-1'), 'skip': True})
        self.assertEqual((status, body), (409, {'ok': False, 'error': 'recorder_cannot_skip'}))
        self.assertEqual(path.read_text(), '{"version": 1, "calls": []}')

    def test_skip_route_stores_and_validates(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        skips = SkipRecording(Path(directory.name) / 'skip-recording.json')
        call = meeting('evt-1', start=datetime.now(timezone.utc) + timedelta(hours=1))
        port = serve(self)
        with mock.patch.object(server, 'SKIPS', skips), mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)), \
                mock.patch.object(server, 'capture_recording', return_value=False):  # not this machine's recorder
            self.assertEqual(request(port, 'POST', '/api/agenda/skip-recording', {**call, 'skip': True}),
                             (200, {'ok': True}))
            self.assertTrue(skips.skipped(call))
            for bad in ({**call, 'skip': 'yes'}, {**call, 'skip': True, 'event_id': 5},
                        {**call, 'skip': True, 'title': 'x' * 301}, {**call, 'skip': True, 'event_id': 'e' * 1025},
                        {**call, 'skip': True, 'start': 'later'}, {'skip': True}):
                with self.subTest(bad=bad):
                    status, body = request(port, 'POST', '/api/agenda/skip-recording', bad)
                    self.assertEqual(status, 400)
                    self.assertFalse(body['ok'])
            self.assertTrue(skips.skipped(call))

    def skip_route(self, payload, recording, plans=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        skips = SkipRecording(Path(directory.name) / 'skip-recording.json')
        port = serve(self)
        with mock.patch.object(server, 'SKIPS', skips), mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)), \
                mock.patch.object(server, 'capture_recording', side_effect=recording if callable(recording) else lambda: recording), \
                mock.patch.object(server, 'PLANS', plans or FakePlans()):
            return request(port, 'POST', '/api/agenda/skip-recording', payload), skips

    def test_skip_refused_while_any_recording_runs(self):
        # R32: whichever call the running capture is, a skip cannot stop it, so none is taken while one runs.
        now = datetime.now(timezone.utc)
        running = meeting('evt-now', start=now - timedelta(minutes=10))
        for asked in (running, meeting('evt-soon', start=now + timedelta(minutes=3)), meeting('evt-later', start=now + timedelta(hours=2))):
            with self.subTest(asked=asked['event_id']):
                (answer, skips) = self.skip_route({**asked, 'skip': True}, recording=True)
                self.assertEqual(answer, (409, {'ok': False, 'error': 'recording_active'}))
                self.assertFalse(skips.skipped(asked))
        # Undo of a skip, or no recording: accepted.
        for payload, recording in (({**running, 'skip': False}, True), ({**running, 'skip': True}, False)):
            with self.subTest(payload=payload['skip'], recording=recording):
                self.assertEqual(self.skip_route(payload, recording)[0], (200, {'ok': True}))

    def test_skip_rechecks_the_capture_after_reading_the_agenda(self):
        now = datetime.now(timezone.utc)
        running = meeting('evt-now', start=now - timedelta(minutes=1))
        capture = {'on': False}

        class Plans(FakePlans):
            def agenda(self, now=None, memo=None):
                capture['on'] = True  # recording starts while the calendar is read
                return super().agenda(now, memo)

        (answer, skips) = self.skip_route({**running, 'skip': True}, lambda: capture['on'], Plans())
        self.assertEqual(answer, (409, {'ok': False, 'error': 'recording_active'}))
        self.assertFalse(skips.skipped(running))

    def test_skip_route_clips_against_the_agenda(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        skipped, following = call('evt-a', now + timedelta(hours=1)), call('evt-b', now + timedelta(hours=1, minutes=20))

        class Plans(FakePlans):
            def agenda(self, now=None, memo=None):
                return {'calendar': True, 'meetings': [skipped, following], 'unscheduled_plans': []}

        (answer, skips) = self.skip_route({**meeting('evt-a', start=now + timedelta(hours=1)), 'skip': True}, False, Plans())
        self.assertEqual(answer, (200, {'ok': True}))
        self.assertEqual([item['end'] for item in json.loads(skips.path.read_text())['calls']],
                         [(now + timedelta(hours=1, minutes=15)).isoformat()])
        # Tomorrow could not be read: today's following call still ends the skip before it.
        class Partial(FakePlans):
            def agenda(self, now=None, memo=None):
                return {'calendar': True, 'meetings': [skipped, following], 'unscheduled_plans': [],
                        'failed_days': [(now + timedelta(days=1)).date().isoformat()]}

        (answer, skips) = self.skip_route({**meeting('evt-a', start=now + timedelta(hours=1)), 'skip': True}, False, Partial())
        self.assertEqual(answer, (200, {'ok': True}))
        self.assertEqual([item['end'] for item in json.loads(skips.path.read_text())['calls']],
                         [(now + timedelta(hours=1, minutes=15)).isoformat()])


class CalendarFailureTests(unittest.TestCase):
    def test_a_failed_read_raises_and_is_not_kept_as_an_empty_day(self):
        calendar = CalendarMeetings(executable='/bin/gws')
        failed = mock.Mock(returncode=1, stdout='')
        empty = mock.Mock(returncode=0, stdout=json.dumps({'items': []}))
        clock = [1000.0]
        with mock.patch('calendar_meetings.subprocess.run', return_value=failed), \
                mock.patch('calendar_meetings.time.monotonic', side_effect=lambda: clock[0]):
            with self.assertRaises(CalendarUnavailable):
                calendar.for_day(NOW.date())
            for broken in (OSError('gws gone'), ValueError('not json')):
                with self.subTest(broken=broken), mock.patch('calendar_meetings.subprocess.run', side_effect=broken), \
                        self.assertRaises(CalendarUnavailable):
                    clock[0] += 60
                    calendar.for_day(NOW.date())
            clock[0] += 60  # a minute later the calendar is read again, not served from a cache
            with mock.patch('calendar_meetings.subprocess.run', return_value=empty):
                self.assertEqual(calendar.for_day(NOW.date()), [])


if __name__ == '__main__':
    unittest.main()
