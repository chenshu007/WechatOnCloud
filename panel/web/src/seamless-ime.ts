// 「无感输入」钩子：装进同源 iframe，让用户直接在微信里打中文。
// - compositionend（中文提交）→ 经 xclip+xdotool 转发（绕开 VNC keysym 容量上限）。
// - 转发未完成期间（队列活跃），把后续可见字符 + 回车/退格也串进同一队列按序送出 →
//   彻底消除"中文走异步、数字走 keysym 抢跑"导致的"你好123→23"丢字。
// - 队列空闲时不干预：英文/数字仍走原生 keysym，零延迟。
// 返回清理函数（切回转发模式 / 重连 / 卸载时移除监听）。
export interface ImeSender {
  text: (text: string) => Promise<unknown>; // 经 xclip + Ctrl+V 转发到应用（/type，单次 ≤ 500 字）
  key: (key: string) => Promise<unknown>; // 单个按键（/key）
}

export function installSeamlessIme(
  win: Window,
  doc: Document,
  send: ImeSender,
  onFail: (err: any) => void,
): () => void {
  type Job = { kind: 'text'; data: string } | { kind: 'key'; data: string };
  const queue: Job[] = [];
  let draining = false;
  const active = () => draining || queue.length > 0;
  // /type 单次上限 500 字（语音输入、长句提交可能超过），按段入队，免得整段被拒后丢失
  const pushText = (data: string) => {
    for (let i = 0; i < data.length; i += 500) queue.push({ kind: 'text', data: data.slice(i, i + 500) });
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const job = queue[0];
      try {
        if (job.kind === 'text') await send.text(job.data);
        else await send.key(job.data);
      } catch (e) {
        onFail(e); // 单条失败丢弃、继续后续，避免卡住队列；但要让用户知道刚打的字没发出去
      }
      queue.shift();
    }
    draining = false;
  };

  // 隐藏输入框瘦身：IME 模式下 noVNC 从不清空 noVNC_keyboardinput，每次上屏的字都追加在里面，用得越久越长；
  // 实测 5 千字时每次合成 ~30ms、8 万字 ~100ms，打字越来越卡（「用着用着」）。noVNC 自己只在「非合成的输入且超过
  // 200 字」时重置（_keyboardInputReset，连同内部差分基准一起清）。上屏后若已超长，补发一个内容不变的 input 事件
  // 走它这条路：内容与基准相同、差分为空，不会给应用发任何按键，只触发重置。
  let composing = false;
  const trimKeyboardInput = () => {
    const ki = doc.getElementById('noVNC_keyboardinput') as HTMLTextAreaElement | null;
    if (composing || !ki || ki.value.length <= 200) return;
    ki.dispatchEvent(new (win as any).Event('input', { bubbles: true }));
  };
  const onCompositionStart = () => {
    composing = true;
  };

  const onCompositionEnd = (e: Event) => {
    composing = false;
    win.setTimeout(trimKeyboardInput, 0); // 等 noVNC 同步完差分基准（它在目标阶段处理 compositionend）
    const txt = (e as CompositionEvent).data;
    if (!txt) return;
    pushText(txt);
    drain();
  };

  // 捕获阶段（iframe window 最外层）抢先拦截，赶在 noVNC 之前 → stopImmediatePropagation 阻止它发 keysym。
  // 关键：队列活跃（有中文正在转发）时，只接管【数字】、空格和回车/退格——它们不参与拼音合成、且是原"混数字丢字"的祸首；
  // 字母绝不接管，否则会把下一个词的拼音首字母（如"呀"的 y）当成字面字符抢走，造成"你好y呀"。字母交给输入法合成。
  const onKeyDownCapture = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.isComposing) return; // 拼音合成中，交给输入法（候选数字选词也在此放行）
    if (e.ctrlKey || e.altKey || e.metaKey) return; // 快捷键放行
    if (!active()) return; // 没有中文在转发 → 不接管（英文/数字走原生 keysym，零延迟）
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.push({ kind: 'text', data: e.key });
      drain();
    } else if (e.key === ' ' && e.keyCode !== 229 && !e.shiftKey) {
      // 拼音上屏后紧接着按空格（issue #155「连点空格，空格出现在文字之前」）：上屏那一下空格在合成中、已放行，
      // 下一下不在合成中，KasmVNC 只把 keyCode 229 和数字键当输入法交互，空格会立刻按 keysym 直发、抢在还在走
      // HTTP 转发的中文前面。229 = 输入法自己处理了这个键（如全角空格），成品走 beforeinput，那边会按序接管。
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.push({ kind: 'text', data: ' ' });
      drain();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.push({ kind: 'key', data: 'Return' });
      drain();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.push({ kind: 'key', data: 'BackSpace' });
      drain();
    }
    // 其它非可见键（方向键/功能键等）放行
  };

  // 不经合成、直接插进输入框的文字：不少输入法的全角标点（，。？）、系统表情面板、语音输入都这样进来。
  // noVNC 对它们走「输入框差分 → 逐字 keysym」：非 ASCII 字符要临时映射键码，实测会丢；keysym 又经 websocket 直达，
  // 会抢在走 HTTP 转发的中文前面（实测依次输入「你好」「，」「世界」「。」，远端收到「。你好世界」）。
  // 在插入前截下，与中文走同一个有序队列。ASCII 只在队列忙时接管（保证顺序），空闲时照旧走 keysym，零延迟。
  const onBeforeInput = (ev: Event) => {
    const e = ev as InputEvent;
    if (e.isComposing || composing) return; // 合成中的文字在 compositionend 统一转发
    if (e.inputType !== 'insertText' && e.inputType !== 'insertReplacementText') return;
    if (e.target !== doc.getElementById('noVNC_keyboardinput')) return;
    const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    if (!data || (/^[\x20-\x7e]*$/.test(data) && !active())) return;
    e.preventDefault(); // 不插入输入框：noVNC 不会再按 keysym 发一遍，它的差分基准也保持一致
    pushText(data);
    drain();
  };

  // 焦点守卫：本机输入法只在焦点落在可编辑元素上时才启用，无感模式靠的是 KasmVNC 的隐藏输入框 noVNC_keyboardinput。
  // KasmVNC 在 iframe 里不拦 canvas 上 mousedown 的默认聚焦（它只在顶层页面才 preventDefault），平时靠「输入框正有焦点时
  // 拦下 mousedown」保住焦点；可输入框一旦因任何原因失焦，下一次点画面焦点就会落到 canvas 上——canvas 不可编辑，
  // 浏览器随即停用输入法（候选框消失、只能打英文），而且之后每次点击都会重演、再也回不到输入框，只能刷新页面。
  // 故焦点一落到 canvas 就交还给输入框（IME 模式下 noVNC 自己聚焦的也正是它，键盘监听两处都挂着，不影响按键）。
  // 只在 KasmVNC 的 IME 模式确实开着时这么做：万一它没开（enable_ime 与本页模式不一致），输入框上的中文会被
  // noVNC 按 keysym 再发一遍，与这里的转发重复。
  const onFocusIn = (ev: Event) => {
    if ((ev.target as Element | null)?.tagName !== 'CANVAS') return;
    const imeSetting = doc.getElementById('noVNC_setting_enable_ime') as HTMLInputElement | null;
    if (imeSetting && !imeSetting.checked) return;
    const ki = doc.getElementById('noVNC_keyboardinput') as HTMLTextAreaElement | null;
    if (ki && doc.activeElement !== ki) ki.focus({ preventScroll: true });
  };

  // 候选框跟着点击位置走（issue #131「中文输入法显示框在对话中间」）：本机输入法的候选框贴着隐藏输入框的光标弹出，
  // 而 KasmVNC 把它固定在画面 35%/40% 处，无论点的是哪儿，候选框都飘在对话中间。点画面时把它挪到点击处——
  // 用户点的通常就是应用的输入框，候选框随之出现在输入框旁边。1×1 透明、在画面下层，挪动不影响显示与点击。
  const onMouseDown = (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.tagName !== 'CANVAS') return;
    const ki = doc.getElementById('noVNC_keyboardinput') as HTMLTextAreaElement | null;
    const box = ki?.offsetParent?.getBoundingClientRect();
    if (!ki || !box || !box.width || !box.height) return;
    const x = Math.min(Math.max(ev.clientX - box.left, 0), box.width - 2);
    const y = Math.min(Math.max(ev.clientY - box.top, 0), box.height - 2);
    ki.style.left = `${Math.round(x)}px`;
    ki.style.top = `${Math.round(y)}px`;
  };

  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);
  doc.addEventListener('beforeinput', onBeforeInput, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  win.addEventListener('keydown', onKeyDownCapture, true);
  return () => {
    doc.removeEventListener('compositionstart', onCompositionStart, true);
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    doc.removeEventListener('beforeinput', onBeforeInput, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('mousedown', onMouseDown, true);
    win.removeEventListener('keydown', onKeyDownCapture, true);
  };
}
