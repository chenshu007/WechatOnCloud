import { createGatewayFetch } from './gateway-fetch';
export interface PanelUser {
  id: string;
  username: string;
  role: 'admin' | 'sub';
  disabled: boolean;
  createdAt: string;
  allowedInstances: string[]; // admin 为空数组（隐式全部）
  mustChangePassword?: boolean; // 仍在用默认密码时为 true
}

export type WechatPhase = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';
export interface WechatStatus {
  phase: WechatPhase;
  percent: number; // -1 表示进度不确定
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

export type RuntimeState = 'running' | 'stopped' | 'missing';
export type AppType = 'wechat' | 'telegram' | 'custom';
export type StoredAppType = AppType | 'chromium'; // 只用于展示旧记录，不可创建
export const APP_LABELS: Record<AppType, string> = {
  wechat: '微信',
  telegram: 'Telegram',
  custom: '自定义应用',
};

// 各应用的 UI 画像，供卡片/桌面页按类型显示正确文案（避免到处写死「微信」）。
//   needsInstall: 是否需要运行时下载安装（微信/Telegram 是）。
//   enterHint:    首次进入实例的提示。
//   updateLabel:  「管理」菜单里的更新按钮文案（needsInstall=false 时不显示）。
export interface AppProfile {
  label: string;
  needsInstall: boolean;
  enterHint: string;
  updateLabel: string;
}
export const APP_PROFILES: Record<StoredAppType, AppProfile> = {
  wechat: { label: '微信', needsInstall: true, enterHint: '首次进入请扫码登录微信', updateLabel: '更新微信' },
  telegram: { label: 'Telegram', needsInstall: true, enterHint: '首次进入请登录 Telegram', updateLabel: '更新 Telegram' },
  chromium: { label: '已停用的浏览器实例', needsInstall: false, enterHint: '浏览器功能已移除，原数据卷仍保留，可在管理页导出或删除', updateLabel: '' },
  custom: { label: '自定义应用', needsInstall: true, enterHint: '', updateLabel: '更新' },
};
export const appProfile = (t?: StoredAppType): AppProfile => APP_PROFILES[t ?? 'wechat'] ?? APP_PROFILES.wechat;
export interface PanelInstance {
  id: string;
  name: string;
  appType?: StoredAppType; // 缺省（老实例）= wechat
  icon?: string; // 自定义图标：data: 图片 / builtin:<key>；缺省按 appType 取默认图标
  createdAt: string;
  createdBy: string;
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}
export interface MemLimits {
  soft: number | null;
  hard: number | null;
  defaultSoft: number;
  defaultHard: number;
  currentMB: number;
  watchdogEnabled: boolean;
  intervalSec: number;
}
export interface InstanceWithStatus extends PanelInstance {
  runtime: RuntimeState;
  wechat: WechatStatus;
}

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number; // epoch ms
}

export interface VersionInfo {
  current: string; // 当前构建版本（如 v1.2.0 / dev-<sha>）
  revision: string | null; // 构建对应的 Git SHA（旧镜像可能为 null）
  latest: string | null; // 仓库上最新发布版（如 v1.2.1）；查不到为 null
  hasUpdate: boolean; // 有可升级目标（正式版：latest>current；开发版：查到任一正式版）
  isDev: boolean; // 当前是开发版（非正式 vX.Y.Z）
  checkedAt: number; // 上次检查时间戳（ms）；0=尚未检查
  source: string | null; // 数据来源：dockerhub / ghcr / dockerhub+ghcr
  error: string | null; // 检查失败原因
}

const apiFetch = createGatewayFetch({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  url: () => window.location.href,
  online: () => navigator.onLine,
  visible: () => document.visibilityState !== 'hidden',
  read: (key) => sessionStorage.getItem(key),
  write: (key, value) => sessionStorage.setItem(key, value),
  remove: (key) => sessionStorage.removeItem(key),
  navigate: (url) => window.location.replace(url),
  replaceUrl: (url) => window.history.replaceState(window.history.state, '', url),
});

