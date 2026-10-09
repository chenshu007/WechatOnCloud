import type { ClientRequest } from 'node:http';
import type { EventEmitter } from 'node:events';

// KasmVNC 卡死识别（移植自上游 cf69355）：静态页照常能出，但 websocket 升级永远等不到 101，noVNC 一直停在
// 「连接中」；或实例服务整体 stall，连 noVNC 页面都返回不了。周期探测看不到前一种，这里改看真实用户请求：
// 上游 hangMs 内既没回 101、也没回任何响应就断开这次请求并记一次无应答；windowMs 内累计 hangs 次、
// 容器已运行满 minUptimeSec、cooldownMs 内没自愈过，才沿用当前镜像重启实例。
// 实例刚起时上游是立刻拒绝（502 / ECONNREFUSED），属于快速失败，不计数，预热期不会误判。
export const UPSTREAM_HANG_MS = 25_000;

export interface StuckHealOptions {
  enabled: boolean;
  uptimeSec: (instId: string) => Promise<number | null>;
  heal: (instId: string) => Promise<void>;
  log: (instId: string, msg: string, level?: 'INFO' | 'WARN' | 'ERROR') => void;
  hangs?: number;
  windowMs?: number;
  minUptimeSec?: number;
  cooldownMs?: number;
  now?: () => number;
}

export function createStuckHealer(o: StuckHealOptions) {
  const need = o.hangs ?? 2;
  const windowMs = o.windowMs ?? 10 * 60_000;
  const minUptime = o.minUptimeSec ?? 180;
  const cooldownMs = o.cooldownMs ?? 15 * 60_000;
  const now = o.now ?? Date.now;
  const recent = new Map<string, number[]>();
  const lastHeal = new Map<string, number>();
  const healing = new Set<string>();

  // 记一次无应答；返回是否触发了自愈（便于测试）。
  async function onHang(instId: string, what: string): Promise<boolean> {
    const t = now();
    const hangs = (recent.get(instId) || []).filter((x) => t - x < windowMs);
    hangs.push(t);
    recent.set(instId, hangs);
    o.log(instId, `[vnc] 实例 ${UPSTREAM_HANG_MS / 1000}s 未应答${what}，已断开本次请求（近 ${windowMs / 60_000} 分钟第 ${hangs.length} 次）`);
    if (!o.enabled || hangs.length < need || healing.has(instId)) return false;
    if (t - (lastHeal.get(instId) ?? -Infinity) < cooldownMs) return false;
    const up = await o.uptimeSec(instId);
    if (up === null || up < minUptime) return false; // 没在跑，或刚启动还在预热
    healing.add(instId);
    lastHeal.set(instId, t);
    recent.delete(instId);
    o.log(instId, `[vnc] 桌面连接 ${windowMs / 60_000} 分钟内 ${hangs.length} 次无应答（KasmVNC 卡死），自动重启实例（数据保留）`, 'WARN');
    try {
      await o.heal(instId);
    } catch (e: any) {
      o.log(instId, `[vnc] 卡死自愈重启失败：${e?.message || e}`, 'ERROR');
    } finally {
      healing.delete(instId);
    }
    return true;
  }

  // 盯住一次转发到实例的请求：超时仍无任何响应 → 断开并记一次无应答。closeClient 用于 ws（让客户端别干等）。
  function watch(proxyReq: ClientRequest, instId: string, what: string, done: EventEmitter, closeClient?: () => void) {
    const timer = setTimeout(() => {
      proxyReq.destroy(); // → http-proxy 的 error：页面请求回「自动重连」页
      closeClient?.();
      void onHang(instId, what);
    }, UPSTREAM_HANG_MS);
    const clear = () => clearTimeout(timer);
    proxyReq.once('response', clear);
    proxyReq.once('upgrade', clear);
    proxyReq.once('error', clear);
    done.once('close', clear); // 客户端先走了（关页 / 自行放弃）
  }

  return { onHang, watch };
}
