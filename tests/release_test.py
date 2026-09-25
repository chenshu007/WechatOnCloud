import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pair', Path(__file__).resolve().parents[1] / 'scripts/verify-release-pair.py')
pair = importlib.util.module_from_spec(spec); spec.loader.exec_module(pair)

class PairTests(unittest.TestCase):
    def setUp(self):
        self.version = '1.5.0-no-chromium.1'; self.sha = 'a'*40; self.calls = []
        self.labels = {'io.wechatoncloud.variant': 'no-chromium', 'org.opencontainers.image.source': 'https://github.com/chenshu007/WechatOnCloud', 'org.opencontainers.image.revision': self.sha, 'org.opencontainers.image.version': self.version}
    def command(self, *args):
        self.calls.append(args)
        if args[1:3] == ('buildx', 'imagetools'): return json.dumps({'digest': 'sha256:'+'b'*64})
        if args[1] == 'pull': return ''
        return json.dumps([{'Id':'sha256:local', 'Os':'linux', 'Architecture':'arm64', 'Config':{'Labels': self.labels}}])
    def test_both_images_exact_digests(self):
        with patch.object(pair, 'cmd', self.command): r = pair.verify(self.version, self.sha, 'linux/arm64')
        self.assertEqual(set(r['images']), {'woc-panel', 'wechat-on-cloud'})
        pulls = [c for c in self.calls if c[1] == 'pull']; self.assertEqual(len(pulls), 2)
        self.assertTrue(all('@sha256:' in c[-1] for c in pulls))
    def test_second_image_missing(self):
        def fail(*args):
            if 'wechat-on-cloud' in ' '.join(args): raise subprocess.CalledProcessError(1, args)
            return self.command(*args)
        with patch.object(pair, 'cmd', fail), self.assertRaises(subprocess.CalledProcessError): pair.verify(self.version, self.sha, 'linux/arm64')
    def test_wrong_identity(self):
        self.labels['org.opencontainers.image.revision'] = 'c'*40
        with patch.object(pair, 'cmd', self.command), self.assertRaisesRegex(ValueError,'Identity mismatch'): pair.verify(self.version, self.sha, 'linux/arm64')
    def test_wrong_architecture(self):
        with patch.object(pair, 'cmd', self.command), self.assertRaisesRegex(ValueError,'Architecture mismatch'): pair.verify(self.version, self.sha, 'linux/amd64')
    def test_no_latest(self):
        with patch.object(pair, 'cmd', self.command), self.assertRaises(ValueError): pair.verify('latest', self.sha, 'linux/arm64')
        self.assertEqual(self.calls, [])