// ---------- 大文件上传 ----------
// 与服务端 index.ts 的 UPLOAD_LIMIT_* 一致。前端先比一下：超限时服务端会直接回 413 并断开连接，
// 浏览器此时往往只报「网络错误」，看不到原因。
const GB = 1024 ** 3;
export const UPLOAD_LIMITS = { transfer: 4 * GB, volumeFile: 20 * GB, archive: 100 * GB };
export function assertUploadSize(file: Blob, limit: number) {
  if (file.size > limit) throw new Error(`文件太大（${fmtUploadSize(file.size)}，上限 ${fmtUploadSize(limit)}）`);
}
export function fmtUploadSize(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
export type UploadProgress = (loaded: number, total: number) => void;

function uploadHttpError(status: number): string {
  if (status === 413) return '文件太大：超过了上传上限，或反向代理限制了上传大小（nginx 需调大 client_max_body_size）';
  if (status === 502 || status === 504) return `上传失败（HTTP ${status}）：反向代理超时，或面板正在重启`;
  return `上传失败（HTTP ${status}）`;
}

// 原始二进制上传（File 直传 application/octet-stream），带上传进度（fetch 拿不到上传进度，这里用 XHR）
async function rawUpload(url: string, file: Blob, onProgress?: UploadProgress): Promise<any> {
  // 先发个普通请求探路：登录已失效、或反代身份网关要重新认证（apiFetch 会整页重载去认证）时，在这里就拦下，
  // 不至于几个 GB 传完才发现被挡在门外
  const probe = await apiFetch('/api/auth/me', { credentials: 'same-origin' });
  if (probe.status === 401) {
    location.assign('/login');
    throw new Error('登录已失效，请重新登录');
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText || 'null');
      } catch {
        /* 反代的错误页不是 JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        // 2xx 却不是面板的回应（被网关换成了登录页之类）：不能当成功
        if (data && data.ok) resolve(data);
        else reject(new Error('上传结果未知（收到的不是面板的响应），请刷新页面后检查'));
        return;
      }
      reject(new Error(data?.error || uploadHttpError(xhr.status)));
    };
    xhr.onerror = () => reject(new Error('上传失败：连接中断（网络断开，或反向代理限制了上传大小 / 时长）'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(file);
  });
}

// 解压 / 整卷恢复在服务端是后台任务：上传完拿到任务号，轮询到结束
async function waitVolumeJob(id: string, job: string, onStage?: (stage: string) => void): Promise<void> {
  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    let st: { state: 'running' | 'done' | 'error'; stage: string; error: string | null };
    try {
      st = await req(`/api/admin/instances/${id}/volume/jobs/${job}`);
      misses = 0;
    } catch (e: any) {
      const msg = e?.message || '';
      if (/任务不存在/.test(msg)) throw new Error('任务状态丢失（面板可能重启过），请检查数据后决定是否重试');
      if (++misses > 60) throw new Error(`查询进度失败：${msg}`); // 网络抖动 / 面板重启中：多等一会儿
      continue;
    }
    onStage?.(st.stage);
    if (st.state === 'done') return;
    if (st.state === 'error') throw new Error(st.error || '操作失败');
  }
}

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  // 仅在有 body 时声明 JSON content-type：否则 Fastify 对「空 body + application/json」会报 400
  const headers = opts.body ? { 'content-type': 'application/json', ...opts.headers } : opts.headers;
  const res = await apiFetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 会话过期：除登录/探测接口外，任意接口收到 401 都说明 cookie 失效，直接回登录页（避免页面卡在错误态）
    const isAuthProbe = path.includes('/api/auth/login') || path.includes('/api/auth/me');
    if (res.status === 401 && !isAuthProbe && location.pathname !== '/login') {
      location.assign('/login');
    }
    throw new Error((data as any).error || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const api = {
  me: () => req<{ user: PanelUser }>('/api/auth/me'),
  login: (username: string, password: string) =>
    req<{ user: PanelUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  changePassword: (oldPassword: string, newPassword: string) =>
    req('/api/account/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) }),

  // 版本与更新检测
  getVersion: () => req<VersionInfo>('/api/version'),

  // 子账号
  listUsers: () => req<{ users: PanelUser[] }>('/api/admin/users'),
  createUser: (username: string, password: string, allowedInstances: string[] = []) =>
    req<{ user: PanelUser }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, allowedInstances }),
    }),
  setDisabled: (id: string, disabled: boolean) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/disable`, { method: 'POST', body: JSON.stringify({ disabled }) }),
  resetUser: (id: string, newPassword: string) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/reset`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
  renameUser: (id: string, username: string) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/rename`, { method: 'POST', body: JSON.stringify({ username }) }),
  deleteUser: (id: string) => req(`/api/admin/users/${id}`, { method: 'DELETE' }),
  setUserInstances: (id: string, instanceIds: string[]) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/instances`, { method: 'POST', body: JSON.stringify({ instanceIds }) }),

  // 微信实例
  listInstances: () => req<{ instances: InstanceWithStatus[] }>('/api/instances'),
  createInstance: (name: string, allowedUserIds: string[] = [], reuseVolume?: string, appType: AppType = 'wechat') =>
    req<{ instance: PanelInstance }>('/api/admin/instances', {
      method: 'POST',
      body: JSON.stringify({ name, allowedUserIds, reuseVolume: reuseVolume || undefined, appType }),
    }),
  regenMachineId: (id: string) =>
    req(`/api/admin/instances/${id}/regen-machine-id`, { method: 'POST' }),
  getInstanceMemLimits: (id: string) =>
    req<MemLimits>(`/api/admin/instances/${id}/mem-limits`),
  setInstanceMemLimits: (id: string, soft: number | null | undefined, hard: number | null | undefined) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/mem-limits`, {
      method: 'PUT',
      body: JSON.stringify({ soft, hard }),
    }),
  listOrphanVolumes: () =>
    req<{ volumes: { name: string; createdAt?: string; sizeBytes?: number }[] }>('/api/admin/orphan-volumes'),
  deleteOrphanVolume: (name: string) =>
    req(`/api/admin/orphan-volumes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listOrphanContainers: () =>
    req<{ containers: { id: string; name: string; status: string; volumeName?: string }[] }>('/api/admin/orphan-containers'),
  deleteOrphanContainer: (idOrName: string) =>
    req(`/api/admin/orphan-containers/${encodeURIComponent(idOrName)}`, { method: 'DELETE' }),
  setInstanceIcon: (id: string, icon: string | null) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/icon`, { method: 'POST', body: JSON.stringify({ icon }) }),
  renameInstance: (id: string, name: string) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteInstance: (id: string, purge = false) =>
    req(`/api/admin/instances/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' }),
  setInstanceUsers: (id: string, userIds: string[]) =>
    req(`/api/admin/instances/${id}/users`, { method: 'POST', body: JSON.stringify({ userIds }) }),
  instanceWechatStatus: (id: string) => req<{ status: WechatStatus }>(`/api/instances/${id}/wechat/status`),
  // 卡死自愈：VNC 多次重连仍连不上时，重启该实例恢复（限频；需对实例有访问权）。
  healInstance: (id: string) => req<{ ok: boolean; restarted: boolean }>(`/api/instances/${id}/heal`, { method: 'POST' }),
  // 客户端连接日志：把前端的 VNC 连接态/动作回传服务端，记进实例日志（[client] 前缀），便于排查。Fire-and-forget。
  clientLog: (id: string, msg: string) => {
    req(`/api/instances/${id}/clientlog`, { method: 'POST', body: JSON.stringify({ msg }) }).catch(() => {});
  },
  instanceWechatInstall: (id: string) => req(`/api/admin/instances/${id}/wechat/install`, { method: 'POST' }),
  instanceWechatUpdate: (id: string) => req(`/api/admin/instances/${id}/wechat/update`, { method: 'POST' }),
  instanceStart: (id: string) => req(`/api/admin/instances/${id}/start`, { method: 'POST' }),
  instanceStop: (id: string) => req(`/api/admin/instances/${id}/stop`, { method: 'POST' }),
  instanceRestart: (id: string) => req(`/api/admin/instances/${id}/restart`, { method: 'POST' }),
  instanceUpgrade: (id: string) => req(`/api/admin/instances/${id}/upgrade`, { method: 'POST' }),
  instanceLogsUrl: (id: string) => `/api/admin/instances/${id}/logs`,
  // 全局日志 / 诊断包（范围 24h/7d/30d/1y）
  diagnosticsUrl: (range: string) => `/api/admin/diagnostics?range=${encodeURIComponent(range)}`,
  panelLogUrl: (range: string) => `/api/admin/panel-log?range=${encodeURIComponent(range)}`,

  // 文件中转
  listFiles: (id: string) => req<{ files: { name: string; size: number; mtime?: number }[] }>(`/api/instances/${id}/files`),
  uploadFile: async (id: string, file: File, onProgress?: UploadProgress) => {
    assertUploadSize(file, UPLOAD_LIMITS.transfer);
    return rawUpload(`/api/instances/${id}/upload?name=${encodeURIComponent(file.name)}`, file, onProgress);
  },
  clipboardImage: async (id: string): Promise<Blob> => {
    const res = await apiFetch(`/api/instances/${id}/clipboard-image`, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '读取微信图片失败');
    if (!res.headers.get('content-type')?.startsWith('image/png')) throw new Error('图片响应无效，请检查登录状态');
    return res.blob();
  },
  pasteImage: async (id: string, file: File) => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 70000);
    try {
      const res = await apiFetch(`/api/instances/${id}/paste-image?type=${encodeURIComponent(file.type)}`, {
        method: 'POST', credentials: 'same-origin', signal: abort.signal,
        headers: { 'content-type': 'application/octet-stream' }, body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.outcome !== 'dispatched') throw new Error(data.error || '粘贴结果未知，请检查输入框；不会自动重试');
      return data;
    } finally { window.clearTimeout(timer); }
  },
  downloadFileUrl: (id: string, name: string) => `/api/instances/${id}/download?name=${encodeURIComponent(name)}`,
  deleteFile: (id: string, name: string) => req(`/api/instances/${id}/files?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // 数据卷管理（仅管理员）
  volumeList: (id: string, path = '') =>
    req<{ path: string; entries: VolEntry[] }>(`/api/admin/instances/${id}/volume?path=${encodeURIComponent(path)}`),
  volumeMkdir: (id: string, path: string) =>
    req(`/api/admin/instances/${id}/volume/mkdir`, { method: 'POST', body: JSON.stringify({ path }) }),
  volumeMove: (id: string, from: string, to: string) =>
    req(`/api/admin/instances/${id}/volume/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  volumeDelete: (id: string, path: string) =>
    req(`/api/admin/instances/${id}/volume?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  volumeDownloadUrl: (id: string, path: string) =>
    `/api/admin/instances/${id}/volume/download?path=${encodeURIComponent(path)}`,
  volumeBackupUrl: (id: string) => `/api/admin/instances/${id}/volume/backup`,
  volumeUpload: async (id: string, path: string, file: File, onProgress?: UploadProgress) => {
    assertUploadSize(file, UPLOAD_LIMITS.volumeFile);
    return rawUpload(
      `/api/admin/instances/${id}/volume/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`,
      file,
      onProgress,
    );
  },
  // 上传（带进度）→ 服务端校验、写入（后台任务，onStage 报告阶段）
  volumeExtract: async (id: string, path: string, file: File, onProgress?: UploadProgress, onStage?: (s: string) => void) => {
    assertUploadSize(file, UPLOAD_LIMITS.archive);
    const { job } = await rawUpload(`/api/admin/instances/${id}/volume/extract?path=${encodeURIComponent(path)}`, file, onProgress);
    await waitVolumeJob(id, job, onStage);
  },
  volumeRestore: async (id: string, file: File, onProgress?: UploadProgress, onStage?: (s: string) => void) => {
    assertUploadSize(file, UPLOAD_LIMITS.archive);
    const { job } = await rawUpload(`/api/admin/instances/${id}/volume/restore`, file, onProgress);
    await waitVolumeJob(id, job, onStage);
  },

  // 多端协作：操作控制权
  controlStatus: (id: string) => req<{ free: boolean; mine: boolean; holder: string | null }>(`/api/instances/${id}/control`),
  controlBeat: (id: string) => req<{ mine: boolean; holder: string }>(`/api/instances/${id}/control/beat`, { method: 'POST' }),
  controlTake: (id: string) => req<{ mine: boolean; holder: string }>(`/api/instances/${id}/control/take`, { method: 'POST' }),
  typeInInstance: (id: string, text: string) => req(`/api/instances/${id}/type`, { method: 'POST', body: JSON.stringify({ text }) }),
  keyInInstance: (id: string, key: string) => req(`/api/instances/${id}/key`, { method: 'POST', body: JSON.stringify({ key }) }),

  // 桌面壁纸
  listBackgrounds: (id: string) => req<{ backgrounds: string[] }>(`/api/admin/instances/${id}/backgrounds`),
  uploadBackground: async (id: string, name: string, file: File) => {
    const res = await fetch(`/api/admin/instances/${id}/backgrounds?name=${encodeURIComponent(name)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || '上传失败');
    return res.json();
  },
  applyBackground: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/backgrounds/${encodeURIComponent(name)}/apply`, { method: 'POST' }),
  deleteBackground: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/backgrounds/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getCurrentBackground: (id: string) => req<{ background: string }>(`/api/admin/instances/${id}/backgrounds/current`),
  clearBackground: (id: string) => req(`/api/admin/instances/${id}/backgrounds/clear`, { method: 'POST' }),

  // 字体管理
  listFonts: (id: string) => req<{ fonts: string[] }>(`/api/admin/instances/${id}/fonts`),
  uploadFont: async (id: string, name: string, file: File) => {
    const res = await fetch(`/api/admin/instances/${id}/fonts?name=${encodeURIComponent(name)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || '上传失败');
    return res.json();
  },
  deleteFont: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/fonts/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getCurrentFont: (id: string) => req<{ fontFile: string }>(`/api/admin/instances/${id}/fonts/current`),
  applyFont: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/fonts/${encodeURIComponent(name)}/apply`, { method: 'POST' }),
  resetFontDefault: (id: string) =>
    req(`/api/admin/instances/${id}/fonts/default`, { method: 'POST' }),
};
