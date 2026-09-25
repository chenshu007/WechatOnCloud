// 主题：auto（跟随系统）/ light / dark。存浏览器 localStorage，应用到 <html data-theme>。
// 首屏无闪烁由 index.html 里的内联脚本提前置好 data-theme；这里负责读取与切换。
export type ThemeMode = 'auto' | 'light' | 'dark';
const KEY = 'woc_theme';

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    /* 隐私模式禁用 localStorage */
  }
  return 'auto';
}

export function applyThemeMode(m: ThemeMode): void {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = m;
}

// 循环切换顺序：跟随系统 → 亮色 → 深色 → 跟随系统
export function nextThemeMode(m: ThemeMode): ThemeMode {
  return m === 'auto' ? 'light' : m === 'light' ? 'dark' : 'auto';
}
