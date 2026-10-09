import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fatalErrorMsg, isExtensionErrorEvent } from '../../web/src/vnc-errors.ts';

// 浮层内容是相邻的几个 div（消息 / 出错位置 / 堆栈）
function overlay(parts: string[], state: 'connected' | 'connecting' | 'disconnected' = 'connected') {
  let open = true;
  let children = parts.map((t) => ({ textContent: t }));
  const box = {
    get children() { return children; },
    get textContent() { return children.map((c) => c.textContent).join(''); },
    replaceChildren() { children = []; },
  };
  const doc = {
    documentElement: { classList: { contains: (c: string) => c === 'noVNC_' + state } },
    getElementById: (id: string) => id === 'noVNC_fallback_error'
      ? { classList: { contains: () => open, remove: () => { open = false; } } }
      : box,
  } as unknown as Document;
  return { doc, open: () => open, empty: () => children.length === 0 };
}

test('VNC errors: extension error split across overlay divs is recognised (no glued "MetaMaskchrome-extension")', () => {
  const o = overlay(['Failed to connect to MetaMask', 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js']);
  let noted = 0;
  assert.equal(fatalErrorMsg(o.doc, () => noted++), null);
  assert.equal(noted, 1);
  assert.equal(o.open(), false);
});

test('VNC errors: dismissing an overlay clears it so a later real crash can still open it', () => {
  const ext = overlay(['oops', 'chrome-extension://id/x.js:1']);
  fatalErrorMsg(ext.doc);
  assert.ok(ext.empty());
  const gap = overlay(["Cannot read properties of undefined (reading 'lastActiveAt')"], 'connecting');
  fatalErrorMsg(gap.doc);
  assert.ok(gap.empty());
});

test('VNC errors: a KasmVNC frame before an extension frame is still fatal', () => {
  const o = overlay(['TypeError', 'https://panel.test/vnc/core/rfb.js:1', 'chrome-extension://id/x.js:1']);
  assert.ok(fatalErrorMsg(o.doc));
  assert.equal(o.open(), true);
});

test('VNC errors: extension error events are caught in capture phase only while connected', () => {
  const ev = { filename: 'chrome-extension://id/inpage.js', error: { stack: 'at chrome-extension://id/inpage.js:1:1' } } as unknown as Event;
  assert.equal(isExtensionErrorEvent(ev, overlay([]).doc), true);
  assert.equal(isExtensionErrorEvent(ev, overlay([], 'disconnected').doc), false);
  const own = { filename: 'https://panel.test/vnc/app/ui.js', error: { stack: 'at https://panel.test/vnc/app/ui.js:1' } } as unknown as Event;
  assert.equal(isExtensionErrorEvent(own, overlay([]).doc), false);
  const rejection = { reason: { stack: 'Error\n at moz-extension://id/a.js:2' } } as unknown as Event;
  assert.equal(isExtensionErrorEvent(rejection, overlay([]).doc), true);
});
