const EXTENSION_SOURCE = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//i;

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
    const msg = doc?.getElementById('noVNC_fallback_errormsg')?.textContent?.trim() || 'KasmVNC 致命错误';
    // Only suppress a clear extension-origin error while VNC is still connected.
    // A later extension frame must not hide an earlier noVNC/KasmVNC failure.
    const firstSource = msg.match(/\b(?:https?|chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension):\/\/[^\s)]+/i)?.[0];
    if (firstSource && EXTENSION_SOURCE.test(firstSource) && doc?.documentElement.classList.contains('noVNC_connected')) {
      el.classList.remove('noVNC_open');
      onExtension?.();
      return null;
    }
    if (isReconnectGapError(msg, doc)) {
      el.classList.remove('noVNC_open'); // noVNC 自带重连正在进行 / 已连回，关掉浮层即可
      onReconnectGap?.();
      return null;
    }
    return msg;
  } catch {
    return null; // iframe navigation / inaccessible document
  }
}
