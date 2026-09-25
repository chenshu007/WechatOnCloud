#!/usr/bin/env python3
"""Stable-release merge candidates. Dry-run unless --apply. Never pushes."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def run(args, cwd, check=True):
    p = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode:
        raise RuntimeError(f'{args[0]} failed: {p.stderr.strip() or p.stdout.strip()}')
    return p


def sync(args):
    root = Path(run(['git', 'rev-parse', '--show-toplevel'], Path.cwd()).stdout.strip())
    base = run(['git', 'rev-parse', 'refs/heads/no-chromium'], root).stdout.strip()
    state = json.loads(run(['git', 'show', f'{base}:maintenance/upstream.json'], root).stdout)
    # Read official stable Release; a fixture is only for local/offline regression tests.
    release = json.loads(Path(args.release_json).read_text()) if args.release_json else json.loads(run(['gh', 'api', f"repos/{state['repository']}/releases/latest"], root).stdout)
    tag = release['tag_name']
    if release.get('draft') or release.get('prerelease') or not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise RuntimeError('Not a stable vX.Y.Z release')
    version = lambda t: tuple(map(int, t[1:].split('.')))
    result = {'tag': tag, 'maintenance_sha': base, 'previous_tag': state['tag'], 'status': 'no-update'}
    if version(tag) <= version(state['tag']):
        return result
    sha = release.get('test_sha') if args.release_json else run(['gh', 'api', f"repos/{state['repository']}/commits/{tag}", '--jq', '.sha'], root).stdout.strip()
    if not re.fullmatch('[0-9a-f]{40}', sha or ''):
        raise RuntimeError('Release commit could not be resolved')
    branch = f'sync/{tag}'
    result.update(upstream_sha=sha, branch=branch, status='available')
    common = Path(run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], root).stdout.strip())
    record = common / 'no-chromium-sync' / f'{tag}.json'
    existing = run(['git', 'rev-parse', '--verify', f'refs/heads/{branch}'], root, False)
    if existing.returncode == 0:
        result.update(status='existing', candidate_sha=existing.stdout.strip())
        if record.exists():
            saved = json.loads(record.read_text())
            result.update(previous_result=saved['status'], worktree=saved.get('worktree'))
            if saved.get('candidate_sha') != result['candidate_sha']:
                result['previous_result'] = 'changed-needs-validation'
        return result
    if not args.apply:
        return result
    # Dirty original files must never become part of the candidate.
    if run(['git', 'status', '--porcelain'], root).stdout:
        raise RuntimeError('Current worktree is dirty; commit candidate inputs first')
    source = args.upstream or f"https://github.com/{state['repository']}.git"
    run(['git', 'fetch', '--no-tags', source, f'refs/tags/{tag}'], root)
    fetched = run(['git', 'rev-parse', 'FETCH_HEAD^{commit}'], root).stdout.strip()
    if fetched != sha:
        raise RuntimeError('Release tag moved between inspection and fetch; stop')
    target = root.parent / f'{root.name}-sync-{tag}'
    if target.exists():
        raise RuntimeError(f'Candidate path already exists: {target}')
    run(['git', 'worktree', 'add', '-b', branch, str(target), base], root)
    result['worktree'] = str(target)
    merged = run(['git', 'merge', '--no-ff', '--no-edit', sha], target, False)
    if merged.returncode:
        result.update(status='conflict', conflicts=run(['git', 'diff', '--name-only', '--diff-filter=U'], target).stdout.splitlines(), reason=merged.stderr.strip() or merged.stdout.strip())
    else:
        (target / 'maintenance/upstream.json').write_text(json.dumps({'repository': state['repository'], 'tag': tag, 'sha': sha}, indent=2) + '\n')
        run(['git', 'add', 'maintenance/upstream.json'], target)
        run(['git', 'commit', '-m', f'Record upstream {tag} ({sha})'], target)
        candidate = run(['git', 'rev-parse', 'HEAD'], target).stdout.strip()
        # No credentials should be passed to candidate build/test code by the caller.
        env = dict(os.environ)
        for key in ['GH_TOKEN', 'GITHUB_TOKEN']:
            env.pop(key, None)
        check = subprocess.run(['bash', '-c', args.check_command], cwd=target, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log = common / 'no-chromium-sync' / f'{tag}.log'
        log.parent.mkdir(exist_ok=True)
        log.write_text(check.stdout)
        clean = not run(['git', 'status', '--porcelain'], target).stdout
        result.update(status='validated' if check.returncode == 0 and clean else 'test-failed', candidate_sha=candidate, check_exit=check.returncode, clean=clean, log=str(log))
    result.setdefault('candidate_sha', run(['git', 'rev-parse', 'HEAD'], target).stdout.strip())
    record.parent.mkdir(exist_ok=True)
    record.write_text(json.dumps(result, indent=2) + '\n')
    if run(['git', 'rev-parse', 'refs/heads/no-chromium'], root).stdout.strip() != base:
        raise RuntimeError('Maintenance branch changed concurrently; do not publish candidate')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--release-json', help='offline test fixture, not used in Actions')
    p.add_argument('--upstream', help='offline test repository, defaults to official upstream')
    p.add_argument('--check-command', default='bash scripts/check-no-chromium.sh')
    p.add_argument('--output', help='write machine-readable result (only when explicitly requested)')
    args = p.parse_args()
    try:
        result = sync(args)
    except Exception as e:
        result = {'status': 'error', 'reason': str(e)}
    text = json.dumps(result, indent=2)
    print(text)
    if args.output:
        Path(args.output).write_text(text + '\n')
    return 1 if result['status'] in ['error', 'conflict', 'test-failed'] else 0

if __name__ == '__main__':
    sys.exit(main())
