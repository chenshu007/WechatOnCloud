import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import bcrypt from '../panel/server/node_modules/bcryptjs/index.js';

test('authenticated HTTP: retired read/export/delete, denied lifecycle and permissions, empty POST', { timeout: 20000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'woc-api-'));
  const calls: string[] = [];
  const docker = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith('/json') && req.url.includes('/containers/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Image: 'sha256:test', State: { Running: false } })); }
    else if (req.url?.includes('/archive')) { res.end('preserved browser data'); }
    else if (req.method === 'DELETE' || req.url?.endsWith('/stop')) { res.writeHead(204); res.end(); }
    else { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"not found"}'); }
  });
  docker.listen(0, '127.0.0.1'); await once(docker, 'listening');
  const addr = docker.address() as any;
  const file = join(temp, 'accounts.json');
  writeFileSync(join(temp, 'index.html'), '<html>test</html>');
  writeFileSync(file, JSON.stringify({ users: ['admin', 'sub'].map(role => ({ id: role, username: role, role, passwordHash: bcrypt.hashSync('test-only-pass', 4), disabled: false, createdAt: '', allowedInstances: [] })), instances: [{ id: 'oldbrowser', name: 'retired', appType: 'chromium', containerName: 'test-old', volumeName: 'test-preserved-volume', kasmUser: 'test', kasmPassword: 'test', createdAt: '', createdBy: 'admin' }] }));
  const child = spawn(process.execPath, ['--import', './panel/server/node_modules/tsx/dist/loader.mjs', 'panel/server/src/index.ts'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STATIC_DIR: temp, PANEL_DATA: file, PANEL_LOG_DIR: temp, DOCKER_HOST: `tcp://127.0.0.1:${addr.port}`, WOC_DOCKER_NETWORK: 'test-only', WOC_WATCHDOG_INTERVAL_SEC: '0', WOC_KEEP_OLD_IMAGES: '1', WOC_WECHAT_IMAGE: 'ghcr.io/chenshu007/wechat-on-cloud:1.5.0-no-chromium.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise<string>((ok, fail) => {
      let out = ''; const timer = setTimeout(() => fail(Error('API startup timeout')), 10000);
      child.stdout.on('data', x => { out += x; const m = out.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(timer); ok(m[1]); } });
      child.once('exit', code => { clearTimeout(timer); fail(Error(`API exit ${code}`)); });
    });
    const login = async (username: string) => { const r = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'test-only-pass' }) }); assert.equal(r.status, 200); return r.headers.get('set-cookie')!.split(';')[0]; };
    const admin = await login('admin'), sub = await login('sub');
    const post = (path: string, cookie = admin, body?: any) => fetch(url + path, { method: 'POST', headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const before = readFileSync(file, 'utf8'); calls.length = 0;
    assert.equal((await post('/api/admin/instances', admin, { name: 'browser', appType: 'chromium' })).status, 410);
    for (const op of ['start', 'restart', 'upgrade']) assert.equal((await post(`/api/admin/instances/oldbrowser/${op}`)).status, 410);
    assert.equal((await post('/api/instances/oldbrowser/heal')).status, 410);
    assert.equal((await post('/api/admin/instances/oldbrowser/wechat/install')).status, 410);
    assert.equal((await post('/api/admin/version/self-update')).status, 409);
    assert.equal((await post('/api/admin/version/check')).status, 200); // empty POST parser regression
    assert.equal((await post('/api/admin/instances', sub, { name: 'wx', appType: 'wechat' })).status, 403);
    assert.equal((await post('/api/instances/oldbrowser/heal', sub)).status, 403);
    assert.deepEqual(calls, []);
    const list = await fetch(url + '/api/instances', { headers: { cookie: admin } });
    const old = (await list.json() as any).instances[0]; assert.equal(old.retired, true); assert.equal(old.appType, 'chromium'); assert.equal(old.kasmPassword, undefined);
    const backup = await fetch(url + '/api/admin/instances/oldbrowser/volume/backup', { headers: { cookie: admin } }); assert.equal(backup.status, 200); await backup.arrayBuffer();
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.ok(!calls.some(x => /\/start|\/create|\/restart/.test(x)));
    const del = await fetch(url + '/api/admin/instances/oldbrowser', { method: 'DELETE', headers: { cookie: admin } }); assert.equal(del.status, 200);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).instances.length, 0);
    assert.ok(!calls.some(x => x.startsWith('DELETE') && x.includes('/volumes/')));
  } finally {
    child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit');
    docker.closeAllConnections(); await new Promise<void>(r => docker.close(() => r())); rmSync(temp, { recursive: true, force: true });
  }
});
