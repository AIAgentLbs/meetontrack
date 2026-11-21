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
from calendar_meetings import CalendarMeetings
from skip_recording import SkipRecording

NOW = datetime(2026, 11, 21, 10, 0, tzinfo=timezone.utc)


def meeting(event_id='', title='Pilot review', start=NOW + timedelta(hours=1), minutes=30):
    return {'event_id': event_id, 'title': title, 'start': start.isoformat(),
            'end': (start + timedelta(minutes=minutes)).isoformat()}


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
            {'key': 'evt-1', 'event_id': 'evt-1', 'start': call['start'], 'end': call['end']}]})
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

    def test_skip_prunes_ended_calls(self):
        early = meeting('evt-early', start=NOW, minutes=30)
        self.skips.set(early, True, NOW)
        self.skips.set(meeting('evt-late'), True, NOW + timedelta(hours=1))
        self.assertEqual([call['key'] for call in json.loads(self.path.read_text())['calls']], ['evt-late'])

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
    def state(self):
        return 'not_connected'


class FakePlans:
    calendar = FakeCalendar()

    def agenda(self, now=None):
        return {'calendar': False, 'meetings': [meeting('evt-1'), meeting('evt-2')], 'unscheduled_plans': []}


class FakeSkips:
    def skipped(self, call):
        return call['event_id'] == 'evt-2'


class FakeProbe:
    def __init__(self, supported):
        self.supported = supported

    def snapshot(self):
        return {'microphone': 'granted', 'call_audio': 'granted', 'skip_recording': self.supported}


class AgendaRouteTests(unittest.TestCase):
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
        with mock.patch.object(server, 'SKIPS', skips), mock.patch.object(server, 'PERMISSIONS', FakeProbe(True)):
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


if __name__ == '__main__':
    unittest.main()
