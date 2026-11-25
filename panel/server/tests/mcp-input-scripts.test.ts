import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import Docker from 'dockerode';

const dir = mkdtempSync(join(tmpdir(), 'woc-mcp-input-tests-'));
process.env.PANEL_DATA = join(dir, 'accounts.json');
after(() => rmSync(dir, { recursive: true, force: true }));
const {
  CLICK_SCRIPT,
  SCROLL_SCRIPT,
  SEND_RETURN_SCRIPT,
  WECHAT_FOCUS_INPUT,
  FINGERPRINT_FILTER_GRAPH,
  INPUT_KILL_AFTER_SEC,
  InputCommandError,
  assertInputOk,
  collectScriptResult,
  clickInInstance,
  scrollInInstance,
  sendReturnInInstance,
  typeInInstance,
  clearInputInInstance,
  withInstanceInputLock,
  encodeGrayPng,
  extractGrayRows,
  parsePngDimensions,
} = await import('../src/docker.js');

// ---------- A fake xdotool that keeps the `mousemove --sync` behaviour of xdotool 3.20160805.1 ----------
// (Debian bookworm, the instance image): --sync waits for the pointer to LEAVE its previous position, polling
// 500 x 30ms. When the pointer already sits on the target it never leaves, so the command blocks for 15s.
const FAKE_XDOTOOL = `#!/bin/bash
echo "$*" >> "$XDO_LOG"
case "$1" in
  getmouselocation)
    read -r px py < "$XDO_STATE"
    printf 'X=%s\\nY=%s\\nSCREEN=0\\nWINDOW=1\\n' "$px" "$py"
    ;;
  getactivewindow)
    cat "$XDO_ACTIVE"
    ;;
  mousemove)
    shift
    sync=0
    if [ "$1" = "--sync" ]; then sync=1; shift; fi
    read -r px py < "$XDO_STATE"
    [ "\${XDO_STUCK:-0}" = "1" ] || echo "$1 $2" > "$XDO_STATE"
    if [ "$sync" = "1" ] && [ "$px" = "$1" ] && [ "$py" = "$2" ]; then sleep 15; fi
    ;;
esac
exit 0
`;

