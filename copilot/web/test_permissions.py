import http.client
import json
import subprocess
import tempfile
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
            ({('HKCU', STORE): 'Deny'}, 'denied'),
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

    def test_windows_unreadable_machine_key_is_unknown(self):
        def read(hive, path):
            if hive == 'HKLM':
                raise PermissionError(5, 'Access is denied')
            return 'Allow'
        probe = RecorderProbe(self.binary, run=fake_run('{}'), os_name='nt', read_registry=read)
        self.assertEqual(probe.snapshot()['microphone'], 'unknown')

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

    def test_invalidate_reads_again(self):
        calls = []
        probe = RecorderProbe(self.binary, run=fake_run('{}', calls=calls), os_name='posix', ttl=30)
        probe.snapshot()
        probe.invalidate()
        probe.snapshot()
        self.assertEqual(len(calls), 2)


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
        # Never the real settings file: no config means the recorders' defaults.
        patcher = mock.patch.object(server, 'CAPTURE_CONFIG_FILE', Path('/nonexistent/meeting-copilot/config.json'))
        patcher.start()
        self.addCleanup(patcher.stop)
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
                mock.patch.object(server, 'recorder_running', return_value=False), \
                mock.patch.object(server.sys, 'platform', 'darwin'):
            status, payload = self.request('GET', '/api/permissions')
        self.assertEqual(status, 200)
        # The platform says what a denied microphone costs: on macOS the call audio is still recorded.
        self.assertEqual(json.loads(payload), {'ok': True, 'microphone': 'denied', 'call_audio': 'granted',
                                               'recorder': 'stopped', 'auto_record': True, 'platform': 'macos'})
        for platform, expected in (('win32', 'windows'), ('linux', 'other')):
            with self.subTest(platform=platform), mock.patch.object(server, 'PERMISSIONS', FakeProbe()), \
                    mock.patch.object(server, 'recorder_running', return_value=False), \
                    mock.patch.object(server.sys, 'platform', platform):
                self.assertEqual(json.loads(self.request('GET', '/api/permissions')[1])['platform'], expected)

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

    def test_fresh_read_drops_the_cached_answer(self):
        # The person comes back from System Settings: that read asks the recorder again, others keep the cache.
        probe = mock.Mock(**{'snapshot.return_value': FakeProbe().snapshot()})
        with mock.patch.object(server, 'PERMISSIONS', probe), \
                mock.patch.object(server, 'recorder_running', return_value=False):
            self.assertEqual(self.request('GET', '/api/permissions')[0], 200)
            probe.invalidate.assert_not_called()
            self.assertEqual(self.request('GET', '/api/permissions?fresh=1')[0], 200)
            probe.invalidate.assert_called_once_with()
            with mock.patch.object(server, 'open_settings'):
                self.request('POST', '/api/permissions/open', {'which': 'microphone'})
            probe.invalidate.assert_called_once_with()

    def test_open_failure_is_generic(self):
        with mock.patch.object(server, 'open_settings', side_effect=OSError('secret detail')):
            status, payload = self.request('POST', '/api/permissions/open', {'which': 'microphone'})
        self.assertEqual((status, json.loads(payload)), (500, {'ok': False, 'error': 'open_failed'}))

    def test_recorder_running_is_cached(self):
        server._RECORDER_RUNNING = None
        self.addCleanup(setattr, server, '_RECORDER_RUNNING', None)
        with mock.patch.object(server.os, 'name', 'posix'), \
                mock.patch.object(server.subprocess, 'run', return_value=subprocess.CompletedProcess(
                    [], 0, stdout='', stderr='')) as run:
            self.assertFalse(server.recorder_running())
            self.assertFalse(server.recorder_running())
        self.assertEqual(run.call_count, 1)

    def test_recorder_states(self):
        for value, expected in ((True, 'running'), (None, 'unknown')):
            with self.subTest(value=value), mock.patch.object(server, 'PERMISSIONS', FakeProbe()), \
                    mock.patch.object(server, 'recorder_running', return_value=value):
                self.assertEqual(json.loads(self.request('GET', '/api/permissions')[1])['recorder'], expected)


    def test_auto_record_from_the_shared_config(self):
        # The recorders' own keys and defaults: on, starting from the mic; off when it is off or has nothing to start from.
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        config = Path(directory.name) / 'config.json'
        for text, expected in ((None, True), ('not json', True), ('{"auto_record": {"enabled": false}}', False),
                               ('{"auto_record": {"mic_activity": false}}', False),
                               ('{"auto_record": {"mic_activity": false, "calendar": true}}', True),
                               ('{"auto_record": {"enabled": true}, "live_transcription": {}}', True)):
            if text is None:
                config.unlink(missing_ok=True)
            else:
                config.write_text(text)
            with self.subTest(text=text), mock.patch.object(server, 'PERMISSIONS', FakeProbe()), \
                    mock.patch.object(server, 'recorder_running', return_value=True), \
                    mock.patch.object(server, 'CAPTURE_CONFIG_FILE', config):
                self.assertIs(json.loads(self.request('GET', '/api/permissions')[1])['auto_record'], expected)

    def test_auto_record_on_windows_needs_mic_activity(self):
        # The Windows recorder starts only from microphone activity and has no calendar trigger.
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        config = Path(directory.name) / 'config.json'
        for text, expected in (('{"auto_record": {"mic_activity": false, "calendar": true}}', False),
                               ('{"auto_record": {"calendar": true}}', True)):
            config.write_text(text)
            with self.subTest(text=text), mock.patch.object(server, 'PERMISSIONS', FakeProbe()), \
                    mock.patch.object(server, 'recorder_running', return_value=True), \
                    mock.patch.object(server, 'CAPTURE_CONFIG_FILE', config), mock.patch.object(server.sys, 'platform', 'win32'):
                self.assertIs(json.loads(self.request('GET', '/api/permissions')[1])['auto_record'], expected)

if __name__ == '__main__':
    unittest.main()
