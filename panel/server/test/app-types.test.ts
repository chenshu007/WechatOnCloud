import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const temp = mkdtempSync(join(tmpdir(), 'woc-app-types-'));
process.env.PANEL_DATA = join(temp, 'store.json');
process.env.PANEL_ADMIN_PASSWORD = 'test-only-password';
const store = await import('../src/store.js');
const runtime = await import('../src/docker.js');
store.initStore();
after(() => rmSync(temp, { recursive: true, force: true }));

test('WeChat defaults and other supported application types still work', () => {
  const legacy = { appType: undefined } as store.Instance;
  assert.equal(store.instanceAppType(legacy), 'wechat');
  assert.equal(store.requireSupportedApp(legacy), 'wechat');
  for (const appType of store.APP_TYPES) {
    const inst = store.createInstance('test', 'admin', [], undefined, appType);
    assert.equal(inst.appType, appType);
  }
});

test('retired browser records keep their identity and volume without launching WeChat', async () => {
  const inst = { id: 'abcd', name: 'old browser', appType: 'chromium', volumeName: 'woc-data-abcd' } as store.Instance;
  assert.equal(store.publicInstance(inst).appType, 'chromium');
  const count = store.listInstances().length;
  assert.throws(() => store.createInstance('browser', 'admin', [], undefined, 'chromium' as store.AppType), /不支持/);
  assert.equal(store.listInstances().length, count);
  for (const action of [runtime.runInstance, runtime.ensureRunning, runtime.upgradeInstance, runtime.regenInstanceMachineId]) {
    await assert.rejects(action(inst), /浏览器实例功能已移除/);
  }
  await assert.rejects(runtime.triggerWechat(inst, 'install'), /浏览器实例功能已移除/);
  assert.equal((await runtime.wechatStatus(inst)).phase, 'error');
  assert.equal(inst.volumeName, 'woc-data-abcd');
});

test('launcher rejects Chromium and preserves the WeChat executable', () => {
  const defs = resolve('../../docker/app-defs.sh');
  const run = (type: string) => spawnSync('bash', ['-c', '. "$1"; woc_app_def "$2" || exit $?; printf "%s" "$APP_BIN"', 'test', defs, type], { encoding: 'utf8' });
  assert.equal(run('wechat').stdout, '/config/wechat/opt/wechat/wechat');
  assert.equal(run('telegram').stdout, '/config/telegram/Telegram');
  for (const type of ['chromium', 'unsupported']) {
    const result = run(type);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  const init = spawnSync('bash', [resolve('../../docker/woc-app-init.sh')], { env: { ...process.env, WOC_APP_TYPE: 'chromium' }, encoding: 'utf8' });
  assert.equal(init.status, 1);
});

test('authenticated API rejects browser creation before changing account data', { timeout: 15000 }, async () => {
  writeFileSync(join(temp, 'index.html'), '<html>test</html>');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STATIC_DIR: temp, PANEL_DATA: join(temp, 'api.json'), PANEL_ADMIN_USER: 'test-admin', WOC_DOCKER_NETWORK: 'test-no-docker', WOC_WATCHDOG_INTERVAL_SEC: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolveUrl(match[1]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited: ${code}`)); });
    });
    const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-only-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    for (const appType of ['chromium', 'unknown', '', null]) {
      const response = await fetch(url + '/api/admin/instances', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ name: 'rejected', appType }) });
      assert.equal(response.status, 400);
      assert.match((await response.json() as any).error, /不支持/);
    }
    const response = await fetch(url + '/api/instances', { headers: { cookie } });
    assert.deepEqual((await response.json() as any).instances, []);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
