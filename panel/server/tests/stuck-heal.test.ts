import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createStuckHealer, UPSTREAM_HANG_MS } from '../src/stuck-heal.js';
import { fatalErrorMsg, isReconnectGapError } from '../../web/src/vnc-errors.ts';

function healer(o: { uptime?: number | null; enabled?: boolean } = {}) {
  let t = 1_000_000;
  const healed: string[] = [];
  const logs: string[] = [];
  const h = createStuckHealer({
    enabled: o.enabled ?? true,
    uptimeSec: async () => (o.uptime === undefined ? 600 : o.uptime),
    heal: async (id) => { healed.push(id); },
    log: (_id, msg) => logs.push(msg),
    now: () => t,
  });
  return { h, healed, logs, advance: (ms: number) => { t += ms; } };
}

test('stuck: one hang only logs; second hang within window heals once', async () => {
  const s = healer();
  assert.equal(await s.h.onHang('a', 'x'), false);
  s.advance(60_000);
  assert.equal(await s.h.onHang('a', 'x'), true);
  assert.deepEqual(s.healed, ['a']);
});

test('stuck: hangs outside the 10 minute window do not add up', async () => {
  const s = healer();
  await s.h.onHang('a', 'x');
  s.advance(10 * 60_000 + 1);
  assert.equal(await s.h.onHang('a', 'x'), false);
  assert.deepEqual(s.healed, []);
});

test('stuck: cooldown blocks a second heal for 15 minutes, then allows it', async () => {
  const s = healer();
  await s.h.onHang('a', 'x'); await s.h.onHang('a', 'x');
  s.advance(60_000);
  await s.h.onHang('a', 'x'); assert.equal(await s.h.onHang('a', 'x'), false);
  s.advance(15 * 60_000);
  await s.h.onHang('a', 'x'); assert.equal(await s.h.onHang('a', 'x'), true);
  assert.deepEqual(s.healed, ['a', 'a']);
});

test('stuck: warming-up, stopped or disabled instances are never restarted', async () => {
  for (const s of [healer({ uptime: 75 }), healer({ uptime: null }), healer({ enabled: false })]) {
    await s.h.onHang('a', 'x');
    assert.equal(await s.h.onHang('a', 'x'), false);
    assert.deepEqual(s.healed, []);
  }
});

test('stuck: instances are counted separately', async () => {
  const s = healer();
  await s.h.onHang('a', 'x');
  assert.equal(await s.h.onHang('b', 'x'), false);
});

test('stuck: a request that gets any response is not counted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = healer();
  const answered = new EventEmitter() as any; answered.destroy = () => assert.fail('must not destroy');
  s.h.watch(answered, 'a', 'x', new EventEmitter());
  answered.emit('upgrade');
  t.mock.timers.tick(UPSTREAM_HANG_MS + 1);
  const hung = new EventEmitter() as any; let destroyed = false; hung.destroy = () => { destroyed = true; };
  let clientClosed = false;
  s.h.watch(hung, 'a', 'x', new EventEmitter(), () => { clientClosed = true; });
  t.mock.timers.tick(UPSTREAM_HANG_MS + 1);
  assert.ok(destroyed && clientClosed);
  assert.equal(s.logs.length, 1);
});

function vncDoc(msg: string, state: 'connected' | 'connecting' | 'disconnected') {
  let open = true;
  return { doc: {
    documentElement: { classList: { contains: (c: string) => c === 'noVNC_' + state } },
    getElementById: (id: string) => id === 'noVNC_fallback_error'
      ? { classList: { contains: () => open, remove: () => { open = false; } } }
      : { textContent: msg },
  } as unknown as Document, open: () => open };
}

test('VNC: lastActiveAt during noVNC reconnect closes the overlay without a page reload', () => {
  const msg = "TypeError: Cannot read properties of undefined (reading 'lastActiveAt')";
  for (const state of ['connected', 'connecting'] as const) {
    const d = vncDoc(msg, state); let gaps = 0;
    assert.equal(fatalErrorMsg(d.doc, undefined, () => gaps++), null);
    assert.equal(d.open(), false); assert.equal(gaps, 1);
  }
  const dead = vncDoc(msg, 'disconnected');
  assert.ok(fatalErrorMsg(dead.doc, undefined, () => assert.fail('must not suppress')));
  assert.equal(dead.open(), true);
  assert.equal(isReconnectGapError('other crash', vncDoc('', 'connecting').doc), false);
});
