import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { createVncRejectLimiter } from '../src/vnc-reject.js';

const dir = mkdtempSync(join(tmpdir(), 'woc-backport-tests-'));
process.env.PANEL_DATA = join(dir, 'accounts.json');
process.env.WOC_DOCKER_NETWORK = 'isolated-test-network';
process.env.WOC_WECHAT_IMAGE = 'example.invalid/wechat:fixed-test';
after(() => rmSync(dir, { recursive: true, force: true }));
const { runInstance, upgradeInstance } = await import('../src/docker.js');
const inst: any = { id: 'abc123', containerName: 'test-only', volumeName: 'test-only', kasmUser: 'test', kasmPassword: 'test' };

function fakeDocker(t: any, options: { inspectError?: any; imageError?: any; removeError?: any; pullError?: any } = {}) {
  const events: string[] = [];
  let created: any;
  t.mock.method(Docker.prototype, 'getContainer', () => ({
    inspect: async () => { events.push('inspect-container'); if (options.inspectError) throw options.inspectError; return { Image: 'sha256:old-image' }; },
    logs: async () => Buffer.from(''),
    exec: async () => { throw new Error('UI exec forbidden in test'); },
    remove: async () => { events.push('remove'); if (options.removeError) throw options.removeError; },
  }));
  t.mock.method(Docker.prototype, 'getImage', (image: string) => ({
    inspect: async () => { events.push(`inspect-image:${image}`); if (options.imageError) throw options.imageError; return { Id: image }; },
  }));
  t.mock.method(Docker.prototype, 'createContainer', async (config: any) => {
    events.push('create'); created = config;
    return { start: async () => events.push('start'), remove: async () => events.push('remove-new') };
  });
  t.mock.method(Docker.prototype, 'pull', (_ref: string, callback: any) => {
    events.push('pull'); callback(options.pullError || new Error('Registry calls forbidden in test'));
  });
  return { events, get created() { return created; } };
}

test('restart uses immutable old image, validates before remove, and bounds logs', async (t) => {
  const fake = fakeDocker(t);
  await runInstance(inst, { keepImage: true });
  assert.equal(fake.created.Image, 'sha256:old-image');
  assert.ok(fake.events.indexOf('inspect-image:sha256:old-image') < fake.events.indexOf('remove'));
  assert.ok(!fake.events.includes('pull'));
  assert.deepEqual(fake.created.HostConfig.LogConfig.Config, { 'max-size': '20m', 'max-file': '2' });
});

test('missing restart target fails closed without pulling or removing', async (t) => {
  const fake = fakeDocker(t, { inspectError: { statusCode: 404 } });
  await assert.rejects(runInstance(inst, { keepImage: true }), /无法确认原实例镜像/);
  assert.deepEqual(fake.events, ['inspect-container']);
});

test('Docker permission failures are never treated as missing containers', async (t) => {
  const failure = Object.assign(new Error('denied'), { statusCode: 403 });
  const fake = fakeDocker(t, { inspectError: failure });
  await assert.rejects(runInstance(inst), /denied/);
  assert.deepEqual(fake.events, ['inspect-container']);
});

test('unavailable pinned image leaves existing container untouched', async (t) => {
  const fake = fakeDocker(t, { imageError: new Error('image unavailable') });
  await assert.rejects(runInstance(inst, { keepImage: true }), /image unavailable/);
  assert.ok(!fake.events.includes('remove'));
  assert.ok(!fake.events.includes('pull'));
});

test('failed explicit upgrade never falls back to cached latest or rebuilds', async (t) => {
  const fake = fakeDocker(t, { pullError: new Error('registry offline') });
  await assert.rejects(upgradeInstance(inst), /registry offline/);
  assert.deepEqual(fake.events, ['pull']);
});

test('failed removal never creates a conflicting replacement container', async (t) => {
  const fake = fakeDocker(t, { removeError: new Error('remove denied') });
  await assert.rejects(runInstance(inst, { keepImage: true }), /remove denied/);
  assert.ok(!fake.events.includes('create'));
});

test('VNC rejection limiter permits distinct reasons and expires duplicates', () => {
  const allow = createVncRejectLimiter();
  assert.equal(allow('abc123', 'SESSION_INVALID', 0), true);
  assert.equal(allow('abc123', 'SESSION_INVALID', 59999), false);
  assert.equal(allow('abc123', 'COOKIE_MISSING', 100), true);
  assert.equal(allow('abc123', 'SESSION_INVALID', 60000), true);
});

test('VNC rejection limiter bounds live entries under unique-key floods', () => {
  const allow = createVncRejectLimiter(2);
  allow('1', 'ACCESS_DENIED', 0);
  allow('2', 'ACCESS_DENIED', 0);
  allow('3', 'ACCESS_DENIED', 0);
  assert.equal(allow('2', 'ACCESS_DENIED', 1), false);
  assert.equal(allow('1', 'ACCESS_DENIED', 1), true); // oldest evicted
});
