import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { createLoginRateLimiter } from '../src/login-rate-limit.js';
import { tarEntry, parseTransferFiles } from '../src/transfer-format.js';
import { createGatewayFetch, type GatewayEnvironment } from '../../web/src/gateway-fetch.ts';
import { fatalErrorMsg } from '../../web/src/vnc-errors.ts';

test('login: five account failures, case folding, Retry-After and fixed window', () => {
  const l = createLoginRateLimiter();
  for (let i = 0; i < 5; i++) { assert.equal(l.check('proxy', 'Admin', 1000), 0); l.fail('proxy', 'ADMIN', 1000); }
  assert.equal(l.check('proxy', 'admin', 1001), 900);
  assert.equal(l.check('proxy', 'admin', 900999), 1);
  assert.equal(l.check('proxy', 'admin', 901000), 0);
});

test('login: shared IP aggregate survives successful login; unrelated IP is independent', () => {
  const l = createLoginRateLimiter();
  for (let i = 0; i < 20; i++) {
    assert.equal(l.check('proxy', 'user' + i, 1000), 0);
    l.fail('proxy', 'user' + i, 1000);
    l.success('proxy', 'user' + i);
  }
  assert.equal(l.check('proxy', 'new', 1000), 900);
  assert.equal(l.check('other', 'new', 1000), 0);
  assert.equal(createLoginRateLimiter().check('proxy', 'new', 1000), 0);
});

test('login: account window is not reset by earlier aggregate window expiry', () => {
  const l = createLoginRateLimiter();
  l.fail('proxy', 'first', 1000);
  for (let i = 0; i < 5; i++) l.fail('proxy', 'later', 800000);
  assert.equal(l.check('proxy', 'later', 901000), 799);
  assert.equal(l.check('proxy', 'fresh', 901000), 0);
  assert.equal(l.check('proxy', 'later', 1700000), 0);
});

test('login: bounded capacity fails closed without evicting active counters; GC frees it', () => {
  const l = createLoginRateLimiter(2);
  l.fail('one', 'a', 1000); l.fail('two', 'a', 2000);
  for (let i = 0; i < 100; i++) { assert.ok(l.check('new' + i, 'a', 3000) > 0); l.fail('new' + i, 'a', 3000); }
  assert.equal(l.size(), 2);
  assert.equal(l.check('new', 'a', 901000), 0);
  assert.equal(l.size(), 1);
});

test('transfer: NUL triples preserve special names, fractional mtime, stable ties and legacy fields', () => {
  const files = parseTransferFiles('old\0' + '3\0' + '0\0' + '引号\"\t换行\n.txt\0' + '8\0' + '123.25\0' + 'z\0' + '2\0' + '124\0' + 'a\0' + '1\0' + '124\0');
  assert.deepEqual(files.map(x => x.name), ['a', 'z', '引号\"\t换行\n.txt', 'old']);
  assert.equal(files[2].mtime, 123.25);
  assert.deepEqual(files.map(({ name, size }) => ({ name, size }))[3], { name: 'old', size: 3 });
  assert.deepEqual(parseTransferFiles(''), []);
});

test('tar: actual Python reader verifies time, checksum, contents and long UTF-8 PAX filename', () => {
  for (const name of ['quote\" tab\tline\n.txt', '中文'.repeat(35) + '.txt']) {
    const timestamp = Math.floor(Date.now() / 1000);
    const data = Buffer.concat([tarEntry(name, Buffer.from('payload'), timestamp), Buffer.alloc(1024)]);
    for (let offset = 0; offset < data.length - 1024;) {
      const h = data.subarray(offset, offset + 512);
      const expected = parseInt(h.subarray(148, 154).toString(), 8);
      const copy = Buffer.from(h); copy.fill(32, 148, 156);
      assert.equal(copy.reduce((a, b) => a + b, 0), expected);
      const length = parseInt(h.subarray(124, 135).toString(), 8);
      offset += 512 + Math.ceil(length / 512) * 512;
    }
    const r = spawnSync('python3', ['-c', 'import sys,tarfile,io,json; t=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())); m=t.getmembers()[0]; print(json.dumps([m.name,m.mtime,t.extractfile(m).read().decode()]))'], { input: data });
    assert.equal(r.status, 0, r.stderr.toString());
    assert.deepEqual(JSON.parse(r.stdout.toString()), [name, timestamp, 'payload']);
  }
});

