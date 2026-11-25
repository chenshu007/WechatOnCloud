import type { ClientRequest } from 'node:http';
import type { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

// KasmVNC 卡死识别（移植自上游 cf69355 + 2e1ea60）：
// 1. 上游 hangMs 内既没回 101、也没回任何响应，或 101 升级后 hangMs 内无任何 RFB 数据 → 断开并计一次无应答；
//    windowMs 内累计 hangs 次、容器已运行满 minUptimeSec、cooldownMs 内没自愈过，沿用当前镜像重启实例。
// 2. 运行满 minUptimeSec 后，downWindowMs 内累计 downFails 次 /websockify 5xx / ECONNREFUSED（Xvnc 未监听）→ 自愈重启。
export const UPSTREAM_HANG_MS = 25_000;

export interface StuckHealOptions {
  enabled: boolean;
  uptimeSec: (instId: string) => Promise<number | null>;
  heal: (instId: string) => Promise<void>;
  log: (instId: string, msg: string, level?: 'INFO' | 'WARN' | 'ERROR') => void;
  hangs?: number;
  windowMs?: number;
  downFails?: number;
  downWindowMs?: number;
  minUptimeSec?: number;
  cooldownMs?: number;
  now?: () => number;
}

export function createStuckHealer(o: StuckHealOptions) {
  const need = o.hangs ?? 2;
  const windowMs = o.windowMs ?? 10 * 60_000;
  const downNeed = o.downFails ?? 4;
  const downWindowMs = o.downWindowMs ?? 3 * 60_000;
  const minUptime = o.minUptimeSec ?? 180;
  const cooldownMs = o.cooldownMs ?? 15 * 60_000;
  const now = o.now ?? Date.now;
  const recent = new Map<string, number[]>();
  const recentDown = new Map<string, number[]>();
  const lastHeal = new Map<string, number>();
  const healing = new Set<string>();

  async function tryHeal(instId: string, detail: string): Promise<boolean> {
    const t = now();
    if (!o.enabled || healing.has(instId)) return false;
    if (t - (lastHeal.get(instId) ?? -Infinity) < cooldownMs) return false;
    const up = await o.uptimeSec(instId);
    if (up === null || up < minUptime) return false; // 没在跑，或刚启动还在预热
    if (healing.has(instId)) return false;
    healing.add(instId);
    lastHeal.set(instId, t);
    o.log(instId, `[vnc] ${detail}`, 'WARN');
    try {
      await o.heal(instId);
    } catch (e: any) {
      o.log(instId, `[vnc] 卡死自愈重启失败：${e?.message || e}`, 'ERROR');
    } finally {
      healing.delete(instId);
    }
    return true;
  }

  // 记一次无应答；返回是否触发了自愈（便于测试）。
  async function onHang(instId: string, what: string): Promise<boolean> {
    const t = now();
    const hangs = (recent.get(instId) || []).filter((x) => t - x < windowMs);
    hangs.push(t);
    recent.set(instId, hangs);
    o.log(instId, `[vnc] 实例 ${UPSTREAM_HANG_MS / 1000}s 未应答${what}，已断开本次请求（近 ${windowMs / 60_000} 分钟第 ${hangs.length} 次）`);
    if (hangs.length < need) return false;
    const healed = await tryHeal(
      instId,
      `桌面连接 ${windowMs / 60_000} 分钟内 ${hangs.length} 次无应答（KasmVNC 卡死），自动重启实例（数据保留）`,
    );
    if (healed) recent.delete(instId);
    return healed;
  }

  // 记一次桌面服务快速失败（/websockify 5xx / ECONNREFUSED）；容器运行满预热期且短时累计多次则自愈。
  async function onDown(instId: string, why: string): Promise<boolean> {
    const t = now();
    const downs = (recentDown.get(instId) || []).filter((x) => t - x < downWindowMs);
    downs.push(t);
    recentDown.set(instId, downs);
    o.log(instId, `[vnc] 桌面服务不可达（${why}，近 ${downWindowMs / 60_000} 分钟第 ${downs.length} 次）`);
    if (downs.length < downNeed) return false;
    const healed = await tryHeal(
      instId,
      `桌面连接 ${downWindowMs / 60_000} 分钟内 ${downs.length} 次失败（${why}），自动重启实例（数据保留）`,
    );
    if (healed) recentDown.delete(instId);
    return healed;
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

  // 升级成功后 KasmVNC 会立刻发来 RFB 版本号；若 101 后主循环卡死无任何数据，同样按无应答断开并计数。
  function watchGreeting(proxySocket: Socket, clientSocket: Socket, instId: string) {
    const timer = setTimeout(() => {
      proxySocket.destroy();
      clientSocket.destroy();
      void onHang(instId, '桌面连接（升级后没有任何数据）');
    }, UPSTREAM_HANG_MS);
    const clear = () => clearTimeout(timer);
    proxySocket.once('data', clear);
    proxySocket.once('close', clear);
    clientSocket.once('close', clear);
  }

  return { onHang, onDown, watch, watchGreeting };
}
