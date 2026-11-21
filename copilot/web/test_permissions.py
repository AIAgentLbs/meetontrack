import http.client
import json
import subprocess
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import server
from permissions import RecorderProbe, open_settings

STORE = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"


def fake_run(stdout='', returncode=0, calls=None):
    def run(args, **kwargs):
        if calls is not None:
            calls.append(args)
        return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr='')
    return run


class RecorderProbeTests(unittest.TestCase):
    binary = Path('/nonexistent/recorder')

    def test_macos_reads_recorder_json(self):
        calls = []
        probe = RecorderProbe(self.binary, run=fake_run(
            '{"microphone":"denied","call_audio":"granted","skip_recording":true}', calls=calls), os_name='posix')
        self.assertEqual(probe.snapshot(), {'microphone': 'denied', 'call_audio': 'granted', 'skip_recording': True})
        self.assertEqual(calls, [[str(self.binary), 'permissions']])

    def test_macos_old_recorder_is_unknown(self):
        probe = RecorderProbe(self.binary, run=fake_run('usage: recorder [run|record]', returncode=64), os_name='posix')
        self.assertEqual(probe.snapshot(), {'microphone': 'unknown', 'call_audio': 'unknown', 'skip_recording': False})

    def test_macos_missing_binary_or_timeout_is_unknown(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired('recorder', 5)):
            def run(args, **kwargs):
                raise error
            with self.subTest(error=type(error).__name__):
                self.assertEqual(RecorderProbe(self.binary, run=run, os_name='posix').snapshot(),
                                 {'microphone': 'unknown', 'call_audio': 'unknown', 'skip_recording': False})

    def test_macos_odd_value_is_unknown(self):
        probe = RecorderProbe(self.binary, run=fake_run(
            '{"microphone":"notAsked","call_audio":"granted","skip_recording":"yes"}'), os_name='posix')
        self.assertEqual(probe.snapshot(), {'microphone': 'unknown', 'call_audio': 'granted', 'skip_recording': False})

    def test_windows_registry_rules(self):
        cases = (
            ({('HKLM', STORE): 'Deny', ('HKCU', STORE): 'Allow'}, 'denied'),
            ({('HKCU', STORE): 'Allow', ('HKCU', STORE + r'\NonPackaged'): 'Deny'}, 'denied'),
            ({}, 'unknown'),
            ({('HKCU', STORE): 'Allow', ('HKCU', STORE + r'\NonPackaged'): 'Allow'}, 'granted'),
        )
        for values, expected in cases:
            with self.subTest(expected=expected, values=values):
                probe = RecorderProbe(self.binary, run=fake_run('{"skip_recording": true}'), os_name='nt',
                                      read_registry=lambda hive, path, values=values: values.get((hive, path)))
                self.assertEqual(probe.snapshot(),
                                 {'microphone': expected, 'call_audio': 'unknown', 'skip_recording': True})

    def test_windows_skip_recording_from_record_status(self):
        calls = []
        probe = RecorderProbe(self.binary, run=fake_run('not json', calls=calls), os_name='nt',
                              read_registry=lambda hive, path: None)
        self.assertFalse(probe.snapshot()['skip_recording'])
        self.assertEqual(calls, [[str(self.binary), 'record', 'status']])

    def test_snapshot_is_cached(self):
        calls = []
        probe = RecorderProbe(self.binary, run=fake_run('{}', calls=calls), os_name='posix', ttl=30)
        probe.snapshot()
        probe.snapshot()
        self.assertEqual(len(calls), 1)


class OpenSettingsTests(unittest.TestCase):
    def test_opens_fixed_pages(self):
        opened = []
        open_settings('microphone', os_name='posix', opener=opened.append)
        open_settings('call_audio', os_name='posix', opener=opened.append)
        open_settings('microphone', os_name='nt', opener=opened.append)
        self.assertEqual(opened, [
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
            'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
            'ms-settings:privacy-microphone',
        ])

    def test_open_rejects_unknown_which(self):
        opened = []
        with self.assertRaises(ValueError):
            open_settings('camera', os_name='posix', opener=opened.append)
        with self.assertRaises(ValueError):
            open_settings('call_audio', os_name='nt', opener=opened.append)
        self.assertEqual(opened, [])


class FakeProbe:
    def snapshot(self):
        return {'microphone': 'denied', 'call_audio': 'granted', 'skip_recording': True}


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=3)
        data = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, body=data, headers={'Content-Type': 'application/json', **(headers or {})})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, payload

    def test_routes(self):
        with mock.patch.object(server, 'PERMISSIONS', FakeProbe()), \
                mock.patch.object(server, 'recorder_running', return_value=False):
            status, payload = self.request('GET', '/api/permissions')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload), {'ok': True, 'microphone': 'denied', 'call_audio': 'granted',
                                               'recorder': 'stopped'})

        with mock.patch.object(server, 'open_settings') as opener:
            status, _ = self.request('POST', '/api/permissions/open', {'which': 'microphone'},
                                     {'Origin': 'http://example.org'})
            self.assertEqual(status, 403)
            opener.assert_not_called()

        status, payload = self.request('POST', '/api/permissions/open', {'which': 'camera'})
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(payload)['ok'])

        with mock.patch.object(server, 'open_settings') as opener:
            status, payload = self.request('POST', '/api/permissions/open', {'which': 'microphone'})
        self.assertEqual((status, json.loads(payload)), (200, {'ok': True}))
        opener.assert_called_once_with('microphone')

    def test_recorder_states(self):
        for value, expected in ((True, 'running'), (None, 'unknown')):
            with self.subTest(value=value), mock.patch.object(server, 'PERMISSIONS', FakeProbe()), \
                    mock.patch.object(server, 'recorder_running', return_value=value):
                self.assertEqual(json.loads(self.request('GET', '/api/permissions')[1])['recorder'], expected)


if __name__ == '__main__':
    unittest.main()
