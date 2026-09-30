// A keyboard gesture authorizes one paste only. Native paste also works on LAN
// HTTP. HTTPS can read images directly when focus is on the VNC canvas.
export function installImagePasteBridge(win: Window, doc: Document, top: Window, handlers: {
  image(file: File): Promise<void>; plain(): Promise<void>; error(message: string): void;
}) {
  let alive = true, busy = false, localFresh = true, generation = 0;
  let last: { type: string; bytes: Uint8Array } | undefined;
  let timer: number | undefined;
  let pending = false, captured = false, request = 0;
  const cancel = () => { if (timer !== undefined) win.clearTimeout(timer); timer = undefined; pending = false; };
  const perform = async (file?: File) => {
    if (!alive) return;
    if (busy) { handlers.error('粘贴正在处理中，请稍后再试'); return; }
    busy = true;
    const epoch = generation;
    try {
      if (file) {
        if (file.size > 64 * 1024 * 1024) throw new Error('图片超过 64 MiB，可通过文件传输入口上传');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!alive || epoch !== generation) return;
        const changed = !!last && (last.type !== file.type || last.bytes.length !== bytes.length || bytes.some((b,i) => b !== last!.bytes[i]));
        last = {type:file.type,bytes};
        if (localFresh || changed) { localFresh = true; await handlers.image(file); return; }
      }
      if (alive && epoch === generation) await handlers.plain();
    } catch (e) { if (alive) handlers.error(e instanceof Error ? e.message : '粘贴结果未知，请检查输入框'); }
    finally { busy = false; }
  };
  // Keep native editing in noVNC's settings/clipboard text fields. Only its
  // keyboard input shim represents keystrokes destined for the remote desktop.
  const localEditor = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !!el && el.id !== 'noVNC_keyboardinput' &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  };
  const isPaste = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v');
  const onKey = (e: KeyboardEvent) => {
    if (!e.isTrusted || e.isComposing || localEditor(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^(c|x)$/i.test(e.key)) { localFresh = false; generation++; return; }
    if (!isPaste(e)) return;
    e.stopImmediatePropagation(); // Keep browser default so it emits paste.
    if (e.repeat || busy) { e.preventDefault(); if (busy) handlers.error('粘贴正在处理中，请稍后再试'); return; }
    cancel(); captured = true; pending = true;
    const turn = ++request;
    // Focus the native input shim before the browser performs its default paste.
    doc.getElementById?.('noVNC_keyboardinput')?.focus({ preventScroll: true });
    // Start read synchronously inside the trusted gesture. Native paste and read
    // race for the same request; only one is allowed to dispatch an image.
    if (localFresh && win.navigator?.clipboard?.read) {
      try {
        const read = win.navigator.clipboard.read();
        void read.then(async items => {
          const item = items.find(i => i.types.includes('image/png'));
          if (!item) return;
          const blob = await item.getType('image/png');
          if (!alive || !pending || request !== turn) return;
          cancel();
          void perform(new File([blob], 'clipboard.png', {type:'image/png'}));
        }).catch(() => { /* Native paste remains available if permission is denied. */ });
      } catch { /* HTTP or browser restrictions: wait for the native paste. */ }
    }
    timer = win.setTimeout(() => {
      pending = false; timer = undefined;
      if (!localFresh) void perform();
      else handlers.error('未读取到本机剪贴板，请点击“粘贴图片”或在粘贴框内按 Ctrl+V；未执行远端粘贴');
    }, 1500);
  };
  const onKeyUp = (e: KeyboardEvent) => { if (captured && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')) e.stopImmediatePropagation(); };
  const onPaste = (e: ClipboardEvent) => {
    if (!e.isTrusted || localEditor(e.target)) return;
    const wasPending = pending;
    if (captured) { e.preventDefault(); e.stopImmediatePropagation(); if (!wasPending) return; cancel(); }
    const item = Array.from(e.clipboardData?.items || []).find(i => i.kind === 'file' && i.type.startsWith('image/'));
    const file = item?.getAsFile() || undefined;
    if (!wasPending && !file) return;
    e.preventDefault(); e.stopImmediatePropagation();
    void perform(file);
  };
  // A mouse gesture starts a new context-menu operation; right-click alone is
  // not evidence of a copy, but prevents blindly preferring an old local image.
  const onMouse = (e: MouseEvent) => { if (e.button === 2) { localFresh = false; generation++; } cancel(); captured = false; };
  const onBlur = () => { cancel(); captured = false; generation++; };
  const onFocus = () => { localFresh = true; };
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('keyup', onKeyUp, true);
  doc.addEventListener('paste', onPaste, true);
  win.addEventListener('mousedown', onMouse, true);
  win.addEventListener('blur', onBlur);
  top.addEventListener('focus', onFocus);
  return () => {
    alive = false; generation++; cancel(); last = undefined;
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('keyup', onKeyUp, true);
    doc.removeEventListener('paste', onPaste, true);
    win.removeEventListener('mousedown', onMouse, true);
    win.removeEventListener('blur', onBlur);
    top.removeEventListener('focus', onFocus);
  };
}
