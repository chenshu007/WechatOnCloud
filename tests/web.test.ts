import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api } from '../panel/web/src/api.js';
let reloads = 0, unregisters = 0;
Object.defineProperty(globalThis, 'window', { value: { location: { reload: () => reloads++ } }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { getRegistrations: async () => [{ unregister: async () => { unregisters++; } }] } }, configurable: true });
const storage = new Map();
Object.defineProperty(globalThis, 'sessionStorage', { value: { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v) } });
test('Access opaque redirect unregisters SW then reloads, throttles, keeps PWA build', async () => {
  globalThis.fetch = async (_url, init) => { assert.equal(init?.redirect, 'manual'); return { type: 'opaqueredirect' } as Response; };
  await assert.rejects(api.getVersion(), /重新验证/); await new Promise(r => setTimeout(r, 0));
  assert.equal(reloads, 1); assert.equal(unregisters, 1);
  await assert.rejects(api.getVersion()); assert.equal(reloads, 1);
  assert.match(readFileSync('panel/web/vite.config.ts', 'utf8'), /VitePWA/);
});
test('ordinary network failure never reloads or unregisters PWA', async () => {
  globalThis.fetch = async () => { throw TypeError('Failed to fetch'); };
  await assert.rejects(api.getVersion(), /Failed to fetch/);
  assert.equal(reloads, 1); assert.equal(unregisters, 1);
});
test('empty POST sends no JSON content-type; JSON POST still declares it', async () => {
  globalThis.fetch = async (_url, init) => { assert.equal(new Headers(init?.headers).has('content-type'), false); assert.equal(init?.body, undefined); return Response.json({}); };
  await api.instanceStop('test');
  globalThis.fetch = async (_url, init) => { assert.equal(new Headers(init?.headers).get('content-type'), 'application/json'); assert.ok(init?.body); return Response.json({}); };
  await api.createInstance('test', [], undefined, 'wechat');
});
