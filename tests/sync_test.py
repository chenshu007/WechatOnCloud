import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/sync-upstream.py'

class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'repo'
        self.root.mkdir()
        self.git('init', '-b', 'no-chromium')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        (self.root / 'shared').write_text('base\n')
        self.git('add', '.'); self.git('commit', '-m', 'upstream base')
        sha = self.git('rev-parse', 'HEAD')
        self.git('tag', 'v1.0.0')
        (self.root / 'maintenance').mkdir()
        (self.root / 'maintenance/upstream.json').write_text(json.dumps({'repository': 'test/test', 'tag': 'v1.0.0', 'sha': sha}))
        self.git('add', '.'); self.git('commit', '-m', 'downstream tracking')
        self.base = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-b', 'upstream', 'v1.0.0')
        (self.root / 'shared').write_text('upstream new\n')
        self.git('commit', '-am', 'new stable')
        self.new = self.git('rev-parse', 'HEAD'); self.git('tag', 'v1.1.0')
        self.git('checkout', 'no-chromium')
        self.fixture = Path(self.tmp.name) / 'release.json'
        self.release('v1.1.0')

    def tearDown(self): self.tmp.cleanup()
    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.DEVNULL, text=True).strip()
    def release(self, tag): self.fixture.write_text(json.dumps({'tag_name': tag, 'test_sha': self.new, 'prerelease': False, 'draft': False}))
    def sync(self, *args):
        p = subprocess.run(['python3', str(SCRIPT), '--release-json', str(self.fixture), '--upstream', str(self.root), '--check-command', 'true', *args], cwd=self.root, capture_output=True, text=True)
        return p.returncode, json.loads(p.stdout)
    def unchanged(self): self.assertEqual(self.git('rev-parse', 'no-chromium'), self.base)
    def test_no_update(self):
        self.release('v1.0.0'); rc, r = self.sync('--apply'); self.assertEqual(rc, 0); self.assertEqual(r['status'], 'no-update'); self.unchanged()
    def test_dry_run(self):
        rc, r = self.sync(); self.assertEqual(r['status'], 'available'); self.assertNotIn('sync/v1.1.0', self.git('branch')); self.unchanged()
    def test_new_and_repeat(self):
        rc, r = self.sync('--apply'); self.assertEqual(rc, 0, r); self.assertEqual(r['status'], 'validated'); self.unchanged()
        head = r['candidate_sha']; self.git('merge-base', '--is-ancestor', self.base, head); self.git('merge-base', '--is-ancestor', self.new, head)
        rc, again = self.sync('--apply'); self.assertEqual(again['status'], 'existing'); self.assertEqual(head, again['candidate_sha']); self.unchanged()
    def test_conflict(self):
        (self.root / 'shared').write_text('downstream incompatible\n'); self.git('commit', '-am', 'local customization'); self.base = self.git('rev-parse', 'HEAD')
        rc, r = self.sync('--apply'); self.assertEqual(rc, 1); self.assertEqual(r['status'], 'conflict'); self.assertEqual(r['conflicts'], ['shared']); self.unchanged()
        rc, again = self.sync('--apply'); self.assertEqual(again['previous_result'], 'conflict'); self.unchanged()
    def test_failed_checks(self):
        rc, r = self.sync('--apply', '--check-command', 'exit 7'); self.assertEqual(rc, 1); self.assertEqual(r['status'], 'test-failed'); self.assertEqual(r['check_exit'], 7); self.unchanged()
    def test_dirty_worktree(self):
        (self.root / 'shared').write_text('uncommitted\n'); rc, r = self.sync('--apply'); self.assertEqual(r['status'], 'error'); self.assertIn('dirty', r['reason']); self.unchanged()
    def test_tag_moved(self):
        self.fixture.write_text(json.dumps({'tag_name': 'v1.1.0', 'test_sha': 'a'*40})); rc, r = self.sync('--apply'); self.assertEqual(r['status'], 'error'); self.assertIn('moved', r['reason']); self.unchanged()

if __name__ == '__main__': unittest.main()
