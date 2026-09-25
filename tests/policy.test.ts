import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import Docker from '../panel/server/node_modules/dockerode/lib/docker.js';
import { assertImageRef, assertImageIdentity } from '../panel/server/src/no-chromium.js';
const revision = 'a'.repeat(40), version = '1.5.0-no-chromium.1';
const ref = `ghcr.io/chenshu007/wechat-on-cloud:${version}`;
process.env.WOC_WECHAT_IMAGE = ref;
process.env.WOC_SOURCE_REVISION = revision;
process.env.WOC_VERSION = version;
process.env.WOC_DOCKER_NETWORK = 'isolated-unit-test';
process.env.PANEL_DATA = join(mkdtempSync(join(tmpdir(), 'woc-policy-')), 'accounts.json');
process.env.PANEL_LOG_DIR = join(tmpdir(), 'woc-test-logs');
const store = await import('../panel/server/src/store.js');
const runtime = await import('../panel/server/src/docker.js');
const updater = await import('../panel/server/src/self-update.js');
const wx: any = { id: '0123456789', name: 'wx', containerName: 'unit-test', volumeName: 'unit-volume' };
const retired = { ...wx, appType: 'chromium' };
const labels = { 'io.wechatoncloud.variant': 'no-chromium', 'org.opencontainers.image.source': 'https://github.com/chenshu007/WechatOnCloud', 'org.opencontainers.image.revision': revision, 'org.opencontainers.image.version': version };
let createOptions: any;
let operations: string[] = [], image: any = { Id: 'sha256:verified', Config: { Labels: labels } }, missing = false, pullFails = false;
// In-memory Docker boundary, never uses a host socket or daemon.
Docker.prototype.getImage = function (ref: string) { operations.push(`image:${ref}`); return { inspect: async () => { if (missing) throw { statusCode: 404 }; return image; } } as any; };
Docker.prototype.getContainer = function () { return { inspect: async () => ({ Image: 'sha256:old', State: { Running: false } }), remove: async () => { operations.push('remove'); }, start: async () => { operations.push('start'); }, logs: async () => Buffer.from(''), exec: async () => { operations.push('exec'); throw Error('unexpected exec'); }, getArchive: async () => { operations.push('archive'); return Readable.from('preserved-data'); } } as any; };
Docker.prototype.getVolume = function () { return { inspect: async () => ({}) } as any; };
Docker.prototype.createContainer = async function (opts: any) { createOptions = opts; operations.push(`create:${opts.Image}`); return { start: async () => { operations.push('start'); }, remove: async () => {} } as any; };
Docker.prototype.pull = function (_ref: any, cb: any) { operations.push('pull'); cb(Error(pullFails ? 'registry offline' : 'unexpected pull')); } as any;

