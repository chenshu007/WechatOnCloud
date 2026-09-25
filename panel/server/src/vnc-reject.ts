// Bounded, fixed-reason logging. Never log raw URLs, cookies or header values.
export type VncRejectReason = 'HOST_NOT_ALLOWED' | 'INVALID_URL' | 'COOKIE_MISSING' |
  'SESSION_INVALID' | 'USER_MISSING' | 'USER_DISABLED' | 'ACCESS_DENIED';

export function createVncRejectLimiter(maxEntries = 200, intervalMs = 60_000) {
  const seen = new Map<string, number>();
  return (id: string, reason: VncRejectReason, now = Date.now()): boolean => {
    const key = `${id}|${reason}`;
    const last = seen.get(key);
    if (last !== undefined && now - last < intervalMs) return false;
    seen.delete(key);
    while (seen.size >= maxEntries) seen.delete(seen.keys().next().value!);
    seen.set(key, now);
    return true;
  };
}
