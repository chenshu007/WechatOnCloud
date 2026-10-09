import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installSeamlessIme } from '../../web/src/seamless-ime.ts';

// 极简的 iframe 文档替身：doc / win 是 EventTarget，事件对象按需补上 target、data 等字段。
function setup(opts: { imeOn?: boolean; slow?: boolean; fail?: (t: string) => boolean } = {}) {
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const ki: any = {
    id: 'noVNC_keyboardinput', tagName: 'TEXTAREA', value: '', style: {}, inputs: 0,
    focus() { doc.activeElement = ki; },
    dispatchEvent(e: Event) { if (e.type === 'input') ki.inputs++; return true; },
    offsetParent: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }) },
  };
  const imeSetting = { checked: opts.imeOn ?? true };
  const doc: any = Object.assign(new EventTarget(), {
    activeElement: null as any,
    getElementById: (id: string) => (id === 'noVNC_keyboardinput' ? ki : id === 'noVNC_setting_enable_ime' ? imeSetting : null),
  });
  const timers: (() => void)[] = [];
  const win: any = Object.assign(new EventTarget(), { Event, setTimeout: (fn: () => void) => { timers.push(fn); return 0; } });
  const failures: any[] = [];
  const send = (kind: string) => (data: string) => {
    if (opts.fail?.(data)) return Promise.reject(new Error('boom ' + data));
    sent.push(kind === 'text' ? data : `<${data}>`);
    return opts.slow ? new Promise<void>((r) => pending.push(r)) : Promise.resolve();
  };
  const cleanup = installSeamlessIme(win, doc, { text: send('text'), key: send('key') }, (e) => failures.push(e));
  const fire = (on: EventTarget, type: string, props: Record<string, unknown> = {}) => {
    const e = new Event(type, { cancelable: true });
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    on.dispatchEvent(e);
    return e;
  };
  const flush = async () => { for (let i = 0; i < 20; i++) { pending.splice(0).forEach((r) => r()); await new Promise((r) => setImmediate(r)); } };
  return {
    sent, failures, ki, doc, win, cleanup, flush, timers,
    compose: (data: string) => { fire(doc, 'compositionstart'); return fire(doc, 'compositionend', { data }); },
    insert: (data: string) => fire(doc, 'beforeinput', { inputType: 'insertText', data, target: ki, isComposing: false }),
    key: (key: string, extra: Record<string, unknown> = {}) => fire(win, 'keydown', { key, keyCode: 0, ...extra }),
    fire,
  };
}

test('IME: full-width punctuation inserted outside composition keeps its place after Chinese', async () => {
  const s = setup({ slow: true });
  s.compose('你好');
  const p1 = s.insert('，');
  s.compose('世界');
  const p2 = s.insert('。');
  assert.ok(p1.defaultPrevented && p2.defaultPrevented, 'noVNC must not send them again as keysyms');
  await s.flush();
  assert.deepEqual(s.sent, ['你好', '，', '世界', '。']);
});

test('IME: plain ASCII goes straight through when nothing is queued', async () => {
  const s = setup();
  const e = s.insert('a');
  assert.equal(e.defaultPrevented, false);
  assert.equal(s.key('a').defaultPrevented, false);
  assert.equal(s.key(' ').defaultPrevented, false);
  await s.flush();
  assert.deepEqual(s.sent, []);
});

test('IME: digits, space, Enter and Backspace typed while Chinese is in flight stay in order; letters never', async () => {
  const s = setup({ slow: true });
  s.compose('你好');
  assert.ok(s.key('1').defaultPrevented);
  assert.ok(s.key(' ').defaultPrevented); // #155：拼音上屏后紧接着按空格
  assert.equal(s.key('y').defaultPrevented, false); // 下一个词的拼音首字母交给输入法
  assert.equal(s.key(' ', { keyCode: 229 }).defaultPrevented, false); // 输入法自己处理的空格
  assert.equal(s.key(' ', { shiftKey: true }).defaultPrevented, false);
  assert.ok(s.key('Backspace').defaultPrevented);
  assert.ok(s.key('Enter').defaultPrevented);
  await s.flush();
  assert.deepEqual(s.sent, ['你好', '1', ' ', '<BackSpace>', '<Return>']);
});

test('IME: long submissions are split into 500-character chunks', async () => {
  const s = setup();
  s.compose('字'.repeat(1201));
  await s.flush();
  assert.deepEqual(s.sent.map((t) => t.length), [500, 500, 201]);
});

test('IME: a failed send is reported and does not block the queue', async () => {
  const s = setup({ fail: (t) => t === '坏' });
  s.compose('坏');
  s.compose('好');
  await s.flush();
  assert.equal(s.failures.length, 1);
  assert.deepEqual(s.sent, ['好']);
});

test('IME: the hidden input is reset once it grows past 200 characters, never mid-composition', () => {
  const s = setup();
  s.ki.value = 'x'.repeat(300);
  s.compose('你');
  s.fire(s.doc, 'compositionstart');
  s.timers.splice(0).forEach((t) => t());
  assert.equal(s.ki.inputs, 0, 'still composing');
  s.fire(s.doc, 'compositionend', { data: '' });
  s.timers.splice(0).forEach((t) => t());
  assert.equal(s.ki.inputs, 1);
});

test('IME: focus landing on the canvas goes back to the hidden input only when KasmVNC IME mode is on', () => {
  const on = setup();
  on.fire(on.doc, 'focusin', { target: { tagName: 'CANVAS' } });
  assert.equal(on.doc.activeElement, on.ki);
  const off = setup({ imeOn: false });
  off.fire(off.doc, 'focusin', { target: { tagName: 'CANVAS' } });
  assert.equal(off.doc.activeElement, null);
});

test('IME: candidate window follows the click position, clamped to the screen', () => {
  const s = setup();
  s.fire(s.doc, 'mousedown', { target: { tagName: 'CANVAS' }, clientX: 110, clientY: 320 });
  assert.deepEqual(s.ki.style, { left: '100px', top: '300px' });
  s.fire(s.doc, 'mousedown', { target: { tagName: 'CANVAS' }, clientX: 5000, clientY: -50 });
  assert.deepEqual(s.ki.style, { left: '798px', top: '0px' });
  s.fire(s.doc, 'mousedown', { target: { tagName: 'DIV' }, clientX: 50, clientY: 50 });
  assert.deepEqual(s.ki.style, { left: '798px', top: '0px' });
});

test('IME: cleanup detaches every listener', async () => {
  const s = setup();
  s.cleanup();
  s.compose('你好');
  s.fire(s.doc, 'focusin', { target: { tagName: 'CANVAS' } });
  await s.flush();
  assert.deepEqual(s.sent, []);
  assert.equal(s.doc.activeElement, null);
});
