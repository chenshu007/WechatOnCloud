"""Exercise the real installer with local fake tools; no downloads or live UI.

Every state/install/work path belongs to a TemporaryDirectory. pkill is mocked.
On macOS the flock shim uses fcntl.flock on the inherited file descriptor; on
Linux it exercises the same OS locking semantics used by util-linux flock.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'wechat-ctl.sh'
MOCK = r'''
import fcntl, json, os, pathlib, sys, tarfile
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['MOCK_ROOT'])
scenario = os.environ.get('SCENARIO', 'ok')
trace = root / 'trace.jsonl'
def record(data):
    with trace.open('a') as f: f.write(json.dumps(data) + '\n')
if tool == 'flock':
    try: fcntl.flock(int(args[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(1)
elif tool == 'dpkg':
    print('amd64')
elif tool == 'df':
    print('Filesystem 1024-blocks Used Available Capacity Mounted on')
    print('test 20000000 10 %s 1%% /' % ('1' if scenario == 'disk-full' else '10000000'))
elif tool == 'stat':
    print(pathlib.Path(args[-1]).stat().st_size)
elif tool == 'curl':
    if '-fsSLI' in args:
        print('Content-Length: 100')
    else:
        dest = pathlib.Path(args[args.index('-o') + 1])
        prior = dest.read_bytes() if dest.exists() else b''
        record({'tool': tool, 'args': args, 'prior': prior.decode(), 'file': dest.name})
        if scenario == 'write-failure': sys.exit(23)
        with dest.open('ab') as f: f.write(b'x' * 100)
        if scenario == 'network-failure': sys.exit(7)
        if scenario == 'resume' and not prior: sys.exit(7)
elif tool == 'dpkg-deb':
    if args[0] == '-f': print('9.9-test')
    elif args[0] == '--fsys-tarfile':
        if scenario == 'corrupt-data': sys.exit(2)
        with tarfile.open(fileobj=sys.stdout.buffer, mode='w|'): pass
    elif args[0] == '-x':
        target = pathlib.Path(args[-1]) / 'opt/wechat/wechat'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('test-new')
        target.chmod(0o755)
elif tool == 'pkill':
    record({'tool': tool})
else: sys.exit(99)
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='woc-install-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for tool in ['flock', 'dpkg', 'df', 'stat', 'curl', 'dpkg-deb', 'pkill']:
            path = self.bin / tool
            path.write_text('#!' + sys.executable + '\n' + MOCK)
            path.chmod(0o755)
        sleep = self.bin / 'sleep'
        sleep.write_text('#!/bin/sh\n/bin/sleep 0.01\n')
        sleep.chmod(0o755)
        self.install = self.root / 'wechat'
        self.old_bin = self.install / 'opt/wechat/wechat'
        self.old_bin.parent.mkdir(parents=True)
        self.old_bin.write_text('test-old')
        self.old_bin.chmod(0o755)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.work = self.root / 'work'
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        MOCK_ROOT=str(self.root), WOC_STATE_DIR=str(self.state),
                        WOC_WORK_DIR=str(self.work), WOC_INSTALL_DIR=str(self.install),
                        WECHAT_CDN='https://main.invalid', WECHAT_CDN_FALLBACK='https://fallback.invalid')

    def run_install(self, scenario='ok'):
        return subprocess.run(['bash', str(SCRIPT), 'install'],
                              env=dict(self.env, SCENARIO=scenario),
                              capture_output=True, text=True, timeout=15)

    def events(self):
        path = self.root / 'trace.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def status(self):
        return json.loads((self.state / 'status.json').read_text())

    def test_success_replaces_install_and_releases_lock(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.status()['phase'], 'done')
        self.assertEqual(self.old_bin.read_text(), 'test-new')
        self.assertEqual(sum(e['tool'] == 'pkill' for e in self.events()), 1)
        with (self.state / '.install.flock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_second_installer_cannot_modify_state_under_lock(self):
        with (self.state / '.install.flock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_install()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.events(), [])
            self.assertFalse((self.state / 'status.json').exists())
            self.assertEqual(self.old_bin.read_text(), 'test-old')

    def test_low_disk_space_stops_before_download(self):
        self.run_install('disk-full')
        self.assertIn('磁盘空间不足', self.status()['message'])
        self.assertEqual(self.events(), [])
        self.assertEqual(self.old_bin.read_text(), 'test-old')

    def test_write_failure_stops_after_one_attempt(self):
        self.run_install('write-failure')
        self.assertIn('磁盘空间不足', self.status()['message'])
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(self.old_bin.read_text(), 'test-old')

    def test_network_failure_preserves_partials_and_original_install(self):
        self.run_install('network-failure')
        self.assertEqual(self.status()['phase'], 'error')
        self.assertTrue((self.work / 'wechat-main.deb').exists())
        self.assertTrue((self.work / 'wechat-fallback.deb').exists())
        self.assertEqual(self.old_bin.read_text(), 'test-old')
        self.assertFalse(any(e['tool'] == 'pkill' for e in self.events()))

    def test_resume_uses_existing_bytes_and_keeps_mirrors_separate(self):
        result = self.run_install('resume')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [e for e in self.events() if e['tool'] == 'curl']
        self.assertEqual([e['file'] for e in calls], ['wechat-main.deb', 'wechat-fallback.deb', 'wechat-main.deb'])
        self.assertEqual([len(e['prior']) for e in calls], [0, 0, 100])
        self.assertTrue(all('-C' in e['args'] for e in calls))
        self.assertEqual(self.status()['phase'], 'done')

    def test_valid_control_metadata_but_corrupt_data_archive_never_installs(self):
        self.run_install('corrupt-data')
        self.assertEqual(self.status()['phase'], 'error')
        self.assertEqual(self.old_bin.read_text(), 'test-old')
        self.assertFalse(any(e['tool'] == 'pkill' for e in self.events()))


if __name__ == '__main__':
    unittest.main()
