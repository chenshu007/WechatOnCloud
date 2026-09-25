const EXTENSION_SOURCE = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//i;

export function fatalErrorMsg(doc: Document | null | undefined, onExtension?: () => void): string | null {
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
    return msg;
  } catch {
    return null; // iframe navigation / inaccessible document
  }
}
