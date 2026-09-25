import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function withPanel(run: (login: (name: unknown, password?: string, headers?: Record<string, string>) => Promise<Response>, url: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'woc-login-http-'));
  writeFileSync(join(dir, 'index.html'), '<html>isolated login test</html>');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STATIC_DIR: dir, PANEL_DATA: join(dir, 'accounts.json'),
      PANEL_ADMIN_USER: 'TestAdmin', PANEL_ADMIN_PASSWORD: 'isolated-test-password',
      WOC_DOCKER_NETWORK: 'test-no-docker', DOCKER_HOST: 'unix:///nonexistent-test-docker.sock',
      WOC_INSTANCE_MEM_SOFT_MB: '0', WOC_INSTANCE_MEM_HARD_MB: '0', WOC_WATCHDOG_INTERVAL_SEC: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('isolated panel startup timed out')), 10000);
      child.stdout.on('data', data => {
        output += data;
        const m = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('isolated panel exited')); });
    });
    await run((username, password = 'wrong', headers = {}) => fetch(url + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username, password }),
    }), url);
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit'); rmSync(dir, { recursive: true, force: true });
  }
}

test('real HTTP: parallel failures obey account threshold and ignore forged proxy headers', { timeout: 20000 }, async () => {
  await withPanel(async login => {
    const replies = await Promise.all(Array.from({ length: 30 }, (_, i) => login(i % 2 ? 'testadmin' : 'TESTADMIN', 'wrong', {
      'x-forwarded-for': `198.51.100.${i + 1}`, 'cf-connecting-ip': `203.0.113.${i + 1}`,
    })));
    assert.equal(replies.filter(r => r.status === 401).length, 5);
    assert.equal(replies.filter(r => r.status === 429).length, 25);
    for (const r of replies.filter(r => r.status === 429)) {
      const seconds = Number(r.headers.get('retry-after')); assert.ok(seconds > 0 && seconds <= 900);
    }
  });
});

test('real HTTP: successful login/session works, shared IP budget persists, and invalid types are rejected', { timeout: 20000 }, async () => {
  await withPanel(async (login, url) => {
    assert.equal((await login({ unexpected: true })).status, 400);
    for (let i = 0; i < 4; i++) assert.equal((await login('TestAdmin')).status, 401);
    const ok = await login('TESTADMIN', 'isolated-test-password');
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(url + '/api/auth/me', { headers: { cookie } })).status, 200);
    for (let i = 0; i < 16; i++) assert.equal((await login('nonexistent-' + i)).status, 401);
    assert.equal((await login('fresh-name')).status, 429);
    assert.equal((await fetch(url + '/api/auth/me', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(url + '/api/auth/logout', { method: 'POST', headers: { cookie } })).status, 200);
  });
});
