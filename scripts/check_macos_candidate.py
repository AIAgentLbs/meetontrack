"""Verify exact release bytes and install twice into disposable user directories.

No Capture process or LaunchAgent is started; launchctl and open are fakes.
The bundled server is started once on a spare port with a disposable HOME to
prove the payload runs and exits when its parent's stdin closes. This does not
claim hardware or Gatekeeper acceptance. Upgrade from 0.1.18-0.1.20 is simulated
with their on-disk layout (agent plist, separate python/web/bin copies).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import time
import urllib.request
import zipfile

from test_installer import InstallerTests


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    archive_path = args.archive.resolve(strict=True)
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive_path) as archive:
        manifest = json.loads(archive.read('release.json'))
        names = {entry.filename for entry in archive.infolist() if not entry.is_dir()}
        assert names == set(manifest['sha256']) | {'release.json'}, 'Unmanifested files'
        for name, expected in manifest['sha256'].items():
            assert not Path(name).is_absolute() and '..' not in Path(name).parts
            data = archive.read(name)
            # zip -y stores symlink targets, also hashed in the manifest.
            mode = archive.getinfo(name).external_attr >> 16
            if mode & 0o170000 == 0o120000:
                target = data.decode()
                assert not os.path.isabs(target) and '..' not in Path(target).parts
            assert hashlib.sha256(data).hexdigest() == expected, f'Checksum mismatch: {name}'
        info = plistlib.loads(archive.read('Meeting Copilot Capture.app/Contents/Info.plist'))
        assert info['CFBundleDisplayName'] == 'MeetOnTrack'
        assert info['CFBundleShortVersionString'] == manifest['version']
        assert not any(name.startswith('payload/') for name in names), 'payload must be inside the app'

    fixture = InstallerTests()
    fixture.setUp()
    try:
        fixture.env['FIXTURE_PACKAGE'] = str(archive_path)
        fixture.env['MEETING_COPILOT_ASSET_SHA256'] = digest
        app, share, config = fixture.seed_existing()
        shutil.rmtree(app)  # the real 0.1.18 app is not needed; its layout around it is
        settings = (config / 'config.json').read_bytes()
        fixture.script('launchctl', 'printf "%s\\n" "$*" >> "$FIXTURE_ROOT/launches"; [ "$1" = print ] && exit 113; exit 0')
        result = fixture.run_install()
        assert result.returncode == 0, result.stderr + result.stdout
        assert 'bootout' in (fixture.root / 'launches').read_text()
        assert not (Path(fixture.env['MEETING_COPILOT_AGENTS_ROOT']) / 'com.aiagentlbs.meeting-copilot.plist').exists()
        for program in ('python', 'web', 'bin', 'release.json'):
            assert not (share / program).exists(), program
        assert (config / 'config.json').read_bytes() == settings
        for data in ('recordings/keep.txt', 'archive/a/meeting.md', 'reports/r.pdf', 'models/m.bin'):
            assert (share / data).read_text() == 'synthetic-' + data
        assert [path.name for path in app.parent.iterdir()] == [app.name]
        subprocess.run(['codesign', '--verify', '--strict', str(app)], check=True)
        payload = app / 'Contents/Resources/payload'
        runtime = payload / 'python/bin/python3'
        for helper in ('zoom-window-finder', 'zoom-frame-inspector', 'detect-speech-language'):
            subprocess.run(['codesign', '--verify', '--strict', str(payload / 'bin' / helper)], check=True)
        subprocess.run([str(runtime), '-I', '-B', '-c', 'import numpy, PIL.Image'], check=True)
        served = smoke_server(runtime, payload / 'web', fixture.root / 'server-home', manifest['version'], config)
        subprocess.run(['codesign', '--verify', '--strict', str(app)], check=True)  # nothing written into it
        recording = share / 'recordings' / 'synthetic-keep.txt'
        recording.write_text('synthetic recording preservation check')
        result = fixture.run_install()
        assert result.returncode == 0, result.stderr + result.stdout
        assert recording.read_text() == 'synthetic recording preservation check'
        assert (config / 'config.json').read_bytes() == settings
        assert not (fixture.root / 'compiled').exists()
        print(json.dumps({'version': manifest['version'], 'source_revision': manifest['source_revision'],
                          'sha256': digest, 'manifest_files': len(manifest['sha256']),
                          'upgrade_from_0_1_20_layout': 'passed', 'reinstall_preserves_data': 'passed',
                          'signatures': 'ad-hoc valid', 'bundled_server': served,
                          'hardware_test': 'not performed'}, indent=2))
    finally:
        fixture.doCleanups()


def smoke_server(runtime, web, home, version, config, port=43987):
    """Start the bundled server as the app does, check health, then close stdin."""
    shutil.copytree(config, home / '.config/meeting-copilot')  # what install.sh wrote
    with socket.socket() as probe:  # an answer must come from our child, not a leftover
        probe.bind(('127.0.0.1', port))
    process = subprocess.Popen([str(runtime), '-B', str(web / 'server.py'), '--port', str(port), '--no-open',
                                '--exit-with-parent'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env={'HOME': str(home), 'PATH': '/usr/bin:/bin',
                                                               'PYTHONDONTWRITEBYTECODE': '1',
                                                               'MEETONTRACK_INSTANCE': 'candidate-check'}, cwd=home)
    try:
        for _ in range(120):
            assert process.poll() is None, f'bundled server exited early ({process.returncode})'
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1) as response:
                    health = json.load(response)
                break
            except OSError:
                time.sleep(0.25)
        else:
            raise AssertionError('bundled server did not answer')
        # The app adopts only the server that echoes its own launch token (MEETONTRACK-116).
        assert health == {'ok': True, 'service': 'meeting-copilot', 'version': version,
                          'instance': 'candidate-check'}, health
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=5) as response:
            assert b'MeetOnTrack' in response.read()
        assert os.getpgid(process.pid) == process.pid, 'the server leads its own process group (MEETONTRACK-114)'
        process.stdin.close()  # the app is gone
        assert process.wait(timeout=10) == 0, f'bundled server exit status {process.returncode}'
        return 'health, instance token, process group, index and exit-with-parent passed'
    finally:
        if process.poll() is None:
            process.kill()


if __name__ == '__main__':
    main()
