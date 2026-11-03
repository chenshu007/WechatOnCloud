import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';

const dir = mkdtempSync(join(tmpdir(), 'woc-input-tests-'));
process.env.PANEL_DATA = join(dir, 'accounts.json');
after(() => rmSync(dir, { recursive: true, force: true }));
const { typeInInstance, keyInInstance, XDO_RELEASE_MODS, WECHAT_FOCUS_INPUT } = await import('../src/docker.js');

// 上游 31c5146：服务端按键先 keyup 修饰键再按，绝不再用 --clearmodifiers（会把用户按着的 Ctrl「按回去」留在 XTEST 上）
test('server key presses release modifiers first and never use --clearmodifiers', async (t) => {
  const scripts: string[] = [];
  t.mock.method(Docker.prototype, 'getContainer', () => ({
    exec: async (opts: any) => {
      scripts.push(opts.Cmd[2]);
      return {
        inspect: async () => ({ ExitCode: 0, Running: false }),
        start: async () => { const s = new PassThrough(); setImmediate(() => s.end()); return s; },
      };
    },
  }));
  const inst: any = { id: 'abc123', containerName: 'test-only' };
  await typeInInstance(inst, '你好');
  await keyInInstance(inst, 'Return');
  await keyInInstance(inst, 'ctrl+v');
  assert.equal(scripts.length, 3);
  for (const s of scripts) {
    assert.doesNotMatch(s, /clearmodifiers/);
    const lines = s.split('\n');
    const press = lines.findIndex((l) => l.startsWith('xdotool key '));
    assert.ok(press > 0 && lines[press - 1] === XDO_RELEASE_MODS, s);
  }
  assert.match(scripts[1], /^xdotool key Return$/m);
});

// 「锁定当前会话」：先点微信主窗口输入框再粘贴；勾了自动回车时回车与粘贴同一次 exec、排在粘贴之后
test('typeInInstance focuses the WeChat chat input first and sends in the same exec', async (t) => {
  const scripts: string[] = [];
  t.mock.method(Docker.prototype, 'getContainer', () => ({
    exec: async (opts: any) => {
      scripts.push(opts.Cmd[2]);
      return {
        inspect: async () => ({ ExitCode: 0, Running: false }),
        start: async () => { const s = new PassThrough(); setImmediate(() => s.end()); return s; },
      };
    },
  }));
  const wechat: any = { id: 'abc123', containerName: 'test-only', appType: 'wechat' };
  const telegram: any = { id: 'def456', containerName: 'test-only-2', appType: 'telegram' };
  await typeInInstance(wechat, '你好', { focusChat: true, send: true });
  await typeInInstance(wechat, '你好', { focusChat: true });
  await typeInInstance(telegram, 'hi', { focusChat: true, send: true });
  await typeInInstance(wechat, '你好');
  assert.equal(scripts.length, 4);

  const s = scripts[0];
  const focus = s.indexOf(WECHAT_FOCUS_INPUT), paste = s.indexOf('xdotool key ctrl+v'), ret = s.indexOf('xdotool key Return');
  assert.ok(focus > s.indexOf('xclip -selection clipboard -i') && focus < paste && paste < ret, s);
  assert.match(WECHAT_FOCUS_INPUT, /--class '\^wechat\$'/);
  assert.match(WECHAT_FOCUS_INPUT, /exit 3/); // 找不到主窗口不盲发
  assert.match(WECHAT_FOCUS_INPUT, /xdotool key ctrl\+End/);

  assert.ok(scripts[1].includes(WECHAT_FOCUS_INPUT));
  assert.doesNotMatch(scripts[1], /xdotool key Return/);
  assert.doesNotMatch(scripts[2], /getwindowname/); // 非微信应用不做窗口定位
  assert.match(scripts[2], /xdotool key Return/);
  assert.doesNotMatch(scripts[3], /getwindowname|xdotool key Return/); // 默认行为不变
});
