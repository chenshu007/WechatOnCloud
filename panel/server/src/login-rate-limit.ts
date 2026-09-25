// Process-local, fixed-window failure budgets. Never trust forwarded headers.
const WINDOW_MS = 15 * 60 * 1000;
type Counter = { failures: number; resetAt: number };
type Bucket = Counter & { users: Map<string, Counter> };

export function createLoginRateLimiter(maxIps = 2048) {
  const ips = new Map<string, Bucket>();
  const userKey = (username: string) => username.toLowerCase(); // same as findByUsername
  const sweep = (now: number) => {
    for (const [ip, bucket] of ips) {
      for (const [key, user] of bucket.users) if (user.resetAt <= now) bucket.users.delete(key);
      if (bucket.resetAt <= now) {
        bucket.failures = 0;
        bucket.resetAt = 0;
        if (!bucket.users.size) ips.delete(ip);
      }
    }
  };
  return {
    check(ip: string, username: string, now = Date.now()): number {
      sweep(now);
      const bucket = ips.get(ip);
      if (!bucket && ips.size >= maxIps) {
        // Do not evict live budgets: rotating source addresses must not erase them.
        const nextExpiry = Math.min(...Array.from(ips.values(), b => Math.max(b.resetAt, ...Array.from(b.users.values(), u => u.resetAt))));
        return Math.max(1, Math.ceil((nextExpiry - now) / 1000));
      }
      const user = bucket?.users.get(userKey(username));
      const until = Math.max(
        bucket && bucket.failures >= 20 ? bucket.resetAt : 0,
        user && user.failures >= 5 && user.resetAt > now ? user.resetAt : 0,
      );
      return until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : 0;
    },
    fail(ip: string, username: string, now = Date.now()) {
      sweep(now);
      let bucket = ips.get(ip);
      if (!bucket) {
        if (ips.size >= maxIps) return;
        bucket = { failures: 0, resetAt: now + WINDOW_MS, users: new Map() };
        ips.set(ip, bucket);
      }
      if (bucket.failures >= 20) return;
      if (!bucket.resetAt) bucket.resetAt = now + WINDOW_MS;
      const key = userKey(username);
      let user = bucket.users.get(key);
      if (!user || user.resetAt <= now) {
        user = { failures: 0, resetAt: now + WINDOW_MS };
        bucket.users.set(key, user);
      }
      bucket.failures++;
      user.failures++;
    },
    success(ip: string, username: string) {
      // Shared proxy clients keep their aggregate budget; clear only this account.
      ips.get(ip)?.users.delete(userKey(username));
    },
    size() { return ips.size; },
  };
}