test('Docker transfer integration: NUL argv and UTF-8 split across Docker frames survive', async t => {
  const { listInstanceFiles, uploadToInstance } = await import('../src/docker.js');
  const name = '中文\t换行\n文件.txt';
  const output = Buffer.from(name + '\0' + '7\0' + '123.5\0');
  let command: string[] = [];
  let archive: Buffer | undefined;
  t.mock.method(Docker.prototype, 'getContainer', () => ({
    putArchive: async (data: Buffer | NodeJS.ReadableStream) => {
      if (Buffer.isBuffer(data)) { archive = data; return; }
      const parts: Buffer[] = [];
      for await (const c of data as AsyncIterable<Buffer>) parts.push(Buffer.from(c));
      archive = Buffer.concat(parts);
    },
    exec: async (opts: any) => {
      command = opts.Cmd;
      const isFind = command[0] === 'find';
      return {
        inspect: async () => ({ ExitCode: 0 }),
        start: async () => {
          const stream = new PassThrough();
          setImmediate(() => {
            if (isFind) for (const byte of output) {
              const head = Buffer.alloc(8); head[0] = 1; head.writeUInt32BE(1, 4);
              stream.write(Buffer.concat([head, Buffer.from([byte])]));
            }
            stream.end();
          });
          return stream;
        },
      };
    },
  }));
  const instance = { containerName: 'isolated-test' } as any;
  assert.deepEqual(await listInstanceFiles(instance), [{ name, size: 7, mtime: 123.5 }]);
  assert.deepEqual(command, ['find', '/config/Desktop', '-maxdepth', '1', '-type', 'f', '-printf', '%f\\0%s\\0%T@\\0']);
  await uploadToInstance(instance, name, 7, (async function* () { yield Buffer.from('payload'); })());
  assert.ok(archive);
  assert.ok(parseInt(archive.subarray(136, 147).toString(), 8) > 1700000000);
  assert.ok(archive.includes(Buffer.from('payload')));
});

function gateway() {
  const store = new Map<string, string>();
  const calls: RequestInit[] = [];
  const navigations: string[] = [];
  let url = 'https://panel.test/admin';
  const env: GatewayEnvironment = {
    fetch: async (_input, init) => { calls.push(init || {}); return { type: 'opaqueredirect' } as Response; },
    now: () => 100000, url: () => url, online: () => true, visible: () => true,
    read: key => store.get(key) || null, write: (key, value) => { store.set(key, value); }, remove: key => { store.delete(key); },
    navigate: next => { navigations.push(next); url = next; }, replaceUrl: next => { url = next; },
  };
  return { env, store, calls, navigations };
}

test('Access: manual redirect triggers only one concurrent navigation and does not replay POST', async () => {
  const g = gateway(); const request = createGatewayFetch(g.env);
  await Promise.allSettled(Array.from({ length: 5 }, () => request('/api/upload', { method: 'POST', body: 'test' })));
  assert.equal(g.calls.length, 5); assert.equal(g.navigations.length, 1);
  assert.ok(g.calls.every(x => x.redirect === 'manual' && x.method === 'POST' && x.body === 'test'));
});

test('Access: ordinary network failure / abort is propagated, without navigating or retrying', async () => {
  for (const error of [new TypeError('Failed to fetch'), new DOMException('aborted', 'AbortError')]) {
    const g = gateway(); let calls = 0;
    g.env.fetch = async () => { calls++; throw error; };
    await assert.rejects(createGatewayFetch(g.env)('/api/test', { method: 'POST' }), e => e === error);
    assert.equal(calls, 1); assert.equal(g.navigations.length, 0);
  }
});