function makeFakeX(pointer = '10 10', activeWindow = '10485776') {
  const d = mkdtempSync(join(dir, 'fakex-'));
  writeFileSync(join(d, 'xdotool'), FAKE_XDOTOOL);
  chmodSync(join(d, 'xdotool'), 0o755);
  writeFileSync(join(d, 'state'), `${pointer}\n`);
  writeFileSync(join(d, 'active'), `${activeWindow}\n`);
  writeFileSync(join(d, 'log'), '');
  const env = {
    ...process.env,
    PATH: `${d}:${process.env.PATH}`,
    DISPLAY: ':99',
    XDO_STATE: join(d, 'state'),
    XDO_ACTIVE: join(d, 'active'),
    XDO_LOG: join(d, 'log'),
  };
  return {
    env,
    calls: () => readFileSync(join(d, 'log'), 'utf8').split('\n').filter(Boolean),
    resetLog: () => writeFileSync(join(d, 'log'), ''),
    setActive: (id: string) => writeFileSync(join(d, 'active'), `${id}\n`),
  };
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const t0 = Date.now();
  const res = spawnSync('bash', ['-c', script, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  return { status: res.status, stderr: res.stderr, ms: Date.now() - t0 };
}

// r3 (fd2c733) scroll script, kept verbatim to show what the fake reproduces.
const R3_SCROLL_SCRIPT = [
  'set -eu',
  'display="$1"; x="$2"; y="$3"; btn="$4"; clicks="$5"',
  'export DISPLAY="$display"',
  'xdotool mousemove --sync "$x" "$y" click --repeat "$clicks" --delay 40 "$btn"',
].join('\n');

test('click/scroll/focus scripts never use `mousemove --sync`', () => {
  for (const script of [CLICK_SCRIPT, SCROLL_SCRIPT, WECHAT_FOCUS_INPUT]) {
    assert.doesNotMatch(script, /mousemove[^\n]*--sync/);
    assert.match(script, /^xdotool mousemove "\$c?x" "\$c?y"$/m);
  }
});

test('r3 scroll script blocks on a repeated coordinate; the new scripts return at once', { timeout: 30_000 }, async () => {
  const fake = makeFakeX();

  // r3: first scroll at (1000,400) moves the pointer and returns; the second one at the same spot hangs.
  assert.equal(runScript(R3_SCROLL_SCRIPT, ['woc-scroll', ':99', '1000', '400', '4', '3'], fake.env).status, 0);
  const hung = spawn('bash', ['-c', R3_SCROLL_SCRIPT, 'woc-scroll', ':99', '1000', '400', '5', '3'], {
    env: fake.env,
    stdio: 'ignore',
    detached: true,
  });
  let exited = false;
  hung.once('exit', () => { exited = true; });
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(exited, false, 'r3 script should still be blocked in mousemove --sync after 2.5s');
  process.kill(-hung.pid!, 'SIGKILL');
  await once(hung, 'exit');

  // New script: up, then down, then down again at the very same coordinate — the B2 / B6 sequence.
  fake.resetLog();
  for (const btn of ['4', '5', '5']) {
    const r = runScript(SCROLL_SCRIPT, ['woc-scroll', ':99', '1000', '400', btn, '3'], fake.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 2000, `scroll took ${r.ms}ms`);
  }
  const scrollCalls = fake.calls();
  assert.deepEqual(scrollCalls.filter((c) => c.startsWith('click')), [
    'click --repeat 3 --delay 40 4',
    'click --repeat 3 --delay 40 5',
    'click --repeat 3 --delay 40 5',
  ]);
  assert.equal(scrollCalls.filter((c) => c === 'mousemove 1000 400').length, 3);

  // Same for two clicks on one spot, single and double.
  fake.resetLog();
  for (const dbl of ['0', '0', '1']) {
    const r = runScript(CLICK_SCRIPT, ['woc-click', ':99', '200', '648', '1', dbl], fake.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 2000, `click took ${r.ms}ms`);
  }
  assert.deepEqual(fake.calls().filter((c) => c.startsWith('click')), ['click 1', 'click 1', 'click --repeat 2 --delay 80 1']);
  // Order inside one run: release modifiers, move, read the pointer back, only then click.
  assert.deepEqual(
    fake.calls().slice(0, 4).map((c) => c.split(' ')[0]),
    ['keyup', 'mousemove', 'getmouselocation', 'click'],
  );
});

test('click/scroll refuse to click when the pointer did not reach the target (exit 5, nothing dispatched)', () => {
  const fake = makeFakeX('10 10');
  const env = { ...fake.env, XDO_STUCK: '1' };
  const click = runScript(CLICK_SCRIPT, ['woc-click', ':99', '200', '648', '1', '0'], env);
  assert.equal(click.status, 5);
  assert.match(click.stderr, /pointer_not_at_target actual=10,10 target=200,648/);
  const scroll = runScript(SCROLL_SCRIPT, ['woc-scroll', ':99', '200', '648', '5', '3'], env);
  assert.equal(scroll.status, 5);
  assert.equal(fake.calls().filter((c) => c.startsWith('click')).length, 0);
});

test('send-return script presses Return once only while the WeChat main window is the active window', () => {
  const fake = makeFakeX('10 10', '10485776');
  const ok = runScript(SEND_RETURN_SCRIPT, ['woc-send-return', '10485776', '1'], fake.env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(fake.calls().filter((c) => c.startsWith('key ')), ['key Return']);
  const calls = fake.calls().map((c) => c.split(' ')[0]);
  assert.deepEqual(calls, ['getactivewindow', 'keyup', 'key']);

  // A dialog / another window took focus: exit 4 and no key at all.
  fake.resetLog();
  fake.setActive('20971521');
  const stolen = runScript(SEND_RETURN_SCRIPT, ['woc-send-return', '10485776', '1'], fake.env);
  assert.equal(stolen.status, 4);
  assert.match(stolen.stderr, /focus_mismatch active=20971521 expected=10485776/);
  assert.deepEqual(fake.calls(), ['getactivewindow']);

  // No active window reported at all is also a mismatch.
  fake.resetLog();
  fake.setActive('');
  assert.equal(runScript(SEND_RETURN_SCRIPT, ['woc-send-return', '10485776', '1'], fake.env).status, 4);
  assert.equal(fake.calls().filter((c) => c.startsWith('key')).length, 0);

  // MCP_CONFIRM_FOCUS_CHECK=0 escape hatch skips the query.
  fake.resetLog();
  assert.equal(runScript(SEND_RETURN_SCRIPT, ['woc-send-return', '10485776', '0'], fake.env).status, 0);
  assert.deepEqual(fake.calls().map((c) => c.split(' ')[0]), ['keyup', 'key']);
});

test('assertInputOk separates "nothing dispatched" from "unknown" and names the timeout', () => {
  assert.doesNotThrow(() => assertInputOk({ exitCode: 0, stdout: '', stderr: '' }, '点击'));
  const expectErr = (exitCode: number, stderr: string, code: string, dispatched: string) => {
    assert.throws(
      () => assertInputOk({ exitCode, stdout: '', stderr }, '点击'),
      (e: any) => e instanceof InputCommandError && e.code === code && e.dispatched === dispatched,
      `exit ${exitCode}`,
    );
  };
  expectErr(124, '', 'input_timeout', 'unknown'); // timeout(1) fired SIGTERM
  expectErr(137, '', 'input_timeout', 'unknown'); // ... and had to SIGKILL
  expectErr(4, 'focus_mismatch active=1 expected=2', 'focus_mismatch', 'no');
  expectErr(5, 'pointer_not_at_target', 'input_precondition_failed', 'no');
  expectErr(3, '未找到微信聊天窗口', 'input_precondition_failed', 'no');
  expectErr(127, 'xdotool not installed in instance image', 'input_precondition_failed', 'no');
  expectErr(1, 'X Error', 'input_failed', 'unknown');
});

test('collectScriptResult returns the exit code and rejects when the outcome cannot be known', async () => {
  const mk = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });

  const s1 = mk();
  const ok = await collectScriptResult(
    s1,
    (_s, stdout, stderr) => queueMicrotask(() => {
      stdout.write(Buffer.from('out'));
      stderr.write(Buffer.from('pointer_not_at_target'));
      s1.emit('end');
      s1.emit('close');
    }),
    async () => ({ Running: false, ExitCode: 5 }),
    { timeoutMs: 2000 },
  );
  assert.deepEqual(ok, { exitCode: 5, stdout: 'out', stderr: 'pointer_not_at_target' });

  const s2 = mk();
  await assert.rejects(
    collectScriptResult(s2, () => {}, async () => ({ Running: false, ExitCode: 0 }), { timeoutMs: 30 }),
    /命令结果未知：执行超时/,
  );
  assert.equal(s2.destroyed, true);

  const s3 = mk();
  await assert.rejects(
    collectScriptResult(s3, () => queueMicrotask(() => s3.emit('close')), async () => ({ Running: false, ExitCode: 0 }), { timeoutMs: 2000 }),
    /命令结果未知：连接关闭/,
  );

  const s4 = mk();
  await assert.rejects(
    collectScriptResult(s4, () => queueMicrotask(() => s4.emit('end')), async () => ({ Running: true, ExitCode: null }), { timeoutMs: 2000 }),
    /无法确认执行已结束/,
  );
});

// ---------- docker exec wiring ----------
function dockerFrame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const WINDOW_INFO_OUT = 'DISPLAY\t:1\t1836\t884\nWINDOW\t10485776\t0\t0\t1836\t884\t微信\n';

function mockDocker(t: any, plans: Array<{ exit?: number; stdout?: string; stderr?: string }>) {
  const cmds: string[][] = [];
  t.mock.method(Docker.prototype, 'getContainer', () => ({
    exec: async (opts: any) => {
      cmds.push(opts.Cmd);
      const plan = plans.shift() ?? {};
      return {
        inspect: async () => ({ ExitCode: plan.exit ?? 0, Running: false }),
        start: async () => {
          const s = new PassThrough();
          setImmediate(() => {
            if (plan.stdout) s.write(dockerFrame(1, plan.stdout));
            if (plan.stderr) s.write(dockerFrame(2, plan.stderr));
            s.end();
          });
          return s;
        },
      };
    },
  }));
  return cmds;
}

const INST: any = { id: '1d29600a24', containerName: 'test-only-mcp-input', appType: 'wechat' };

test('clickInInstance/scrollInInstance run under `timeout -k 1 N` and release the input lock on failure', async (t) => {
  const cmds = mockDocker(t, [
    { stdout: WINDOW_INFO_OUT }, { exit: 0 },
    { stdout: WINDOW_INFO_OUT }, { exit: 124 },
    { stdout: WINDOW_INFO_OUT }, { exit: 5, stderr: 'pointer_not_at_target actual=1,1 target=1000,400\n' },
    { stdout: WINDOW_INFO_OUT }, { exit: 0 },
  ]);

  assert.deepEqual(
    await clickInInstance(INST, { x: 200, y: 648, displayWidth: 1836, displayHeight: 884 }),
    { displayWidth: 1836, displayHeight: 884 },
  );
  assert.deepEqual(cmds[1], [
    'timeout', '-k', '1', String(INPUT_KILL_AFTER_SEC), 'bash', '-c', CLICK_SCRIPT, 'woc-click', ':1', '200', '648', '1', '0',
  ]);

  // Killed by the in-container timeout: typed error, and the lock is free for the next call.
  await assert.rejects(
    scrollInInstance(INST, { x: 1000, y: 400, displayWidth: 1836, displayHeight: 884, direction: 'down', clicks: 3 }),
    (e: any) => e instanceof InputCommandError && e.code === 'input_timeout' && e.dispatched === 'unknown' && /不会延迟触发/.test(e.message),
  );
  assert.deepEqual(cmds[3].slice(0, 6), ['timeout', '-k', '1', String(INPUT_KILL_AFTER_SEC), 'bash', '-c']);
  assert.deepEqual(cmds[3].slice(6), [SCROLL_SCRIPT, 'woc-scroll', ':1', '1000', '400', '5', '3']);

  await assert.rejects(
    scrollInInstance(INST, { x: 1000, y: 400, displayWidth: 1836, displayHeight: 884, direction: 'down' }),
    (e: any) => e instanceof InputCommandError && e.code === 'input_precondition_failed' && e.dispatched === 'no',
  );
  await scrollInInstance(INST, { x: 1000, y: 400, displayWidth: 1836, displayHeight: 884, direction: 'up', clicks: 1 });
  assert.equal(cmds.length, 8);
  // The panel-side timer must outlast the in-container kill, otherwise it could report before the kill happened.
  assert.ok(INPUT_KILL_AFTER_SEC + 1 < INPUT_KILL_AFTER_SEC + 3);
});

test('sendReturnInInstance, bounded paste and clear: command shape, focus_mismatch, lockHeld', async (t) => {
  const cmds = mockDocker(t, [
    { exit: 0 },
    { exit: 4, stderr: 'focus_mismatch active=20971521 expected=10485776\n' },
    { exit: 0 },
    { exit: 0 },
    { exit: 3, stderr: '未找到微信聊天窗口：请确认微信已登录、主窗口未最小化\n' },
    { exit: 0 },
  ]);

  await sendReturnInInstance(INST, '10485776');
  assert.deepEqual(cmds[0], ['timeout', '-k', '1', '5', 'bash', '-c', SEND_RETURN_SCRIPT, 'woc-send-return', '10485776', '1']);
  await assert.rejects(
    sendReturnInInstance(INST, '10485776'),
    (e: any) => e instanceof InputCommandError && e.code === 'focus_mismatch' && e.dispatched === 'no',
  );
  await sendReturnInInstance(INST, '10485776', { focusCheck: false });
  assert.equal(cmds[2].at(-1), '0');
  // A non-numeric window id never reaches the container.
  await assert.rejects(sendReturnInInstance(INST, '0x1; rm -rf /'), (e: any) => e.dispatched === 'no');
  assert.equal(cmds.length, 3);

  // woc_draft_reply path: caller holds the lock, paste is time-boxed and never contains Return.
  await withInstanceInputLock(INST, async () => {
    await typeInInstance(INST, '你好', { focusChat: true, clearFirst: true, send: false, lockHeld: true, killAfterSec: 12 });
    // Without lockHeld the same call is refused while the lock is taken, proving the lock is really held here.
    await assert.rejects(typeInInstance(INST, '你好', { focusChat: true, killAfterSec: 12 }), (e: any) => e.statusCode === 409);
    await assert.rejects(clickInInstance(INST, { x: 1, y: 1, displayWidth: 1836, displayHeight: 884 }), (e: any) => e.statusCode === 409);
  });
  assert.deepEqual(cmds[3].slice(0, 6), ['timeout', '-k', '1', '12', 'bash', '-c']);
  assert.ok(cmds[3][6].includes(WECHAT_FOCUS_INPUT));
  assert.match(cmds[3][6], /xdotool key ctrl\+a\n[^]*xdotool key BackSpace\n[^]*xdotool key ctrl\+v/);
  assert.doesNotMatch(cmds[3][6], /xdotool key Return/);

  // woc_discard_draft path: window not found -> nothing dispatched; success afterwards (lock was released).
  await assert.rejects(
    clearInputInInstance(INST),
    (e: any) => e instanceof InputCommandError && e.code === 'input_precondition_failed' && e.dispatched === 'no',
  );
  await clearInputInInstance(INST);
  assert.deepEqual(cmds[5].slice(0, 6), ['timeout', '-k', '1', String(INPUT_KILL_AFTER_SEC), 'bash', '-c']);
  assert.doesNotMatch(cmds[5][6], /xdotool key Return/);
});

// ---------- fingerprint bitmap helpers ----------
test('encodeGrayPng produces a valid grayscale PNG that decodes back to the same bytes', () => {
  const w = 7, h = 3;
  const gray = Buffer.from(Array.from({ length: w * h }, (_, i) => (i * 37) % 256));
  const png = encodeGrayPng(gray, w, h);
  assert.deepEqual(parsePngDimensions(png), { width: w, height: h });
  assert.equal(png[24], 8);
  assert.equal(png[25], 0);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString('ascii', 37, 41), 'IDAT');
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (w + 1)], 0);
    assert.ok(raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1)).equals(gray.subarray(y * w, (y + 1) * w)));
  }
  assert.throws(() => encodeGrayPng(gray, w, h + 1));

  // Checksums: verified by a real PNG decoder when one is available.
  if (spawnSync('ffmpeg', ['-version']).status === 0) {
    const file = join(dir, 'gray.png');
    writeFileSync(file, png);
    const dec = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    assert.equal(dec.status, 0, dec.stderr?.toString());
    assert.ok(dec.stdout.equals(gray));
  }
});

