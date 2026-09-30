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
    st = pathlib.Path(args[-1]).stat()
    if '-Lc' in args: print(str(st.st_dev) + ' ' + str(st.st_ino))
    else: print(st.st_size)
elif tool == 'curl':
    if '-fsSLI' in args:
        print('Content-Length: 100')
    else:
        dest = pathlib.Path(args[args.index('-o') + 1])
        prior = dest.read_bytes() if dest.exists() else b''
        record({'tool': tool, 'args': args, 'prior': prior.decode(), 'file': dest.name})
        if scenario == 'write-failure': sys.exit(23)
        if scenario.startswith('unreachable-'):
            code = int(scenario.split('-')[1]); print('000 0.000000'); sys.exit(code)
        if scenario == 'mixed-network':
            print('000 0.000000')
            if 'fallback' in dest.name: sys.exit(6)
            with dest.open('ab') as f: f.write(b'x' * 10)
            sys.exit(56)
        if scenario == 'connected-timeout': print('000 0.050000'); sys.exit(28)
        if scenario == 'range-reset' and prior: sys.exit(33)
        if scenario == 'slow-download':
            (root/'started').write_text('yes')
            import time
            time.sleep(60)
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
elif tool == 'mv':
    if scenario == 'swap-failure' and args[-2].endswith('/new'): sys.exit(1)
    import shutil
    shutil.move(args[-2], args[-1])
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
        for tool in ['flock', 'dpkg', 'df', 'stat', 'curl', 'dpkg-deb', 'pkill', 'mv']:
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

    def test_both_mirrors_fail_before_transfer_stop_after_first_round(self):
        for code in [5, 6, 7, 28, 35, 60]:
            with self.subTest(code=code):
                trace = self.root / 'trace.jsonl'
                if trace.exists(): trace.unlink()
                result = self.run_install('unreachable-' + str(code))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(len(self.events()), 2)
                self.assertIn('两个微信下载地址均不可用', self.status()['message'])
                self.assertEqual(self.old_bin.read_text(), 'test-old')

    def test_partial_on_one_mirror_never_classifies_both_as_unreachable(self):
        self.run_install('mixed-network')
        self.assertEqual(len(self.events()), 12)
        self.assertTrue((self.work/'wechat-main.deb').stat().st_size > 0)
        self.assertNotIn('均不可用', self.status()['message'])

    def test_timeout_after_connect_is_not_connect_failure(self):
        self.run_install('connected-timeout')
        self.assertEqual(len(self.events()), 12)
        self.assertNotIn('均不可用', self.status()['message'])
        self.assertIn('请求超时', self.status()['message'])

    def test_changed_url_cleans_only_that_mirrors_partial(self):
        self.work.mkdir()
        (self.work/'wechat-main.deb').write_text('old-partial')
        (self.work/'wechat-main.deb.url').write_text('https://old.invalid/file')
        self.run_install()
        self.assertEqual(self.events()[0]['prior'], '')

    def test_swap_failure_restores_original(self):
        self.run_install('swap-failure')
        self.assertEqual(self.old_bin.read_text(), 'test-old')
        self.assertIn('已尝试恢复', self.status()['message'])
        self.assertFalse(any(e['tool'] == 'pkill' for e in self.events()))

    @unittest.skipUnless(sys.platform.startswith('linux'), 'requires Linux kernel lock table')
    def test_busy_status_recovers_without_writing_or_taking_lock(self):
        for phase in ['busy', 'downloading', 'extracting', 'installing']:
            with self.subTest(phase=phase):
                state = json.dumps({'phase':phase, 'percent':92})
                (self.state/'status.json').write_text(state)
                with (self.state/'.install.flock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    r = subprocess.run(['bash',str(SCRIPT),'status'],env=self.env,capture_output=True,text=True)
                    self.assertEqual(json.loads(r.stdout)['phase'],phase, r.stderr)
                r = subprocess.run(['bash',str(SCRIPT),'status'],env=self.env,capture_output=True,text=True)
                self.assertEqual(json.loads(r.stdout)['phase'],'error',r.stderr)
                self.assertEqual((self.state/'status.json').read_text(),state)
                self.assertEqual(self.old_bin.read_text(),'test-old')

    @unittest.skipUnless(sys.platform.startswith('linux'), 'requires Linux kernel lock table')
    def test_killed_real_install_process_group_reports_retryable_status(self):
        import time, signal
        proc = subprocess.Popen(['bash',str(SCRIPT),'install'],env=dict(self.env,SCENARIO='slow-download'),
                                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            for _ in range(200):
                if (self.root/'started').exists(): break
                time.sleep(0.02)
            self.assertTrue((self.root/'started').exists())
            r = subprocess.run(['bash',str(SCRIPT),'status'],env=self.env,capture_output=True,text=True)
            self.assertEqual(json.loads(r.stdout)['phase'],'downloading',r.stderr)
        finally:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        time.sleep(0.1)
        snapshot=(self.state/'status.json').read_bytes()
        r = subprocess.run(['bash',str(SCRIPT),'status'],env=self.env,capture_output=True,text=True)
        self.assertEqual(json.loads(r.stdout)['phase'],'error',r.stderr)
        self.assertEqual((self.state/'status.json').read_bytes(),snapshot)
        self.assertEqual(self.old_bin.read_text(),'test-old')
        self.assertEqual(self.run_install().returncode,0)
        self.assertEqual(self.status()['phase'],'done')


if __name__ == '__main__':
    unittest.main()
