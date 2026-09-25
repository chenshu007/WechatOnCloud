const KEY = 'woc_access_reauth_state';
const MESSAGE = '访问会话已失效，正在重新验证…';
const WINDOW_MS = 60_000;
const COOLDOWN_MS = 8_000;
const MAX_ATTEMPTS = 2;
type State = { attempts: number; lastAttemptAt: number };

export interface GatewayEnvironment {
  fetch: typeof fetch;
  now: () => number;
  url: () => string;
  online: () => boolean;
  visible: () => boolean;
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  remove: (key: string) => void;
  navigate: (url: string) => void;
  replaceUrl: (url: string) => void;
}

export function createGatewayFetch(env: GatewayEnvironment) {
  let memory: State = { attempts: 0, lastAttemptAt: 0 };
  let navigating = false;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const current = new URL(env.url());
    const target = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, current.origin);
    const api = target.origin === current.origin && target.pathname.startsWith('/api/');
    // No retry: in particular, never replay an upload, text input or other POST.
    const response = await env.fetch(input, api ? { ...init, redirect: 'manual' } : init);
    if (api && response.type === 'opaqueredirect') {
      if (!navigating && env.online() && env.visible()) {
        const now = env.now();
        let storageAvailable = true;
        let state = memory;
        try {
          const raw = env.read(KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Number.isFinite(parsed.attempts) && Number.isFinite(parsed.lastAttemptAt)) state = parsed;
          }
        } catch { storageAvailable = false; }
        if (now - state.lastAttemptAt > WINDOW_MS) state = { attempts: 0, lastAttemptAt: 0 };
        // URL marker survives navigation when sessionStorage is unavailable.
        const unsafeRepeat = !storageAvailable && current.searchParams.has('woc_access_reauth');
        if (!unsafeRepeat && state.attempts < MAX_ATTEMPTS && (!state.lastAttemptAt || now - state.lastAttemptAt >= COOLDOWN_MS)) {
          memory = { attempts: state.attempts + 1, lastAttemptAt: now };
          try { env.write(KEY, JSON.stringify(memory)); }
          catch { if (current.searchParams.has('woc_access_reauth')) throw new Error(MESSAGE); }
          navigating = true;
          current.searchParams.set('woc_access_reauth', String(now));
          env.navigate(current.toString());
        }
      }
      throw new Error(MESSAGE);
    }
    // Clear only after a successful panel JSON response, not a redirect, HTML
    // gateway page, 401/403/5xx, or a late response during navigation.
    if (api && !navigating && response.ok && response.headers.get('content-type')?.includes('application/json')) {
      memory = { attempts: 0, lastAttemptAt: 0 };
      try { env.remove(KEY); } catch { /* memory and URL remain usable */ }
      if (current.searchParams.has('woc_access_reauth')) {
        current.searchParams.delete('woc_access_reauth');
        env.replaceUrl(current.toString());
      }
    }
    return response;
  };
}