test('Access: persisted cooldown and maximum attempts survive new page instances', async () => {
  const g = gateway();
  await assert.rejects(createGatewayFetch(g.env)('/api/test'));
  await assert.rejects(createGatewayFetch(g.env)('/api/test'));
  assert.equal(g.navigations.length, 1);
  g.env.now = () => 108001;
  await assert.rejects(createGatewayFetch(g.env)('/api/test'));
  g.env.now = () => 116002;
  await assert.rejects(createGatewayFetch(g.env)('/api/test'));
  assert.equal(g.navigations.length, 2);
  g.env.now = () => 170000;
  await assert.rejects(createGatewayFetch(g.env)('/api/test'));
  assert.equal(g.navigations.length, 3);
});

test('Access: unavailable storage allows first navigation but URL marker prevents redirect loop', async () => {
  const g = gateway();
  g.env.read = () => { throw new Error('denied'); }; g.env.write = () => { throw new Error('denied'); };
  await assert.rejects(createGatewayFetch(g.env)('/api/test'));
  g.env.now = () => 200000;
  await assert.rejects(createGatewayFetch(g.env)('/api/test'));
  assert.equal(g.navigations.length, 1);
});

test('Access: non-API, background/offline, HTTP failures and late success do not bypass policy', async () => {
  const g = gateway();
  const request = createGatewayFetch(g.env);
  await request('https://other.test/api/x');
  assert.equal(g.calls[0].redirect, undefined);
  assert.equal(g.navigations.length, 0);
  g.env.visible = () => false;
  await assert.rejects(request('/api/test')); assert.equal(g.navigations.length, 0);
  g.env.visible = () => true; g.env.online = () => false;
  await assert.rejects(request('/api/test')); assert.equal(g.navigations.length, 0);
  g.env.online = () => true;
  await assert.rejects(request('/api/test'));
  const saved = g.store.get('woc_access_reauth_state');
  g.env.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  await request('/api/test'); assert.equal(g.store.get('woc_access_reauth_state'), saved);
  for (const status of [401, 403, 502]) {
    g.env.fetch = async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } });
    await createGatewayFetch(g.env)('/api/test'); assert.equal(g.store.get('woc_access_reauth_state'), saved);
  }
  g.env.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  await createGatewayFetch(g.env)('/api/test'); assert.equal(g.store.size, 0);
  assert.ok(!g.env.url().includes('woc_access_reauth'));
});

function fakeDoc(msg: string, connected = true) {
  let open = true;
  return { doc: {
    documentElement: { classList: { contains: () => connected } },
    getElementById: (id: string) => id === 'noVNC_fallback_error'
      ? { classList: { contains: () => open, remove: () => { open = false; } } }
      : { textContent: msg },
  } as unknown as Document, open: () => open };
}

test('VNC: only clear extension errors on a connected desktop are suppressed', () => {
  for (const scheme of ['chrome', 'moz', 'safari', 'safari-web', 'ms-browser']) {
    const d = fakeDoc(`Error\n at ${scheme}-extension://id/inpage.js:1:1`);
    let noted = 0;
    assert.equal(fatalErrorMsg(d.doc, () => noted++), null);
    assert.equal(noted, 1); assert.equal(d.open(), false);
  }
  for (const msg of ['lastActiveAt', '', 'at https://panel.test/vnc/core/rfb.js:1\n at chrome-extension://id/x.js:1']) {
    const d = fakeDoc(msg); assert.ok(fatalErrorMsg(d.doc)); assert.equal(d.open(), true);
  }
  const d = fakeDoc('at chrome-extension://id/x.js:1', false);
  assert.ok(fatalErrorMsg(d.doc)); assert.equal(d.open(), true);
});
