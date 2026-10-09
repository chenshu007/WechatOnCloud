const EXTENSION_SOURCE = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//i;
const FIRST_SOURCE = /\b(?:https?|chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension):\/\/[^\s)]+/i;

// 出错位置是否来自浏览器扩展：只看第一个出错位置，后面的扩展帧不能盖住前面 noVNC / KasmVNC 自己的错误。
function fromExtension(text: string): boolean {
  const first = text.match(FIRST_SOURCE)?.[0];
  return !!first && EXTENSION_SOURCE.test(first);
}

// 在 iframe window 的捕获阶段判断一个 error / unhandledrejection 事件是否来自浏览器扩展（移植自上游 ec48bd7 / 0479b1b）：
// 先于 KasmVNC 的全局处理器截下，连浮层都不弹（MetaMask 这类扩展每十几秒报一次，浮层会反复闪）。VNC 仍连着才算。
export function isExtensionErrorEvent(ev: Event, doc: Document | null | undefined): boolean {
  const e = ev as Partial<ErrorEvent> & Partial<PromiseRejectionEvent>;
  const src = [e.filename, e.error?.stack, e.reason?.stack].filter(Boolean).join(' ');
  return fromExtension(src) && !!doc?.documentElement?.classList.contains('noVNC_connected');
}

// KasmVNC 的全局错误处理器只展示第一条错误：浮层内容非空就不再打开浮层。关浮层时必须清空内容，
// 否则之后 KasmVNC 自己真的崩了（如断线重连时的 lastActiveAt）也弹不出来，这里检测不到，自愈失效。
function dismiss(el: Element, box: Element | null | undefined) {
  el.classList.remove('noVNC_open');
  (box as any)?.replaceChildren?.();
}

// KasmVNC 在 iframe 里有个每 5s 的保活定时器，直接读 UI.rfb.lastActiveAt；断线后 UI.rfb 被置空，在 noVNC 自带重连
// 接上之前的空档里它就抛 "Cannot read properties of undefined (reading 'lastActiveAt')" 并弹致命浮层。干净断开后
// noVNC 已排好 2s 后自己重连，这条报错无害：整页重载只会多一次重连，还白白消耗「5 分钟 4 次」的自愈额度。
// 只有停在 disconnected（非干净断开，noVNC 不会再自己重连）时才交给致命自愈整页重连。（移植自上游 cf69355）
export function isReconnectGapError(msg: string, doc: Document | null | undefined): boolean {
  if (!msg.includes('lastActiveAt')) return false;
  const c = doc?.documentElement?.classList;
  return !!c && !c.contains('noVNC_disconnected');
}

export function fatalErrorMsg(
  doc: Document | null | undefined,
  onExtension?: () => void,
  onReconnectGap?: () => void,
): string | null {
  try {
    const el = doc?.getElementById('noVNC_fallback_error');
    if (!el?.classList.contains('noVNC_open')) return null;
    const box = doc?.getElementById('noVNC_fallback_errormsg');
    // 浮层内容是「消息 / 出错位置 / 堆栈」几个相邻 div：逐段取再用空格拼，直接取 textContent 会粘成
    // "…MetaMaskchrome-extension://…"，\b 不成立，扩展误报就被当成致命错误整页重载。
    const parts = Array.from(box?.children || []).map((c) => c.textContent?.trim()).filter(Boolean);
    const msg = parts.join(' ') || box?.textContent?.trim() || 'KasmVNC 致命错误';
    // Only suppress a clear extension-origin error while VNC is still connected.
    if (fromExtension(msg) && doc?.documentElement.classList.contains('noVNC_connected')) {
      dismiss(el, box);
      onExtension?.();
      return null;
    }
    if (isReconnectGapError(msg, doc)) {
      dismiss(el, box); // noVNC 自带重连正在进行 / 已连回，关掉浮层即可
      onReconnectGap?.();
      return null;
    }
    return msg;
  } catch {
    return null; // iframe navigation / inaccessible document
  }
}
