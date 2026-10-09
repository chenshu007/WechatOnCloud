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
const { typeInInstance, keyInInstance, XDO_RELEASE_MODS } = await import('../src/docker.js');

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
