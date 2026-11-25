import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import Fastify from 'fastify';
import {
  parseAllowedHosts,
  parseHost,
  isRequestHostAllowed,
} from '../src/host-guard.js';
import {
  clampScreenshotCrop,
  collectDemuxedStream,
  parsePngDimensions,
  parseWechatWindowInfo,
  type RuntimeState,
  type ScreenshotOptions,
} from '../src/docker.js';
import {
  isOriginAllowed,
  MCP_TOOLS,
  registerMcp,
  verifyBearerToken,
  type McpDeps,
} from '../src/mcp.js';
import type { Instance } from '../src/store.js';

// Minimal valid 1x1 PNG with exact IHDR dimensions (width, height) for unit & integration tests.
function makeTestPng(width = 1280, height = 616): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  const crc = Buffer.alloc(4, 0);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc, iend]);
}

function rawHttp(
  urlStr: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'POST',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const TEST_TOKEN = 'test-mcp-secret-token-0123456789abcdef';
const MCP_HEADERS = {
  authorization: `Bearer ${TEST_TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const RUNNING_INST: Instance = {
  id: '1d29600a24',
  name: 'Mike',
  appType: 'wechat',
  containerName: 'woc-wx-1d29600a24',
  volumeName: 'woc-data-1d29600a24',
  kasmUser: 'woc',
  kasmPassword: 'SUPER_SECRET_KASM_PASSWORD_DO_NOT_LEAK',
  createdAt: '2026-09-01T00:00:00.000Z',
  createdBy: 'admin-1',
};

const STOPPED_INST: Instance = {
  id: '81a0dbf17d',
  name: '代购',
  appType: 'wechat',
  containerName: 'woc-wx-81a0dbf17d',
  volumeName: 'woc-data-81a0dbf17d',
  kasmUser: 'woc',
  kasmPassword: 'ANOTHER_SECRET_PASSWORD',
  createdAt: '2026-09-02T00:00:00.000Z',
  createdBy: 'admin-1',
};

// ---------- Pure helper unit tests ----------

test('verifyBearerToken checks scheme and exact token in constant time', () => {
  assert.equal(verifyBearerToken(`Bearer ${TEST_TOKEN}`, TEST_TOKEN), true);
  assert.equal(verifyBearerToken(`bearer ${TEST_TOKEN}`, TEST_TOKEN), true);
  assert.equal(verifyBearerToken(`Bearer ${TEST_TOKEN}x`, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(`Bearer wrong`, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(`Basic ${TEST_TOKEN}`, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(undefined, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(`Bearer ${TEST_TOKEN}`, ''), false);
});

test('isOriginAllowed permits absent origin, loopback, RFC1918, allowlist; rejects foreign origins', () => {
  const allow = parseAllowedHosts('*.starport1116.com');
  assert.equal(isOriginAllowed(undefined, allow), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:36080', allow), true);
  assert.equal(isOriginAllowed('http://localhost:3000', allow), true);
  assert.equal(isOriginAllowed('http://192.168.50.115:36080', allow), true);
  assert.equal(isOriginAllowed('https://woc.starport1116.com', allow), true);
  assert.equal(isOriginAllowed('https://evil.attacker.test', allow), false);
  assert.equal(isOriginAllowed('null', allow), false);
  assert.equal(isOriginAllowed('javascript:alert(1)', allow), false);
  assert.equal(isOriginAllowed('', allow), false);
});

test('parseWechatWindowInfo parses display and WeChat window geometry', () => {
  const raw = 'DISPLAY\t:1\t1836\t884\nWINDOW\t10485776\t0\t0\t1836\t884\t微信\n';
  const info = parseWechatWindowInfo(raw);
  assert.equal(info.display, ':1');
  assert.equal(info.displayWidth, 1836);
  assert.equal(info.displayHeight, 884);
  assert.deepEqual(info.wechatWindow, {
    id: '10485776',
    x: 0,
    y: 0,
    width: 1836,
    height: 884,
    title: '微信',
  });

  const noWin = parseWechatWindowInfo('DISPLAY\t:1\t1280\t720\n');
  assert.equal(noWin.wechatWindow, null);
  assert.throws(() => parseWechatWindowInfo('DISPLAY\t:1\t0\t0\n'));
});

test('parsePngDimensions and clampScreenshotCrop validate and clamp safely', () => {
  assert.deepEqual(parsePngDimensions(makeTestPng(1280, 616)), { width: 1280, height: 616 });
  assert.throws(() => parsePngDimensions(Buffer.from('not a png')));
  assert.deepEqual(
    clampScreenshotCrop({ x: -10, y: 20, width: 5000, height: 400 }, 1836, 884),
    { x: 0, y: 20, width: 1836, height: 400 },
  );
  assert.throws(() => clampScreenshotCrop({ x: 0, y: 0, width: 0, height: 100 }, 1836, 884));
});

test('collectDemuxedStream handles close immediately after end while exec.inspect is pending', async () => {
  const png = makeTestPng(320, 240);
  const emitter = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  let resolveInspect!: (v: { Running: boolean; ExitCode: number }) => void;
  const inspectPromise = new Promise<{ Running: boolean; ExitCode: number }>((r) => {
    resolveInspect = r;
  });

  const promise = collectDemuxedStream(
    emitter,
    (_s, stdout) => {
      queueMicrotask(() => {
        stdout.write(png.subarray(0, 16));
        stdout.write(png.subarray(16));
        emitter.emit('end');
        // TCP docker-socket-proxy often emits 'close' immediately after 'end' before exec.inspect resolves
        emitter.emit('close');
        setTimeout(() => resolveInspect({ Running: false, ExitCode: 0 }), 20);
      });
    },
    () => inspectPromise,
    { timeoutMs: 2000, maxBytes: 1024 * 1024 },
  );

  const out = await promise;
  assert.ok(out.equals(png));
  assert.equal(emitter.destroyed, false);

  // Premature close BEFORE end still rejects cleanly
  const emitter2 = Object.assign(new EventEmitter(), { destroy() {} });
  await assert.rejects(
    collectDemuxedStream(
      emitter2,
      () => queueMicrotask(() => emitter2.emit('close')),
      async () => ({ Running: false, ExitCode: 0 }),
      { timeoutMs: 2000 },
    ),
    /截屏连接异常中断/,
  );

  // Exceeding maxBytes rejects cleanly
  const emitter3 = Object.assign(new EventEmitter(), { destroy() {} });
  await assert.rejects(
    collectDemuxedStream(
      emitter3,
      (_s, stdout) => queueMicrotask(() => stdout.write(Buffer.alloc(100))),
      async () => ({ Running: false, ExitCode: 0 }),
      { timeoutMs: 2000, maxBytes: 50 },
    ),
    /超出上限/,
  );
});

// ---------- Fastify + host-guard + registerMcp integration tests ----------

async function buildMockMcpServer(overrides: Partial<McpDeps> = {}) {
  const allowedHosts = parseAllowedHosts('*.starport1116.com');
  const logs: string[] = [];
  const called: string[] = [];
  const runtimes: Record<string, RuntimeState> = {
    [RUNNING_INST.id]: 'running',
    [STOPPED_INST.id]: 'stopped',
  };
  let lastShotOpts: ScreenshotOptions | undefined;

  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if (!isRequestHostAllowed(req.headers.host, req.headers['x-forwarded-host'], allowedHosts)) {
      reply.code(400).send({
        error: 'Host header not allowed',
        host: parseHost(req.headers.host) || null,
      });
    }
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, _body, done) => done(null, null));

  const deps: McpDeps = {
    authToken: TEST_TOKEN,
    allowedHosts,
    panelVersion: 'nas-mcp-readonly-test',
    buildRevision: 'df4b821',
    dockerHealthy: async () => true,
    listInstances: () => [RUNNING_INST, STOPPED_INST],
    findInstance: (id) => [RUNNING_INST, STOPPED_INST].find((i) => i.id === id),
    instanceRuntime: async (inst) => runtimes[inst.id] ?? 'missing',
    instanceUptimeSec: async (inst) => (runtimes[inst.id] === 'running' ? 3600 : null),
    instanceMemoryMB: async (inst) => {
      called.push(`mem:${inst.id}`);
      return 878;
    },
    instanceHttpHealthy: async (inst) => {
      called.push(`http:${inst.id}`);
      return true;
    },
    wechatStatus: async (inst) => {
      called.push(`wx:${inst.id}`);
      return { phase: 'done', percent: 100, installed: true, version: '4.1.1.8', message: 'ok', updatedAt: 1 };
    },
    instanceLogs: async (inst, tail = 100) => {
      called.push(`logs:${inst.id}:${tail}`);
      return 'line1\nline2\n' + 'x'.repeat(70_000);
    },
    readInstanceLog: () => `[${new Date().toISOString()}] persisted restart note\n`,
    listInstanceFiles: async (inst) => {
      called.push(`files:${inst.id}`);
      return [{ name: 'report.pdf', size: 12345, mtime: 1700000000 }];
    },
    wechatWindowInfo: async (inst) => {
      called.push(`win:${inst.id}`);
      return {
        display: ':1',
        displayWidth: 1836,
        displayHeight: 884,
        wechatWindow: { id: '10485776', x: 0, y: 0, width: 1836, height: 884, title: '微信' },
      };
    },
    captureInstanceScreenshot: async (inst, opts) => {
      called.push(`shot:${inst.id}`);
      lastShotOpts = opts;
      const w = opts?.crop ? Math.round(opts.crop.width) : opts?.maxWidth === 0 ? 1836 : opts?.maxWidth ?? 1280;
      const h = opts?.crop ? Math.round(opts.crop.height) : 616;
      const png = makeTestPng(w, h);
      return {
        png,
        displayWidth: 1836,
        displayHeight: 884,
        imageWidth: w,
        imageHeight: h,
        maxWidth: opts?.maxWidth ?? 1280,
        crop: opts?.crop ?? null,
        wechatWindow: { id: '10485776', x: 0, y: 0, width: 1836, height: 884, title: '微信' },
        bytes: png.length,
        durationMs: 42,
      };
    },
    effectiveLimits: () => ({ soft: 1500, hard: 1843 }),
    activeVncViewerCount: (id) => (id === RUNNING_INST.id ? 1 : 0),
    getControlLock: (id) =>
      id === RUNNING_INST.id ? { active: true, holder: 'admin', ageMs: 1200 } : { active: false, holder: null, ageMs: null },
    hasActiveSession: (id) => id === RUNNING_INST.id,
    log: (line) => logs.push(line),
    ...overrides,
  };

  registerMcp(app, deps);
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url || '';
    if (url.startsWith('/api') || url.startsWith('/desktop') || url === '/mcp' || url.startsWith('/mcp/') || url.startsWith('/mcp?')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type('text/html').send('<html>spa</html>');
  });

  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url,
    logs,
    called,
    getLastShotOpts: () => lastShotOpts,
    close: () => app.close(),
  };
}

test('MCP disabled when MCP_AUTH_TOKEN is unset/empty: returns 404 JSON (not SPA HTML)', async () => {
  const srv = await buildMockMcpServer({ authToken: '' });
  try {
    const postRes = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(postRes.status, 404);
    assert.equal(JSON.parse(postRes.body).error, 'not found');
    assert.ok(!postRes.body.includes('<html>'));

    const getRes = await rawHttp(`${srv.url}/mcp`, { method: 'GET' });
    assert.equal(getRes.status, 404);
    assert.equal(JSON.parse(getRes.body).error, 'not found');
  } finally {
    await srv.close();
  }
});

test('MCP security gates: 401 auth, 400 illegal Host, 403 illegal Origin, 405 GET/DELETE', async () => {
  const srv = await buildMockMcpServer();
  try {
    // Missing auth
    const noAuth = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_HEADERS.accept },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(noAuth.status, 401);

    // Wrong token + cookie alone does not authenticate
    const badAuth = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer totally-wrong',
        cookie: 'woc_sess=some-session-cookie',
        'content-type': 'application/json',
        accept: MCP_HEADERS.accept,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(badAuth.status, 401);

    // Illegal Host header rejected by real host-guard (400)
    const badHost = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, host: 'evil.attacker.test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(badHost.status, 400);
    assert.equal(JSON.parse(badHost.body).error, 'Host header not allowed');

    // Illegal Origin header rejected with 403
    const badOrigin = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, origin: 'https://evil.attacker.test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(JSON.parse(badOrigin.body).error, 'Origin not allowed');

    // GET and DELETE return 405 with Allow: POST
    const getRes = await rawHttp(`${srv.url}/mcp`, {
      method: 'GET',
      headers: { authorization: MCP_HEADERS.authorization },
    });
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.allow, 'POST');

    const delRes = await rawHttp(`${srv.url}/mcp`, {
      method: 'DELETE',
      headers: { authorization: MCP_HEADERS.authorization },
    });
    assert.equal(delRes.status, 405);
    assert.equal(delRes.headers.allow, 'POST');

    // Never log the auth token
    assert.ok(!srv.logs.join('\n').includes(TEST_TOKEN));
  } finally {
    await srv.close();
  }
});

test('MCP end-to-end POST /mcp: initialize, tools/list, and all 7 read-only tools + stopped paths', async () => {
  const srv = await buildMockMcpServer();
  const rpc = async (id: number, method: string, params?: Record<string, unknown>, extraHeaders?: Record<string, string>) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    assert.equal(res.status, 200, `Expected 200 for ${method}, got ${res.status}: ${res.body}`);
    assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
    return JSON.parse(res.body);
  };

  try {
    // 1. initialize (with allowed LAN Origin)
    const init = await rpc(
      1,
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
      { origin: 'http://192.168.50.115:36080' },
    );
    assert.equal(init.result.serverInfo.name, 'woc-panel-mcp');

    // 2. tools/list — exact 7 read-only tools
    const list = await rpc(2, 'tools/list');
    const names = list.result.tools.map((t: any) => t.name);
    assert.deepEqual(names, MCP_TOOLS.map((t) => t.name));
    assert.equal(names.length, 7);
    for (const tool of list.result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }

    // 3. woc_health
    const health = await rpc(3, 'tools/call', { name: 'woc_health', arguments: {} });
    const healthData = JSON.parse(health.result.content[0].text);
    assert.equal(healthData.ok, true);
    assert.equal(healthData.socket_proxy_ok, true);
    assert.deepEqual(healthData.instances, { total: 2, running: 1, stopped: 1, missing: 0 });

    // 4. woc_list_instances — never leaks kasmPassword / kasmUser
    const instList = await rpc(4, 'tools/call', { name: 'woc_list_instances', arguments: {} });
    const instText = instList.result.content[0].text;
    assert.ok(!instText.includes('SUPER_SECRET_KASM_PASSWORD'));
    assert.ok(!instText.includes('kasmPassword'));
    const instData = JSON.parse(instText);
    assert.equal(instData.instances.length, 2);
    assert.equal(instData.instances[0].runtime, 'running');
    assert.equal(instData.instances[0].memory_mb, 878);
    assert.equal(instData.instances[1].runtime, 'stopped');
    assert.equal(instData.instances[1].instance_stopped, true);
    assert.equal(instData.instances[1].memory_mb, null);

    // 5. woc_instance_status (running & stopped)
    const statusRun = await rpc(5, 'tools/call', {
      name: 'woc_instance_status',
      arguments: { instance_id: RUNNING_INST.id },
    });
    const statusRunData = JSON.parse(statusRun.result.content[0].text);
    assert.equal(statusRunData.instance_stopped, false);
    assert.equal(statusRunData.vnc_http_healthy, true);
    assert.equal(statusRunData.wechat.version, '4.1.1.8');
    assert.deepEqual(statusRunData.watchdog_limits_mb, { soft: 1500, hard: 1843 });

    const statusStop = await rpc(6, 'tools/call', {
      name: 'woc_instance_status',
      arguments: { instance_id: STOPPED_INST.id },
    });
    const statusStopData = JSON.parse(statusStop.result.content[0].text);
    assert.equal(statusStopData.instance_stopped, true);
    assert.equal(statusStopData.wechat, null);
    assert.ok(!srv.called.includes(`wx:${STOPPED_INST.id}`));
    assert.ok(!srv.called.includes(`http:${STOPPED_INST.id}`));

    // 6. woc_get_logs (running + byte cap + stopped + history)
    const logsRun = await rpc(7, 'tools/call', {
      name: 'woc_get_logs',
      arguments: { instance_id: RUNNING_INST.id, tail: 999 },
    });
    const logsRunData = JSON.parse(logsRun.result.content[0].text);
    assert.equal(logsRunData.tail, 500);
    assert.equal(logsRunData.live_truncated, true);
    assert.ok(Buffer.byteLength(logsRunData.live, 'utf8') <= 64 * 1024);

    const logsStop = await rpc(8, 'tools/call', {
      name: 'woc_get_logs',
      arguments: { instance_id: STOPPED_INST.id, include_history: true, range: '24h' },
    });
    const logsStopData = JSON.parse(logsStop.result.content[0].text);
    assert.equal(logsStopData.instance_stopped, true);
    assert.equal(logsStopData.live, null);
    assert.ok(logsStopData.history.includes('persisted restart note'));

    // 7. woc_list_files (running & stopped)
    const filesRun = await rpc(9, 'tools/call', {
      name: 'woc_list_files',
      arguments: { instance_id: RUNNING_INST.id },
    });
    assert.equal(JSON.parse(filesRun.result.content[0].text).files[0].name, 'report.pdf');

    const filesStop = await rpc(10, 'tools/call', {
      name: 'woc_list_files',
      arguments: { instance_id: STOPPED_INST.id },
    });
    assert.equal(JSON.parse(filesStop.result.content[0].text).error, 'instance_stopped');
    assert.ok(!srv.called.includes(`files:${STOPPED_INST.id}`));

    // 8. woc_window_info (running & stopped)
    const winRun = await rpc(11, 'tools/call', {
      name: 'woc_window_info',
      arguments: { instance_id: RUNNING_INST.id },
    });
    const winData = JSON.parse(winRun.result.content[0].text);
    assert.equal(winData.display_width, 1836);
    assert.equal(winData.wechat_window.title, '微信');

    const winStop = await rpc(12, 'tools/call', {
      name: 'woc_window_info',
      arguments: { instance_id: STOPPED_INST.id },
    });
    assert.equal(JSON.parse(winStop.result.content[0].text).error, 'instance_stopped');
    assert.ok(!srv.called.includes(`win:${STOPPED_INST.id}`));

    // 9. woc_screenshot (running with crop, full_resolution, stopped, and privacy check)
    const shotRun = await rpc(13, 'tools/call', {
      name: 'woc_screenshot',
      arguments: {
        instance_id: RUNNING_INST.id,
        crop: { x: 100, y: 20, width: 600, height: 400 },
      },
    });
    assert.equal(shotRun.result.content.length, 2);
    assert.equal(shotRun.result.content[0].type, 'image');
    assert.equal(shotRun.result.content[0].mimeType, 'image/png');
    const decodedPng = Buffer.from(shotRun.result.content[0].data, 'base64');
    assert.deepEqual(parsePngDimensions(decodedPng), { width: 600, height: 400 });
    const shotMeta = JSON.parse(shotRun.result.content[1].text);
    assert.equal(shotMeta.image_width, 600);
    assert.equal(shotMeta.display_width, 1836);
    assert.equal(shotMeta.wechat_window.title, '微信');
    // Privacy: logs must NEVER contain base64 image data
    assert.ok(!srv.logs.join('\n').includes(shotRun.result.content[0].data));

    await rpc(14, 'tools/call', {
      name: 'woc_screenshot',
      arguments: { instance_id: RUNNING_INST.id, full_resolution: true },
    });
    assert.equal(srv.getLastShotOpts()?.maxWidth, 0);

    const shotStop = await rpc(15, 'tools/call', {
      name: 'woc_screenshot',
      arguments: { instance_id: STOPPED_INST.id },
    });
    assert.equal(JSON.parse(shotStop.result.content[0].text).error, 'instance_stopped');
    assert.ok(!srv.called.includes(`shot:${STOPPED_INST.id}`));
  } finally {
    await srv.close();
  }
});

// ---------- Live booted src/index.ts HTTP verification ----------

async function withBootedPanel(
  extraEnv: Record<string, string | undefined>,
  run: (url: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'woc-mcp-http-'));
  writeFileSync(join(dir, 'index.html'), '<html>spa-fallback</html>');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    STATIC_DIR: dir,
    PANEL_DATA: join(dir, 'accounts.json'),
    PANEL_ADMIN_USER: 'TestAdmin',
    PANEL_ADMIN_PASSWORD: 'isolated-test-password',
    WOC_DOCKER_NETWORK: 'test-no-docker',
    DOCKER_HOST: 'unix:///nonexistent-test-docker.sock',
    WOC_INSTANCE_MEM_SOFT_MB: '0',
    WOC_INSTANCE_MEM_HARD_MB: '0',
    WOC_WATCHDOG_INTERVAL_SEC: '0',
  };
  delete env.MCP_AUTH_TOKEN;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('booted panel startup timed out')), 10000);
      child.stdout.on('data', (data) => {
        output += data;
        const m = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`booted panel exited early (${code})`));
      });
    });
    await run(url);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real panel boot: /mcp is disabled (404 JSON, not SPA HTML) when MCP_AUTH_TOKEN is unset', { timeout: 20000 }, async () => {
  await withBootedPanel({ MCP_AUTH_TOKEN: undefined }, async (url) => {
    const res = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error, 'not found');
    assert.ok(!res.body.includes('<html>'));
  });
});

test('real panel boot: /mcp enforces auth/host/origin/method and serves initialize, tools/list, and woc_health gracefully without Docker', { timeout: 20000 }, async () => {
  await withBootedPanel({ MCP_AUTH_TOKEN: TEST_TOKEN }, async (url) => {
    // Missing auth -> 401
    assert.equal(
      (await rawHttp(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
      401,
    );
    // Illegal Host -> 400 (host-guard)
    assert.equal(
      (await rawHttp(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, host: 'evil.attacker.test' }, body: '{}' })).status,
      400,
    );
    // Illegal Origin -> 403
    assert.equal(
      (await rawHttp(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, origin: 'https://evil.attacker.test' }, body: '{}' })).status,
      403,
    );
    // GET -> 405
    const getRes = await rawHttp(`${url}/mcp`, { method: 'GET', headers: { authorization: MCP_HEADERS.authorization } });
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.allow, 'POST');

    // initialize
    const initRes = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'live-test', version: '1.0' } },
      }),
    });
    assert.equal(initRes.status, 200);
    assert.equal(JSON.parse(initRes.body).result.serverInfo.name, 'woc-panel-mcp');

    // tools/list
    const listRes = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(listRes.status, 200);
    assert.equal(JSON.parse(listRes.body).result.tools.length, 7);

    // woc_health degrades gracefully when Docker socket is unreachable
    const healthRes = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'woc_health', arguments: {} },
      }),
    });
    assert.equal(healthRes.status, 200);
    const healthPayload = JSON.parse(JSON.parse(healthRes.body).result.content[0].text);
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.socket_proxy_ok, false);
    assert.equal(healthPayload.instances.total, 0);
  });
});