test('extractGrayRows slices left-aligned blocks out of a padded bitmap', () => {
  const stride = 5;
  const buf = Buffer.from([
    1, 2, 3, 0, 0,
    4, 5, 6, 0, 0,
    7, 8, 9, 10, 11,
    12, 13, 14, 15, 16,
  ]);
  assert.deepEqual([...extractGrayRows(buf, stride, 0, 3, 2)], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...extractGrayRows(buf, stride, 2, 5, 2)], [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.throws(() => extractGrayRows(buf, stride, 3, 5, 2));
});

test('fingerprint filter graph yields native 1:1 header + editor crops of one frame (real ffmpeg)', { timeout: 30_000 }, (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('ffmpeg not installed');
  const v = { hw: 280, hh: 44, hx: 355, hy: 12, ew: 1461, eh: 82, ex: 355, ey: 742, pw: 1461 };
  const graph = FINGERPRINT_FILTER_GRAPH.replace(/\$\{(\w+)\}/g, (_m, k: keyof typeof v) => String(v[k]));
  assert.doesNotMatch(graph, /scale=/); // nothing is resampled any more
  // bgr0 like x11grab delivers it: an RGB source is not chroma-subsampled, so odd crop sizes stay exact.
  const src = ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1836x884:rate=1,format=bgr0', '-vframes', '1'];
  const out = ['-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
  const combined = spawnSync('ffmpeg', [...src, '-filter_complex', graph, '-map', '[out]', ...out], { maxBuffer: 8 << 20 });
  assert.equal(combined.status, 0, combined.stderr?.toString());
  assert.equal(combined.stdout.length, v.pw * (v.hh + v.eh));

  const crop = (w: number, h: number, x: number, y: number) => {
    const r = spawnSync('ffmpeg', [...src, '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, ...out], { maxBuffer: 8 << 20 });
    assert.equal(r.status, 0, r.stderr?.toString());
    return r.stdout;
  };
  const header = extractGrayRows(combined.stdout, v.pw, 0, v.hw, v.hh);
  const editor = extractGrayRows(combined.stdout, v.pw, v.hh, v.ew, v.eh);
  assert.ok(header.equals(crop(v.hw, v.hh, v.hx, v.hy)), 'header block must equal a direct native crop');
  assert.ok(editor.equals(crop(v.ew, v.eh, v.ex, v.ey)), 'editor block must equal a direct native crop');
});

// ---------- WOC_BOOT_NO_AUTOSTART ----------
test('real panel boot: WOC_BOOT_NO_AUTOSTART leaves the listed instance alone and still tries the others', { timeout: 30_000 }, async () => {
  const bootDir = mkdtempSync(join(dir, 'boot-'));
  writeFileSync(join(bootDir, 'index.html'), '<html>spa</html>');
  const mkInst = (id: string, name: string) => ({
    id,
    name,
    appType: 'wechat',
    containerName: `woc-wx-${id}`,
    volumeName: `woc-data-${id}`,
    kasmUser: 'woc',
    kasmPassword: 'x',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'admin-1',
  });
  writeFileSync(
    join(bootDir, 'accounts.json'),
    JSON.stringify({ users: [], instances: [mkInst('1d29600a24', 'Mike'), mkInst('81a0dbf17d', '代购')] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    STATIC_DIR: bootDir,
    PANEL_DATA: join(bootDir, 'accounts.json'),
    PANEL_ADMIN_USER: 'TestAdmin',
    PANEL_ADMIN_PASSWORD: 'isolated-test-password',
    WOC_DOCKER_NETWORK: 'test-no-docker',
    DOCKER_HOST: 'unix:///nonexistent-test-docker.sock',
    WOC_INSTANCE_MEM_SOFT_MB: '0',
    WOC_INSTANCE_MEM_HARD_MB: '0',
    WOC_WATCHDOG_INTERVAL_SEC: '0',
    WOC_BOOT_NO_AUTOSTART: ' 81a0dbf17d ,',
  };
  delete env.MCP_AUTH_TOKEN;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`booted panel startup timed out\n${output}`)), 20_000);
      child.stdout.on('data', (d) => {
        output += d;
        if (/Server listening at http:\/\/127\.0\.0\.1:\d+/.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`booted panel exited early (${code})\n${output}`));
      });
    });
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  }
  assert.ok(existsSync(join(bootDir, 'accounts.json')));
  assert.match(output, /WOC_BOOT_NO_AUTOSTART：启动时跳过实例 81a0dbf17d/);
  assert.doesNotMatch(output, /启动实例 81a0dbf17d 失败/); // never touched
  assert.match(output, /启动实例 1d29600a24 失败/); // attempted (and failed only because the test has no Docker)
});
