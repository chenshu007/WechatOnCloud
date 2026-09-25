#!/usr/bin/env python3
"""Read registry, pull exact pair, verify identity, write a deployment receipt. No containers."""
import argparse
import json
import re
import subprocess
from pathlib import Path


def cmd(*args):
    return subprocess.check_output(args, text=True).strip()


def verify(version, sha, platform):
    if not re.fullmatch(r'\d+\.\d+\.\d+-no-chromium\.\d+', version) or not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Expected no-Chromium version and full source SHA')
    result = {'version': version, 'source_revision': sha, 'platform': platform, 'images': {}}
    for name in ['woc-panel', 'wechat-on-cloud']:
        tag = f'ghcr.io/chenshu007/{name}:{version}'
        manifest = json.loads(cmd('docker', 'buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'))
        digest = manifest['digest']
        if not re.fullmatch('sha256:[a-f0-9]{64}', digest): raise ValueError('Invalid registry digest')
        ref = f'ghcr.io/chenshu007/{name}@{digest}'
        cmd('docker', 'pull', '--platform', platform, ref)
        image = json.loads(cmd('docker', 'image', 'inspect', ref))[0]
        labels = image['Config']['Labels']
        expected = {'io.wechatoncloud.variant': 'no-chromium', 'org.opencontainers.image.source': 'https://github.com/chenshu007/WechatOnCloud', 'org.opencontainers.image.revision': sha, 'org.opencontainers.image.version': version}
        if any(labels.get(k) != v for k, v in expected.items()): raise ValueError(f'Identity mismatch: {name}')
        if f"{image['Os']}/{image['Architecture']}" != platform: raise ValueError(f'Architecture mismatch: {name}')
        result['images'][name] = {'tag': tag, 'ref': ref, 'image_id': image['Id']}
    return result

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--version', required=True); p.add_argument('--sha', required=True)
    p.add_argument('--platform', choices=['linux/amd64', 'linux/arm64'], required=True)
    p.add_argument('--output', required=True)
    a = p.parse_args()
    # Write only after BOTH successfully resolve, pull and validate.
    result = verify(a.version, a.sha, a.platform)
    Path(a.output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