test('explicit custom tag and digest survive unchanged; ordinary refs fail closed', () => {
  for (const r of [ref, `${ref}@sha256:${'b'.repeat(64)}`, `ghcr.io/chenshu007/wechat-on-cloud@sha256:${'c'.repeat(64)}`]) assert.equal(assertImageRef(r), r);
  for (const r of ['', 'ghcr.io/gloridust/wechat-on-cloud:latest', 'ghcr.io/chenshu007/wechat-on-cloud:latest', ref.replace('-no-chromium.1', '')]) assert.throws(() => assertImageRef(r));
  assert.doesNotThrow(() => assertImageIdentity(image));
  for (const key of Object.keys(labels)) assert.throws(() => assertImageIdentity({ Config: { Labels: { ...labels, [key]: 'wrong' } } }));
});
test('retired records persist identity and data; every launch path rejects before Docker', async () => {
  operations = [];
  const count = store.listInstances().length;
  assert.throws(() => store.createInstance('browser', 'admin', [], undefined, 'chromium'), /retired/);
  assert.equal(store.listInstances().length, count);
  assert.equal(store.publicInstance(retired).retired, true);
  for (const f of [runtime.runInstance, runtime.ensureRunning, runtime.upgradeInstance, runtime.regenInstanceMachineId]) await assert.rejects(f(retired), /retired/);
  await assert.rejects(runtime.triggerWechat(retired, 'install'), /retired/);
  assert.equal((await runtime.wechatStatus(retired)).phase, 'error');
  assert.deepEqual(operations, []);
  assert.equal(retired.volumeName, 'unit-volume');
  const stream = await runtime.volBackupStream(retired); for await (const _ of stream) {}
  assert.deepEqual(operations, ['archive']);
});
test('wrong image blocks restart/start/upgrade before removing existing container', async () => {
  image = { Id: 'bad', Config: { Labels: {} } };
  for (const f of [() => runtime.runInstance(wx), () => runtime.runInstance(wx, { keepImage: true }), () => runtime.ensureRunning(wx), () => runtime.upgradeInstance(wx, { skipPull: true })]) {
    operations = []; await assert.rejects(f(), /身份不符/);
    assert.ok(!operations.some(x => /^(remove|create|start)/.test(x)));
  }
  image = { Id: 'sha256:verified', Config: { Labels: labels } };
});
test('missing image and failed pull never fall back or delete old container', async () => {
  missing = true; pullFails = true; operations = [];
  await assert.rejects(runtime.runInstance(wx), /registry offline/);
  assert.ok(!operations.some(x => x.includes('latest') || /^(remove|create|start)/.test(x)));
  missing = false;
  await assert.rejects(runtime.upgradeInstance(wx), /registry offline/);
});
test('WeChat start and create use verified image ID, preserve volume and user environment', async () => {
  operations = []; await runtime.ensureRunning(wx); assert.ok(operations.includes('start'));
  operations = []; await runtime.runInstance(wx); assert.ok(operations.includes('create:sha256:verified'));
  assert.deepEqual(createOptions.HostConfig.Binds, ['unit-volume:/config']);
  assert.ok(createOptions.Env.includes('WOC_APP_TYPE=wechat'));
  assert.ok(createOptions.Env.includes('PUID=1000'));
  assert.ok(!createOptions.Env.some((x: string) => x.startsWith('WOC_DARK=')));
  assert.ok(operations.findIndex(x => x.startsWith('image:')) < operations.indexOf('remove'));
});
test('both self update entrypoints reject without Docker side effects', async () => {
  operations = []; await assert.rejects(updater.triggerSelfUpdate(), /自更新已禁用/);
  await assert.rejects(updater.runUpdaterRecreate(), /自更新已禁用/); assert.deepEqual(operations, []);
});
test('Dockerfile retains WeChatAppEx libraries but no standalone browser dependencies', () => {
  const s = readFileSync('docker/Dockerfile', 'utf8');
  assert.doesNotMatch(s, /CHROMIUM_VERSION|CHROMIUM_SNAPSHOT|snapshot\.debian|chromium=|chromium --version|woc-chromium-pin/);
  for (const pkg of ['libnss3', 'libgtk-3-0', 'libcups2', 'libxcb-cursor0', 'xclip', 'xdotool']) assert.ok(s.includes(pkg));
  const launch = (type: string) => spawnSync('bash', ['-c', '. docker/app-defs.sh; woc_app_def "$1"; printf "%s" "$APP_BIN"', 'test', type], { encoding: 'utf8' });
  assert.equal(launch('wechat').stdout, '/config/wechat/opt/wechat/wechat');
  assert.equal(launch('chromium').status, 1);
  const init = spawnSync('bash', ['docker/woc-app-init.sh'], { env: { ...process.env, WOC_APP_TYPE: 'chromium' } }); assert.equal(init.status, 1);
});
test('retired missing-container export uses a validated read-only helper and removes only helper', async () => {
  const oldGet = Docker.prototype.getContainer, oldCreate = Docker.prototype.createContainer;
  const events: string[] = [];
  Docker.prototype.getContainer = function () { return { inspect: async () => { throw { statusCode: 404 }; } } as any; };
  Docker.prototype.createContainer = async function (opts: any) {
    assert.deepEqual(opts.Entrypoint, ['/bin/sh']);
    assert.deepEqual(opts.HostConfig.Binds, ['unit-volume:/config:ro']);
    assert.equal(opts.HostConfig.NetworkMode, 'none'); assert.equal(opts.HostConfig.ReadonlyRootfs, true);
    return { start: async () => { events.push('helper-start'); }, getArchive: async () => Readable.from('data'), remove: async (arg: any) => { assert.equal(arg.v, undefined); events.push('helper-remove'); } } as any;
  };
  try {
    const stream = await runtime.volBackupStream(retired); for await (const _ of stream) {}
    await new Promise(r => setTimeout(r, 0)); assert.deepEqual(events, ['helper-start', 'helper-remove']);
    assert.equal(retired.appType, 'chromium');
  } finally { Docker.prototype.getContainer = oldGet; Docker.prototype.createContainer = oldCreate; }
});
