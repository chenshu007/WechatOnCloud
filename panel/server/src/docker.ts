import { IMAGE_PASTE_SCRIPT, PasteError, validatePasteImage, withInstanceInput } from './image-paste.js';
import { parseTransferFiles } from './transfer-format.js';
import { StringDecoder } from 'node:string_decoder';
import { hostname } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { appendInstanceLog, deleteInstanceLog, appendPanelLog, readInstanceLog, readPanelLog, filterSince } from './logs.js';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import { tarArchive, tarEntry, tarFileStream, tarSingleFile, openTarStream, scanArchive, sniffArchive } from './tar.js';
import { instanceAppType, requireSupportedApp, type Instance } from './store.js';

const WECHAT_IMAGE = process.env.WOC_WECHAT_IMAGE || 'ghcr.io/gloridust/wechat-on-cloud:latest';
const PUID = process.env.PUID || '1000';
const PGID = process.env.PGID || '1000';
const TZ = process.env.TZ || 'Asia/Shanghai';
const SHM_SIZE = 1024 * 1024 * 1024; // 1gb

// 默认关闭 KasmVNC 的 GPU 硬件编码（baseimage 检测到 /dev/dri/renderD* 时会给 Xvnc 加 -hw3d）：
// 在 WSL2 / 虚拟 GPU 环境下该路径会导致 Xvnc 内存持续膨胀（实测反馈 21h 涨到 ~9GB）。
// 我们已设 LIBGL_ALWAYS_SOFTWARE=1 走软件渲染，hw3d 对微信这类静态界面收益甚微。
// 真实可用 GPU 想启用硬件编码：面板侧设 WOC_ENABLE_GPU=1，并让面板可见宿主 /dev/dri
// （如同摄像头，把宿主 /dev 挂到 /host-dev，或设 WOC_DRI_DEVICES 显式指定）。
const ENABLE_GPU = process.env.WOC_ENABLE_GPU === '1';

// 可选：给每个实例容器设内存上限（GiB），作为 Xvnc 等异常增长时的兜底，避免拖垮宿主。
// 默认 0 = 不限制（保持原行为）。命中上限时容器内 OOM 杀进程、由 s6 自动重启 VNC。
const INSTANCE_MEM_GB = Number(process.env.WOC_INSTANCE_MEM_GB) || 0;
const INSTANCE_MEM = INSTANCE_MEM_GB > 0 ? Math.floor(INSTANCE_MEM_GB * 1024 * 1024 * 1024) : 0;

// 设备伪装：把 /etc/os-release 伪装成 deepin（微信官方支持的发行版，且 Deepin 本就基于 Debian，
// 与本镜像的 Debian 用户态一致，不会自相矛盾）。默认开启；设 WOC_SPOOF_OS=0 关闭恢复 Debian。
// 配合 00-woc-identity 钩子里的 machine-id 唯一化 + 真实 hostname，整体让容器更像一台普通 Linux 桌面，
// 降低被腾讯按"非真实设备/设备农场"判风险的概率。注意：尽力而为，非保证；详见 doc/设备伪装.md。
const SPOOF_OS = process.env.WOC_SPOOF_OS !== '0';

// 给实例容器派生一个"像个人电脑"的内部 hostname（替代 woc-wx-<hex> 这种容器/服务器特征）。
// 从 inst.id 稳定派生：同一实例每次重建得到相同名字、不同实例不同。仅作伪装，不参与寻址
// （反代用容器名 containerName，不用此 hostname）。
function realisticHostname(id: string): string {
  const words = ['deepin', 'lenovo', 'thinkpad', 'matebook', 'xiaoxin', 'legion', 'dell', 'asus', 'desktop', 'home'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const w = words[h % words.length];
  const n = ((h >>> 8) % 900) + 100; // 100-999，避免前导 0
  return `${w}-pc-${n}`;
}

// 给实例容器派生一个"像真实有线网卡"的 MAC：常见网卡厂商 OUI 前缀 + 由 id 稳定派生的后三段。
// 容器默认 MAC 带"本地管理位"（第一字节第 2 位为 1，如 02/26/ee 开头），是"非真实硬件"的明显特征；
// 这里用全局管理、单播的真实厂商 OUI，更像一台插了网卡的真机。同一实例每次重建得到相同 MAC。
function realisticMac(id: string): string {
  // 常见消费级网卡厂商 OUI（全局管理 + 单播，首字节低两位为 0）
  const ouis = ['001b21', '8c1645', '00e04c', '0021cc', '3c970e', '001422', 'b827eb'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 131 + id.charCodeAt(i)) >>> 0;
  const oui = ouis[h % ouis.length];
  const hex = (n: number) => (n & 0xff).toString(16).padStart(2, '0');
  const tail = hex(h >>> 3) + hex(h >>> 11) + hex(h >>> 19);
  return (oui + tail).match(/.{2}/g)!.join(':');
}

const docker = new Docker(); // 默认连 /var/run/docker.sock

// 面板自身所在的 docker 网络名；新实例都 attach 到它，便于按容器名互访。
let networkName: string | null = process.env.WOC_DOCKER_NETWORK || null;

export type RuntimeState = 'running' | 'stopped' | 'missing';

// 启动时探测面板自身网络（容器内 hostname = 容器短 id）。失败不致命：
// 退回 WOC_DOCKER_NETWORK 或 null（null 时用 docker 默认 bridge，靠 IP 不靠名字会有问题，故尽量探测成功）。
export async function ensureNetwork(): Promise<string | null> {
  if (networkName) return networkName;
  // 找到「面板自身容器」以读取它所在网络，新建实例就接到同一网络，反代才能按容器名访问到实例。
  // 候选依次：① 容器 hostname（默认 = 自身短 ID）② 已知面板容器名。
  // 关键兜底：面板经「一键更新」自更新后，其 hostname 可能被复刻成【旧容器 ID】（已删除），① 会 404，
  // 这时必须按容器名 ② 找到自己，否则探测失败→新建/重启的实例落到默认 bridge 网络→反代按名访问不到→502 黑屏。
  const candidates = [hostname(), process.env.WOC_PANEL_CONTAINER || 'woc-panel'];
  for (const cand of candidates) {
    if (!cand) continue;
    try {
      const info = await docker.getContainer(cand).inspect();
      const nets = Object.keys(info.NetworkSettings?.Networks || {}).filter((n) => n !== 'none' && n !== 'host');
      if (nets.length > 0) {
        networkName = nets[0];
        return networkName;
      }
    } catch {
      /* 该候选找不到/读不到，尝试下一个 */
    }
  }
  console.warn('[docker] 无法探测面板网络（本地开发或缺少 docker.sock 时正常）');
  return networkName;
}

// 摄像头直通：把宿主的 v4l2 视频设备映射进实例容器
// （浏览器摄像头 → KasmVNC → 容器内 /dev/videoN(v4l2loopback) → 微信）。
// 来源优先级：
//   1) WOC_VIDEO_DEVICES 显式指定（逗号分隔，如 /dev/video0,/dev/video1）——Ubuntu/无法自动探测时用；
//   2) 自动探测：把宿主 /dev 以只读挂到面板的 /host-dev（compose 可选），扫描其中的 videoN。
// 一个都找不到则返回空：音频/麦克风不受影响，仅摄像头不可用（优雅降级）。
function videoDevices(): string[] {
  const explicit = (process.env.WOC_VIDEO_DEVICES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  for (const dir of ['/host-dev', '/dev']) {
    try {
      if (!existsSync(dir)) continue;
      const vids = readdirSync(dir)
        .filter((n) => /^video\d+$/.test(n))
        .map((n) => `/dev/${n}`); // 宿主侧设备路径
      if (vids.length) return vids;
    } catch {
      /* 无权限/不可读，忽略 */
    }
  }
  return [];
}

// GPU 直通：把宿主 /dev/dri 渲染节点映射进实例容器，仅 WOC_ENABLE_GPU=1 时生效。
// 来源优先级：
//   1) WOC_DRI_DEVICES 显式指定（逗号分隔，如 /dev/dri/renderD128,/dev/dri/card0）；
//   2) 自动探测：扫描面板可见的 /host-dev/dri 或 /dev/dri 中的 renderD*/card*。
// 一个都找不到则返回空：硬件编码不可用，但实例照常创建（优雅降级）。
function driDevices(): string[] {
  const explicit = (process.env.WOC_DRI_DEVICES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  for (const dir of ['/host-dev/dri', '/dev/dri']) {
    try {
      if (!existsSync(dir)) continue;
      const dris = readdirSync(dir)
        .filter((n) => /^(renderD\d+|card\d+)$/.test(n))
        .map((n) => `/dev/dri/${n}`); // 宿主侧设备路径
      if (dris.length) return dris;
    } catch {
      /* 无权限/不可读，忽略 */
    }
  }
  return [];
}

// 读取这些 DRI 设备文件的属主数字 GID。宿主上 /dev/dri/renderD* 常归属一个「动态分配」的
// render 组（其 GID 因发行版而异），与镜像内 render 组的 GID 未必一致；仅靠组名加 GroupAdd
// 时，容器内 abc 用户可能仍打不开渲染节点（permission denied）。把宿主侧真实数字 GID 一并
// 加进 GroupAdd，才能保证可访问。读取失败/无权限则跳过（退回仅组名，优雅降级）。
function driDeviceGids(devices: string[]): string[] {
  const gids = new Set<string>();
  for (const dev of devices) {
    try {
      gids.add(String(statSync(dev).gid));
    } catch {
      /* 设备不可 stat（面板未挂 /host-dev 等），忽略 */
    }
  }
  return Array.from(gids);
}

function envList(inst: Instance): string[] {
  const env = [
    `PUID=${PUID}`,
    `PGID=${PGID}`,
    `TZ=${TZ}`,
    `CUSTOM_USER=${inst.kasmUser}`,
    `PASSWORD=${inst.kasmPassword}`,
  ];
  // baseimage 仅检查该变量是否「已设置」（值无关），设上即不再给 Xvnc 加 -hw3d。
  if (!ENABLE_GPU) env.push('DISABLE_DRI=1');
  // 透传 os 伪装开关给容器内的 00-woc-identity 钩子（决定是否把 /etc/os-release 改成 deepin）。
  env.push(`WOC_SPOOF_OS=${SPOOF_OS ? '1' : '0'}`);
  // v1.2.0 多应用：透传应用类型给 02-woc-app 钩子（写入 /config/.woc-app，autostart 据此启动）。
  // 老实例无 appType → instanceAppType 回退 wechat；自定义应用额外透传启动命令。
  const appType = instanceAppType(inst);
  env.push(`WOC_APP_TYPE=${appType}`);
  if (appType === 'custom' && inst.customLaunch) env.push(`WOC_CUSTOM_LAUNCH=${inst.customLaunch}`);
  return env;
}

// 确保微信镜像在本地存在；缺失则从 GHCR 拉取（首次新建实例时镜像通常还没拉过）。
async function ensureImage(): Promise<void> {
  try {
    await docker.getImage(WECHAT_IMAGE).inspect();
    return;
  } catch {
    /* 本地没有，下面拉取 */
  }
  // 首次新建实例常卡在这一步（NAS 直连 docker.io 拉取超时，见 README）。这里前后都打日志：
  // 若诊断包里只见"开始拉取"而无"完成/失败"，即可定位为拉取卡死。
  appendPanelLog('INFO', `本地无实例镜像 ${WECHAT_IMAGE}，开始拉取（首次较慢；NAS 直连 docker.io 可能超时）…`);
  const t0 = Date.now();
  try {
    await pullImage();
    appendPanelLog('INFO', `实例镜像拉取完成 ${WECHAT_IMAGE}（耗时 ${Math.round((Date.now() - t0) / 1000)}s）`);
  } catch (e: any) {
    appendPanelLog('ERROR', `实例镜像拉取失败 ${WECHAT_IMAGE}（耗时 ${Math.round((Date.now() - t0) / 1000)}s）：${e?.message || e}`);
    throw e;
  }
}

// 创建并启动一个微信实例容器。若同名容器已存在则先移除（仅容器，不动卷）。
// 同一实例的重建串行执行（移植自上游 c968908）：手动重启、看门狗自愈、卡死自愈、升级可能撞在一起，
// 并发时两边都「删旧建新」，实测同时点两次重启必有一次报「容器名已被占用」失败。
const lifecycleChains = new Map<string, Promise<unknown>>();
// 重建、整卷恢复（停→写→启）共用这把锁。
function withLifecycle<T>(instId: string, fn: () => Promise<T>): Promise<T> {
  const run = (lifecycleChains.get(instId) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  lifecycleChains.set(instId, tail);
  void tail.then(() => {
    if (lifecycleChains.get(instId) === tail) lifecycleChains.delete(instId);
  });
  return run;
}
export function runInstance(inst: Instance, opts?: { keepImage?: boolean }): Promise<void> {
  return withLifecycle(inst.id, () => runInstanceNow(inst, opts));
}
async function runInstanceNow(inst: Instance, opts?: { keepImage?: boolean }): Promise<void> {
  requireSupportedApp(inst);
  const net = await ensureNetwork();
  const existing = docker.getContainer(inst.containerName);
  let info: Docker.ContainerInspectInfo | undefined;
  try {
    info = await existing.inspect();
  } catch (e: any) {
    // Permission/daemon failures are not evidence that the container is absent.
    if (e?.statusCode !== 404) throw e;
  }
  if (opts?.keepImage && !info?.Image) {
    throw new Error('无法确认原实例镜像，已取消重启；不会改用其它版本');
  }
  const image = opts?.keepImage ? info!.Image : WECHAT_IMAGE;
  // Resolve the image before removing anything. Failed pulls leave the old
  // container intact; restarts never contact a registry or follow a mutable tag.
  // 容器在用的镜像可能已不在本机（例如同名 tag 被新镜像覆盖导致旧镜像 ID 消失）：
  // 遇到 404 时改为原地重启，不删旧容器，同样不换版本（移植自上游 2e1ea60）。
  if (opts?.keepImage) {
    try {
      await docker.getImage(image).inspect();
    } catch (e: any) {
      if (e?.statusCode === 404) {
        await restartInPlace(inst, existing, image);
        return;
      }
      throw e;
    }
  } else {
    await ensureImage();
  }
  if (info) {
    // 删除前先把旧容器最后日志快照进持久日志，否则随容器删除就看不到"上次为何停/崩"。
    await snapshotContainerLog(inst, '容器重建（重启/升级/自愈），保留上一容器最后日志');
    await stopGracefully(existing);
    await existing.remove({ force: true });
  }
  // 摄像头设备（探测不到则为空数组 → 仅摄像头不可用，音频/麦克风照常）
  const vids = videoDevices();
  const dris = ENABLE_GPU ? driDevices() : [];
  const hostConfig: Docker.HostConfig = {
    Binds: [`${inst.volumeName}:/config`],
    NetworkMode: net || undefined,
    SecurityOpt: ['seccomp=unconfined'],
    ShmSize: SHM_SIZE,
    RestartPolicy: { Name: 'unless-stopped' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '2' } },
  };
  if (INSTANCE_MEM > 0) {
    hostConfig.Memory = INSTANCE_MEM;
    hostConfig.MemorySwap = INSTANCE_MEM; // 禁止 swap 膨胀：限制即为硬上限
  }
  if (vids.length) {
    hostConfig.Devices = vids.map((d) => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: 'rwm' }));
    hostConfig.GroupAdd = ['video']; // 让容器内 abc 用户能访问 /dev/videoN
    console.log(`[docker] 实例 ${inst.id} 挂载摄像头设备: ${vids.join(', ')}`);
  }
  if (dris.length) {
    hostConfig.Devices = [
      ...(hostConfig.Devices || []),
      ...dris.map((d) => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: 'rwm' })),
    ];
    // 组名 render/video + 宿主侧真实数字 GID（应对 render 组 GID 在宿主与镜像间不一致的常见情况）。
    hostConfig.GroupAdd = Array.from(
      new Set([...(hostConfig.GroupAdd || []), 'render', 'video', ...driDeviceGids(dris)]),
    );
    console.log(`[docker] 实例 ${inst.id} 挂载 GPU 渲染设备: ${dris.join(', ')}`);
  }
  // 伪装成真实有线网卡 MAC（厂商 OUI），替代容器默认的本地管理位 MAC。
  const mac = realisticMac(inst.id);
  const createOpts: Docker.ContainerCreateOptions = {
    name: inst.containerName,
    Image: image,
    // 内部 hostname 伪装成"个人电脑"名（不再用 woc-wx-<hex>，那是容器/服务器特征）。
    // 反代靠容器名 name 寻址，与此 hostname 无关。
    Hostname: realisticHostname(inst.id),
    Env: envList(inst),
    ExposedPorts: { '3000/tcp': {} },
    // 宿主关机、Docker 重启时同样按 15 秒停容器，给应用留足正常退出时间（配合 docker/woc-startwm.sh，上游 85a9730）。
    StopTimeout: STOP_GRACE_SEC,
    HostConfig: hostConfig,
  };
  // 自定义网络时，MAC 须写到对应 endpoint 上（新版 docker 弃用顶层 MacAddress）；默认网络则用顶层。
  if (net) {
    createOpts.NetworkingConfig = { EndpointsConfig: { [net]: { MacAddress: mac } as any } };
  } else {
    (createOpts as any).MacAddress = mac;
  }
  const container = await docker.createContainer(createOpts);
  try {
    await container.start();
    appendInstanceLog(inst.id, '容器已启动');
    // 容器重建后恢复持久化的字体配置 / xsettingsd
    restoreFontFromVolume(inst).catch(() => {});
  } catch (e) {
    // 启动失败但容器已被创建出来（Created 状态），不清理的话会成为"幽灵容器"——
    // 它仍占着卷名 woc-data-<id>，让后续删卷报 409。修复 #23 时发现 4 个此类残留。
    try {
      await container.remove({ force: true });
    } catch {
      /* 容器已被外部移走或正在被清理，忽略 */
    }
    throw e;
  }
}

// 原地重启（镜像已不在本机、没法重建时用，移植自上游 2e1ea60）。先清掉 X 显示锁再重启容器。
async function restartInPlace(inst: Instance, c: Docker.Container, image: string): Promise<void> {
  appendInstanceLog(inst.id, `原镜像 ${image.replace(/^sha256:/, '').slice(0, 12)} 已不在本机（同名镜像被更新过），改为原地重启容器`);
  await execCapture(inst, ['sh', '-c', 'rm -f /tmp/.X[0-9]*-lock'], 'root').catch(() => {});
  await c.restart({ t: STOP_GRACE_SEC } as any);
  appendInstanceLog(inst.id, '容器已原地重启');
}

// 启动时等 Docker 可用（socket-proxy 晚到几秒时避免启动流程落空，移植自上游 b0ff007）。
export async function waitForDocker(maxMs = 30_000): Promise<boolean> {
  const host = (process.env.DOCKER_HOST || '').trim();
  if (!host && !existsSync('/var/run/docker.sock')) return false;
  if (host.startsWith('unix://') && !existsSync(host.slice('unix://'.length))) return false;
  const t0 = Date.now();
  let lastErr: any;
  while (Date.now() - t0 < maxMs) {
    try {
      await docker.ping();
    } catch (e: any) {
      lastErr = e;
      if (!e?.statusCode) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
    }
    const waited = Date.now() - t0;
    if (waited > 1500) appendPanelLog('INFO', `等了 ${Math.round(waited / 1000)} 秒才连上 Docker（socket-proxy 刚启动？）`);
    return true;
  }
  appendPanelLog(
    'ERROR',
    `${Math.round(maxMs / 1000)} 秒内连不上 Docker（${lastErr?.message || lastErr}），实例相关功能暂不可用；请检查 docker.sock 挂载或 socket-proxy 容器`,
  );
  return false;
}

// 确保实例容器在运行：缺失则按需创建（不会重建已有卷），停止则启动。
// 只有容器确实不存在（404）才新建：Docker 一时连不上时直接报错，避免误重建（移植自上游 b0ff007）。
export async function ensureRunning(inst: Instance): Promise<void> {
  requireSupportedApp(inst);
  try {
    const c = docker.getContainer(inst.containerName);
    const info = await c.inspect();
    if (!info.State?.Running) await c.start();
  } catch (e: any) {
    if (e?.statusCode === 404) {
      await runInstance(inst);
      return;
    }
    throw e;
  }
}

// 升级实例：拉取最新微信镜像后重建容器（保留数据卷 → 登录态不丢）。
// 拉取失败则保留旧容器并报错，不回退 latest，也不把旧镜像重建报告为升级成功。
export async function upgradeInstance(inst: Instance): Promise<void> {
  requireSupportedApp(inst);
  await pullImage();
  await runInstance(inst);
}

// 重置实例的设备 machine-id：删掉持久化的 .woc-machine-id 后重启，由 00-woc-identity 钩子重新生成
// 一个全新的唯一值（相当于"换一台新设备"）。用于某账号被腾讯风控标记后手动滚新设备身份。
// 仅对含身份钩子的新镜像有效；旧镜像（升级前）无钩子，先 throw 提示升级，避免做无用功。
export async function regenInstanceMachineId(inst: Instance): Promise<void> {
  requireSupportedApp(inst);
  const hasHook = (
    await execCapture(inst, [
      'sh',
      '-c',
      'test -f /custom-cont-init.d/00-woc-identity && echo yes || echo no',
    ])
  ).trim();
  if (hasHook !== 'yes') {
    throw new Error('该实例运行的是旧镜像（无设备身份模块），请先「升级实例」后再重置设备 ID');
  }
  // 删除持久化文件；重启时钩子检测到缺失 → 生成新的唯一 machine-id 并写回卷
  await execCapture(inst, ['sh', '-c', 'rm -f /config/.woc-machine-id']);
  await runInstance(inst, { keepImage: true });
}

// 先正常停止容器再删除，避免直接 remove({ force: true }) SIGKILL 微信导致数据未落盘（上游 7bba05f + 85a9730）。
// 超时 15s 须长于实例镜像的 S6_SERVICES_GRACETIME=10000（10s）。
const STOP_GRACE_SEC = 15;
async function stopGracefully(c: Docker.Container): Promise<void> {
  try {
    await c.stop({ t: STOP_GRACE_SEC } as any);
  } catch {
    /* 已停止 / 不存在：照常往下删 */
  }
}

// 停止实例容器（保留容器与数据卷，可再启动）。
export async function stopInstance(inst: Instance): Promise<void> {
  try {
    await docker.getContainer(inst.containerName).stop({ t: STOP_GRACE_SEC } as any);
    appendInstanceLog(inst.id, '容器已停止');
  } catch {
    /* 已停止或不存在 */
  }
}

export async function removeInstance(inst: Instance, purgeVolume: boolean): Promise<void> {
  try {
    const c = docker.getContainer(inst.containerName);
    if (!purgeVolume) await stopGracefully(c); // 数据卷还要留着用：让应用把数据写完再走
    await c.remove({ force: true });
  } catch {
    /* 容器可能已不存在 */
  }
  if (purgeVolume) {
    try {
      await docker.getVolume(inst.volumeName).remove({ force: true } as any);
    } catch {
      /* 卷可能不存在 */
    }
    deleteInstanceLog(inst.id); // 彻底删除时一并清掉持久日志
  }
}

// 列出"未被任何容器引用的 woc-data-* 数据卷"。判定改为 docker 真实视角（不再仅看 store），
// 否则 Created 状态的"幽灵容器"会让卷被误判为孤儿，删除时撞 409（real-world issue：
// 早期 runInstance 启动失败漏清残留容器，留下 4 个 Created 容器各占一个卷名）。
export async function listOrphanVolumes(referencedVolumes: Set<string>): Promise<
  Array<{ name: string; createdAt?: string; sizeBytes?: number }>
> {
  // 容器视角：扫所有容器（含已停止 / Created），收集它们挂载的 woc-data-* 卷名
  const allContainers = await docker.listContainers({ all: true });
  const containerRefs = new Set<string>();
  for (const c of allContainers) {
    for (const m of c.Mounts || []) {
      if (typeof m.Name === 'string' && m.Name.startsWith('woc-data-')) containerRefs.add(m.Name);
    }
  }
  // 与 store 视角并集：取两者都未引用的卷
  const referenced = new Set<string>([...referencedVolumes, ...containerRefs]);

  const { Volumes } = (await (docker as any).listVolumes()) || { Volumes: [] };
  if (!Array.isArray(Volumes)) return [];
  return Volumes
    .filter((v: any) => typeof v?.Name === 'string' && v.Name.startsWith('woc-data-') && !referenced.has(v.Name))
    .map((v: any) => ({
      name: v.Name,
      createdAt: v.CreatedAt,
      // UsageData 仅在 docker engine 启用 -v size=true 时返回，常见情况下没有；缺失就不展示
      sizeBytes: typeof v?.UsageData?.Size === 'number' && v.UsageData.Size >= 0 ? v.UsageData.Size : undefined,
    }))
    .sort((a, b) => (a.createdAt && b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : 0));
}

// 显式删除一个数据卷（管理员清理孤儿卷用）。调用方负责确认它不被现存实例引用。
export async function removeVolume(name: string): Promise<void> {
  await docker.getVolume(name).remove({ force: true } as any);
}

// 列出"残留的 woc-wx-* 容器"：在 docker 里存在但 store 没登记的（多为 runInstance 失败时
// 留下的 Created 状态容器，或用户手动 docker run 出来的）。给管理员一键清理。
export async function listOrphanContainers(
  knownContainerNames: Set<string>,
): Promise<Array<{ id: string; name: string; status: string; volumeName?: string }>> {
  const all = await docker.listContainers({ all: true });
  const out: Array<{ id: string; name: string; status: string; volumeName?: string }> = [];
  for (const c of all) {
    const name = (c.Names || []).map((n) => n.replace(/^\//, '')).find((n) => n.startsWith('woc-wx-'));
    if (!name) continue;
    if (knownContainerNames.has(name)) continue;
    const vol = (c.Mounts || []).map((m) => m.Name).find((n) => typeof n === 'string' && n.startsWith('woc-data-'));
    out.push({ id: c.Id, name, status: c.Status || c.State || '', volumeName: vol });
  }
  return out;
}

// 强制删除一个残留容器（按短/全 id 或容器名都行）。
export async function removeContainerById(idOrName: string): Promise<void> {
  await docker.getContainer(idOrName).remove({ force: true });
}

// 取实例容器的"working set"内存（MB）：等同 docker stats 显示值 = usage - inactive_file。
// 用于 watchdog 检测 KasmVNC/Xvnc 长跑泄漏（21 小时可涨到 ~9 GiB），无法读取时返回 0（视为"暂未知"，
// 不触发自愈，避免容器刚启动 stats 不可用就被误杀）。一次性 stats、不订阅 stream。
export async function instanceMemoryMB(inst: Instance): Promise<number> {
  try {
    const c = docker.getContainer(inst.containerName);
    const s: any = await c.stats({ stream: false } as any);
    const usage = Number(s?.memory_stats?.usage) || 0;
    const inactive = Number(
      s?.memory_stats?.stats?.inactive_file ?? s?.memory_stats?.stats?.total_inactive_file,
    ) || 0;
    const bytes = Math.max(0, usage - inactive);
    return Math.round(bytes / 1024 / 1024);
  } catch {
    return 0;
  }
}

// 响应性健康探测：实测发现容器跑久了会出现 I/O / 服务 stall —— 进程没死、面板显示"在线"，
// 但读不出 VNC 客户端静态文件（nginx 报 upstream timed out），浏览器永远卡在"正在连接桌面"。
// 这里带注入鉴权请求真正会卡的那条路径（/vnc/index.html，经 nginx→kclient 静态serve），
// 超时即判不健康。无鉴权时 nginx 直接 401（很快），故必须注入鉴权让请求真正打到 kclient 静态层。
export async function instanceHttpHealthy(inst: Instance, timeoutMs = 8000): Promise<boolean> {
  const auth = 'Basic ' + Buffer.from(`${inst.kasmUser}:${inst.kasmPassword}`).toString('base64');
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.get(
      {
        host: inst.containerName,
        port: 3000,
        path: '/vnc/index.html',
        headers: { authorization: auth },
        timeout: timeoutMs,
      },
      (res) => {
        // 拿到响应头即说明 nginx+kclient 静态serve 活着（健康时为 200）。读掉 body 释放连接。
        const ok = !!res.statusCode && res.statusCode < 500;
        res.resume();
        done(ok);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(false); // 超时 = stall，判不健康
    });
    req.on('error', () => done(false));
  });
}


export async function instanceRuntime(inst: Instance): Promise<RuntimeState> {
  try {
    const info = await docker.getContainer(inst.containerName).inspect();
    return info.State?.Running ? 'running' : 'stopped';
  } catch {
    return 'missing';
  }
}

// 实例容器本次已运行多少秒（State.StartedAt 起算）；没在跑 / 读不到时返回 null。
export async function instanceUptimeSec(inst: Instance): Promise<number | null> {
  try {
    const info = await docker.getContainer(inst.containerName).inspect();
    if (!info.State?.Running) return null;
    const t = Date.parse(String(info.State.StartedAt || ''));
    return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : null;
  } catch {
    return null;
  }
}

// 创建 exec 实例。容器 init 未完成时，linuxserver 基镜像的 'abc' 用户可能还没建好，docker 会以
// 400「unable to find user abc: no matching entries in passwd file」直接拒绝创建 exec（见 issue #74）。
// 对这种"用户未就绪"错误短暂重试，给容器 init 一点时间；超时则抛清晰的中文错误，而非透传难懂的 docker 400。
async function execCreate(c: any, opts: any): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < 8; i++) {
    try {
      return await c.exec(opts);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (!/no matching entries in passwd|unable to find user/i.test(msg)) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`容器仍在初始化（桌面用户未就绪），请等待约十几秒后重试（${lastErr?.message || lastErr}）`);
}

// 在实例容器内执行命令，返回 stdout；若命令失败，把 stderr 透出给调用方。
async function execCapture(inst: Instance, cmd: string[], user = 'abc', timeoutMs = 0): Promise<string> {
  const c = docker.getContainer(inst.containerName);
  const exec = await execCreate(c, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: user });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise<string>((resolve, reject) => {
    let ended = false;
    const timer = timeoutMs ? setTimeout(() => { stream.destroy(); reject(new Error('命令结果未知：执行超时')); }, timeoutMs) : undefined;
    stream.on('close', () => {
      if (timer && !ended) clearTimeout(timer);
      if (timeoutMs && !ended) reject(new Error('命令结果未知：连接关闭'));
    });
    let out = '';
    let err = '';
    // Docker may split a UTF-8 filename across frames; decode after reassembly.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const stdout = { write: (b: Buffer) => { out += outDecoder.write(b); } } as any;
    const stderr = { write: (b: Buffer) => { err += errDecoder.write(b); } } as any;
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on('end', async () => {
      ended = true;
      out += outDecoder.end();
      err += errDecoder.end();
      try {
        const info = await exec.inspect();
        if (timer) clearTimeout(timer);
        if (timeoutMs && (info.Running || info.ExitCode == null)) {
          reject(new Error('命令结果未知：无法确认执行已结束'));
          return;
        }
        if (info.ExitCode && info.ExitCode !== 0) {
          reject(new Error((err || out || `命令执行失败，退出码 ${info.ExitCode}`).trim()));
          return;
        }
        resolve(out || err);
      } catch (e) {
        if (timer) clearTimeout(timer);
        reject(e);
      }
    });
    stream.on('error', e => { if (timer) clearTimeout(timer); reject(e); });
  });
}

// 触发下载/安装（detached，立即返回，后台下载）。按实例 appType 分发：app-ctl.sh wechat → 委托回
// wechat-ctl.sh；telegram 等各自实现。兼容旧容器（升级前镜像里没有 /woc/app-ctl.sh）：有则用之，无则
// 回退老的 wechat-ctl.sh（旧实例都是微信）。appType 取值受 instanceAppType 约束，可安全内插进 shell。
export async function triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
  const c = docker.getContainer(inst.containerName);
  const at = requireSupportedApp(inst);
  const action = cmd === 'update' ? 'update' : 'install';
  const exec = await execCreate(c, {
    Cmd: ['bash', '-c', `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} ${action}; else /woc/wechat-ctl.sh ${action}; fi`],
    AttachStdout: false,
    AttachStderr: false,
    User: 'abc',
  });
  await exec.start({ Detach: true });
}

export interface WechatStatus {
  phase: string;
  percent: number;
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

const DEFAULT_STATUS: WechatStatus = { phase: 'idle', percent: 0, installed: false, version: '', message: '未安装', updatedAt: 0 };
// 读状态偶尔失败时 60 秒内沿用上次状态，避免桌面页误判「未安装」而卸载重连 iframe（移植自上游 2e1ea60）。
const STATUS_GRACE_MS = 60_000;
const lastStatus = new Map<string, { st: WechatStatus; at: number }>();

export async function wechatStatus(inst: Instance): Promise<WechatStatus> {
  if (instanceAppType(inst) === 'chromium') {
    return { ...DEFAULT_STATUS, phase: 'error', message: '浏览器实例功能已移除，原数据卷仍保留' };
  }
  try {
    // 兼容旧容器（无 /woc/app-ctl.sh）：有则按 appType 取状态，无则回退老的 wechat-ctl.sh（旧实例皆微信）。
    const at = requireSupportedApp(inst);
    const raw = await execCapture(inst, [
      'bash',
      '-c',
      `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} status; else /woc/wechat-ctl.sh status; fi`,
    ]);
    const st: WechatStatus = { ...DEFAULT_STATUS, ...JSON.parse(raw.trim()) };
    lastStatus.set(inst.id, { st, at: Date.now() });
    return st;
  } catch {
    const last = lastStatus.get(inst.id);
    return last && Date.now() - last.at < STATUS_GRACE_MS ? last.st : DEFAULT_STATUS;
  }
}

// 拉取微信镜像（首次部署/更新镜像用）。返回拉取日志的最后状态。
export async function pullImage(onProgress?: (line: any) => void): Promise<void> {
  // 无进度超时：NAS 直连 docker.io 常卡死（拉取流僵住、永不结束），旧版会让"创建实例"请求无限 hang，
  // 前端一直转圈、还删不掉（issue #99）。这里只要 N 分钟内没有任何进度就中止拉取，让创建带清晰错误快速失败、
  // 用户可重试/删除。默认 5 分钟，WOC_PULL_STALL_MIN 可调。
  const STALL_MS = 1000 * 60 * Math.max(2, Number(process.env.WOC_PULL_STALL_MIN) || 5);
  return await new Promise((resolve, reject) => {
    docker.pull(WECHAT_IMAGE, (err: any, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (e: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        e ? reject(e) : resolve();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            (stream as any).destroy?.();
          } catch {
            /* ignore */
          }
          finish(new Error(`拉取镜像 ${Math.round(STALL_MS / 60000)} 分钟无进度，判定网络卡死并中止（建议配置国内镜像源或预拉取，详见 README）`));
        }, STALL_MS);
      };
      arm();
      docker.modem.followProgress(
        stream,
        (e: any) => finish(e),
        (ev: any) => {
          arm(); // 每有进度就重置超时
          onProgress?.(ev);
        },
      );
    });
  });
}

// ---------- 文件中转（上传/下载） ----------
// 中转目录 = abc 家目录下的 Desktop（/config 持久卷）。上传落这里，微信文件选择器可直接选到；
// 反向：把微信收到的文件另存到桌面，即可在面板里下载。
const TRANSFER_DIR = '/config/Desktop';

// ---------- 诊断包 ----------
// 多文件 tar.gz（内存构建；诊断包通常仅数 MB）。
function buildTarGz(entries: { name: string; content: string | Buffer }[]): Buffer {
  return zlib.gzipSync(tarArchive(entries.map((e) => tarEntry(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8')))));
}

// 汇总诊断包：系统信息 + 面板全局日志 + 每个实例（容器状态 + 持久日志 + 实时日志）+ 全部 woc-* 容器清单。
// 日志按 sinceMs 时间裁剪。给排查"首个实例创建卡死 / 打开实例黑屏不可用 / 升级失败"等问题用。
export async function buildDiagnostics(instances: Instance[], sinceMs: number, meta: Record<string, string>): Promise<Buffer> {
  const entries: { name: string; content: string | Buffer }[] = [];
  const stamp = new Date().toISOString();

  entries.push({
    name: 'README.txt',
    content: [
      '云微 · WechatOnCloud 诊断包',
      `生成时间: ${stamp}`,
      `时间范围: 最近 ${meta.range || '24h'}`,
      '',
      '内容：',
      '  system.txt        系统/Docker/镜像信息',
      '  panel.log         面板全局运维日志（创建/删除/升级/启停/镜像拉取/错误）',
      '  containers.txt    所有 woc-* 容器清单（含残留/未登记）',
      '  instances/<id>.log 每个实例：容器状态 + 持久日志 + 实时容器日志',
      '',
      '把本压缩包发给维护者即可协助排查（不含密码/密钥等敏感信息）。',
    ].join('\n'),
  });

  // 系统信息
  let sys = `生成时间: ${stamp}\n时间范围: 最近 ${meta.range || '24h'}\n\n`;
  for (const [k, v] of Object.entries(meta)) sys += `${k}: ${v}\n`;
  try {
    const ver: any = await docker.version();
    sys += `\nDocker 版本: ${ver.Version} (API ${ver.ApiVersion}, ${ver.Os}/${ver.Arch})\n`;
  } catch (e: any) {
    sys += `\nDocker 版本: 获取失败 ${e?.message || e}\n`;
  }
  try {
    const info: any = await docker.info();
    sys += `容器: ${info.Containers}（运行 ${info.ContainersRunning}） · 镜像: ${info.Images}\n`;
    sys += `内核: ${info.KernelVersion} · OS: ${info.OperatingSystem} · 架构: ${info.Architecture}\n`;
    sys += `CPU: ${info.NCPU} 核 · 内存: ${(info.MemTotal / 1073741824).toFixed(1)} GiB · 内存限制支持: ${info.MemoryLimit ? '是' : '否'} · Swap限制支持: ${info.SwapLimit ? '是' : '否'}\n`;
    // cgroup / 存储 / 安全选项：排查 Ubuntu server 上的内存限制不生效、apparmor/userns 限制、seccomp 等宿主级问题。
    sys += `cgroup: v${info.CgroupVersion ?? '?'}/${info.CgroupDriver ?? '?'} · 存储驱动: ${info.Driver}\n`;
    if (Array.isArray(info.SecurityOptions) && info.SecurityOptions.length)
      sys += `安全选项: ${info.SecurityOptions.map((o: string) => o.replace(/^name=/, '')).join(', ')}\n`;
    if (Array.isArray(info.Warnings) && info.Warnings.length) sys += `Docker 警告: ${info.Warnings.join('; ')}\n`;
  } catch (e: any) {
    sys += `Docker info: 获取失败 ${e?.message || e}\n`;
  }
  try {
    const img: any = await docker.getImage(WECHAT_IMAGE).inspect();
    sys += `\n实例镜像 ${WECHAT_IMAGE}: ${String(img.Id).slice(0, 19)} · 创建 ${img.Created}\n`;
  } catch {
    sys += `\n实例镜像 ${WECHAT_IMAGE}: 本地不存在（首次新建实例需联网拉取，可能在此卡住）\n`;
  }
  // 面板侧实例资源配置（排查内存：默认不设 docker 硬上限时，单实例涨太大会被宿主内核 OOM-killer 杀，
  // 在小内存 Ubuntu server 上尤其常见，表现为黑屏/502/反复重启）。
  sys += `\n面板实例配置: SHM=${(SHM_SIZE / 1073741824).toFixed(0)}GiB`;
  sys += ` · docker硬内存上限=${INSTANCE_MEM > 0 ? (INSTANCE_MEM / 1073741824).toFixed(1) + 'GiB' : '未设(不限，靠宿主 OOM 兜底)'}`;
  sys += ` · GPU=${ENABLE_GPU ? '开' : '关(软件渲染)'}\n`;
  sys += `内存自愈阈值(MiB): soft=${process.env.WOC_INSTANCE_MEM_SOFT_MB || '1500'} · hard=${process.env.WOC_INSTANCE_MEM_HARD_MB || '2500'}\n`;
  sys += `\n实例数: ${instances.length}\n`;
  entries.push({ name: 'system.txt', content: sys });

  // 面板全局日志（按范围裁剪）
  entries.push({ name: 'panel.log', content: filterSince(readPanelLog(), sinceMs) || '（无面板日志）' });

  // 每个实例
  for (const inst of instances) {
    let c = `实例: ${inst.name}\nID: ${inst.id}\n容器: ${inst.containerName}\n类型: ${instanceAppType(inst)}\n数据卷: ${inst.volumeName}\n创建: ${inst.createdAt}\n\n`;
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      const s = info.State || {};
      c += `===== 容器状态 =====\n运行: ${s.Running} · 状态: ${s.Status} · 退出码: ${s.ExitCode}\n`;
      c += `OOMKilled: ${s.OOMKilled} · 重启次数: ${info.RestartCount} · 启动于: ${s.StartedAt}\n`;
      if (s.Error) c += `错误: ${s.Error}\n`;
      // 实时内存占用：配合宿主总内存/OOMKilled 一眼判断是不是内存不足（小内存 server 的高频成因）。
      if (s.Running) {
        try {
          const mem = await instanceMemoryMB(inst);
          if (mem > 0) c += `当前内存占用: ${mem} MiB\n`;
        } catch {
          /* stats 偶发不可用，忽略 */
        }
      }
      c += `镜像: ${String(info.Image).slice(0, 19)} · 健康: ${s.Health?.Status ?? 'n/a'}\n\n`;
    } catch (e: any) {
      c += `===== 容器状态 =====\n无法读取（容器可能未创建/已删除）：${e?.message || e}\n\n`;
    }
    c += `===== 持久化日志（最近 ${meta.range || '24h'}） =====\n${filterSince(readInstanceLog(inst.id), sinceMs) || '（无）'}\n\n`;
    try {
      c += `===== 本次容器日志（实时 tail 300） =====\n${(await instanceLogs(inst, 300)).trimEnd() || '（无）'}\n`;
    } catch (e: any) {
      c += `===== 本次容器日志 =====\n获取失败：${e?.message || e}\n`;
    }
    try {
      const status = await execCapture(inst, ['sh', '-c', 'head -c 8192 /config/.woc-state/status.json 2>/dev/null || true']);
      const installLog = await execCapture(inst, ['sh', '-c', 'tail -n 50 /config/.woc-state/install.log 2>/dev/null | tail -c 16384 || true']);
      c += `\n===== 安装状态 =====\n${status.trim() || '（无）'}\n`;
      c += `\n===== 安装日志（最后 50 行，最多 16KiB） =====\n${installLog.trim() || '（无）'}\n`;
    } catch {
      c += '\n===== 安装诊断 =====\n不可用（容器可能已停止）\n';
    }
    entries.push({ name: `instances/${inst.id}.log`, content: c });
  }

  // 全部 woc-* 容器清单（含未登记/残留，用于诊断"首次创建失败遗留"）
  try {
    const all = await docker.listContainers({ all: true });
    const known = new Set(instances.map((i) => i.containerName));
    let txt = '所有 woc-* 容器：\n\n';
    for (const ct of all) {
      const names = (ct.Names || []).map((n: string) => n.replace(/^\//, ''));
      if (!names.some((n) => n.startsWith('woc-'))) continue;
      const nm = names.join(',');
      const tag = nm.includes('woc-panel') ? '面板' : known.has(nm) ? '已登记实例' : '未登记/残留';
      txt += `[${tag}] ${nm} · ${ct.State}/${ct.Status} · ${ct.Image}\n`;
    }
    entries.push({ name: 'containers.txt', content: txt });
  } catch (e: any) {
    entries.push({ name: 'containers.txt', content: '获取失败：' + (e?.message || e) });
  }

  return buildTarGz(entries);
}

// 校验文件名为安全 basename（防路径穿越）。长度按字节算：Linux 文件名上限 255 字节，一个汉字占 3 字节。
function safeName(name: string): boolean {
  return !!name && Buffer.byteLength(name, 'utf8') <= 255 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..';
}
function assertSafeName(name: string): void {
  if (Buffer.byteLength(name || '', 'utf8') > 255) throw new Error('文件名太长（最多 255 字节，约 85 个汉字），请改短后再上传');
  if (!safeName(name)) throw new Error('文件名不合法');
}

// 壁纸/字体文件名：在 safeName 基础上，额外拒绝 shell 元字符。这些名字会被拼进 `sh -c '...${name}...'`
// （xwallpaper/fc-scan 等），拒绝 ' " $ ` \ ; & | < > 及换行后，单引号内插值不可能被逃逸/注入，正常文件名
//（含空格/括号/中文）仍放行。
function safeMediaName(name: string): boolean {
  return safeName(name) && !/['"$`\\;&|<>\r\n]/.test(name);
}

// ---------- 流式写入单个文件 ----------
// 边收边打成 tar 交给 docker，面板内存不随文件大小增长。先写到 /config/.woc-upload 下的临时名，完整收到后才改名到
// 目标位置：上传中途断开（关页面、断网、取消）时 docker 已经写下了半截文件，此前这个半截文件就顶着正式文件名留在
// 桌面上，看着和正常文件一样，发出去才发现打不开。临时目录与目标同在 /config 卷上，改名是原子操作。
const UPLOAD_TMP_DIR = '/config/.woc-upload';

// putArchive 的响应体是空的，读掉以释放连接
async function putArchiveStream(inst: Instance, tar: NodeJS.ReadableStream, path: string): Promise<void> {
  const res: any = await docker.getContainer(inst.containerName).putArchive(tar, { path });
  if (res && typeof res.resume === 'function') res.resume();
}

// 目标所在磁盘的可用空间（字节）；查不到返回 null（不拦）
async function freeBytesIn(inst: Instance, dir: string): Promise<number | null> {
  try {
    const out = await execCapture(inst, ['df', '-Pk', dir]);
    const kb = Number(out.trim().split('\n').pop()?.trim().split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

async function assertFreeSpace(inst: Instance, dir: string, need: number): Promise<void> {
  const free = await freeBytesIn(inst, dir);
  if (free !== null && need + 64 * 1024 ** 2 > free) {
    throw Object.assign(new Error(`实例数据盘空间不足：需要 ${fmtBytes(need)}，只剩 ${fmtBytes(free)}`), { statusCode: 507 });
  }
}

// docker / 命令行的英文报错翻成能看懂的
function friendlyWriteError(e: any): Error {
  const msg = String(e?.message || e);
  if (/no space left on device/i.test(msg)) return Object.assign(new Error('实例数据盘空间不足，文件没能写完'), { statusCode: 507 });
  if (/is not running|container .* is restarting/i.test(msg)) return new Error('实例未运行，请先启动实例');
  if (/cannot overwrite directory|Is a directory/i.test(msg)) return new Error('目标位置已有同名文件夹');
  if (/File name too long/i.test(msg)) return new Error('文件名太长');
  return e instanceof Error ? e : new Error(msg);
}

async function putFileStream(inst: Instance, dir: string, name: string, size: number, body: AsyncIterable<Buffer>): Promise<void> {
  assertSafeName(name);
  await execCapture(inst, ['mkdir', '-p', dir, UPLOAD_TMP_DIR]).catch((e) => {
    throw friendlyWriteError(e);
  });
  // 顺手清掉面板被重启等情况下没来得及删的临时文件；正在写的临时文件 mtime 一直在刷新，不会误删
  await execCapture(inst, ['find', UPLOAD_TMP_DIR, '-maxdepth', '1', '-type', 'f', '-mmin', '+180', '-delete'], 'root').catch(() => {});
  await assertFreeSpace(inst, UPLOAD_TMP_DIR, size);
  const tmp = `${UPLOAD_TMP_DIR}/part-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tar = tarFileStream(tmp.slice(UPLOAD_TMP_DIR.length + 1), size, body);
  try {
    await putArchiveStream(inst, tar, UPLOAD_TMP_DIR);
    await execCapture(inst, ['mv', '-fT', '--', tmp, `${dir}/${name}`], 'root');
  } catch (e) {
    tar.destroy();
    await execCapture(inst, ['rm', '-f', '--', tmp], 'root').catch(() => {});
    throw friendlyWriteError(e);
  }
}

export async function uploadToInstance(inst: Instance, name: string, size: number, body: AsyncIterable<Buffer>): Promise<void> {
  await putFileStream(inst, TRANSFER_DIR, name, size, body);
}

export interface TransferFile {
  name: string;
  size: number;
  mtime?: number; // Unix seconds; additive field for older clients
}
export async function listInstanceFiles(inst: Instance): Promise<TransferFile[]> {
  const out = await execCapture(inst, [
    'find', TRANSFER_DIR, '-maxdepth', '1', '-type', 'f', '-printf', '%f\\0%s\\0%T@\\0',
  ]);
  return parseTransferFiles(out);
}

export async function deleteInstanceFile(inst: Instance, name: string): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  // argv 数组直传，不经 shell；safeName 已排除路径穿越
  await execCapture(inst, ['rm', '-f', `${TRANSFER_DIR}/${name}`]);
}

// 以流的形式读出容器里的一个普通文件，不整个读进内存。微信收到的视频、文件动辄几百 MB 到 GB，此前先把整个 tar 读进
// 内存再解出文件，面板进程峰值约为文件大小的两倍，NAS 上容易被 OOM 杀掉，所有人的桌面跟着断。
// 走 docker exec cat：输出按 docker 的 stdout/stderr 分帧，这里自己拆帧，并在下游写不动时暂停读取（慢速客户端不在内存里堆积）。
// 先 stat：只放行普通文件（不跟随符号链接，与 getArchive 一致），出错能在发出响应头之前报。
export async function streamRegularFile(inst: Instance, absPath: string): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  const st = await execCapture(inst, ['stat', '-c', '%F|%s', '--', absPath], 'root').catch(() => '');
  if (!st) throw new Error('文件不存在或已被删除');
  const [kind, size] = st.trim().split('|');
  if (kind !== 'regular file' && kind !== 'regular empty file') throw new Error('不是普通文件');
  const exec = await execCreate(docker.getContainer(inst.containerName), {
    Cmd: ['cat', '--', absPath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: 'root',
  });
  const raw = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream & { destroy?: () => void };
  const out = new PassThrough();
  let buf: Buffer = Buffer.alloc(0);
  let need = 0; // 当前帧还剩多少字节
  let type = 0; // 1 = stdout，2 = stderr
  raw.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (need === 0) {
        if (buf.length < 8) break;
        type = buf[0];
        need = buf.readUInt32BE(4);
        buf = buf.subarray(8);
        continue;
      }
      if (!buf.length) break;
      const part = buf.subarray(0, need);
      buf = buf.subarray(part.length);
      need -= part.length;
      if (type === 1 && !out.write(part)) {
        raw.pause();
        out.once('drain', () => raw.resume());
      }
    }
  });
  raw.on('end', () => out.end());
  raw.on('error', (e) => out.destroy(e as Error));
  out.on('close', () => raw.destroy?.()); // 客户端中途断开：停掉 cat
  return { size: Number(size) || 0, stream: out };
}

export async function downloadFromInstance(inst: Instance, name: string): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  if (!safeName(name)) throw new Error('文件名不合法');
  return streamRegularFile(inst, `${TRANSFER_DIR}/${name}`);
}

// 从 docker getArchive 返回的 tar 中取出第一个普通文件的内容。Docker(Go archive/tar) 在 mtime 含纳秒精度等
// 情况下会先写一个 PAX 扩展头块（typeflag 'x'），把它误当文件头会读到扩展记录长度 → 返回错误长度的数据
// （"大小不对"）。这里跳过 PAX/全局('x'/'g')与 GNU 长名('L'/'K')等扩展头，找到普通文件('0'/NUL)再取内容。
function extractSingleFileFromTar(tar: Buffer): Buffer {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { allZero = false; break; }
    if (allZero) break; // 归档结束（全零块）
    const sizeStr = header.toString('ascii', 124, 136).replace(/[^0-7]/g, '');
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeflag = header[156]; // '0'(0x30) 或 NUL(0) = 普通文件
    const dataStart = off + 512;
    if (typeflag === 0x30 || typeflag === 0) {
      return tar.subarray(dataStart, dataStart + size);
    }
    // 扩展头/目录等：跳过其数据块（向上对齐 512）后继续
    off = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return Buffer.alloc(0);
}

// 拉取实例容器日志（末尾 N 行），供前端"查看/导出日志"排错。
export async function instanceLogs(inst: Instance, tail = 600): Promise<string> {
  const c = docker.getContainer(inst.containerName);
  const buf = (await c.logs({ stdout: true, stderr: true, tail, timestamps: true })) as unknown as Buffer;
  // docker 非 TTY 日志为多路复用流：每帧 8 字节头（[stream,0,0,0,size BE]）+ 负载；解出纯文本。
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    if (size < 0 || i + 8 + size > buf.length) break;
    out += buf.subarray(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out || buf.toString('utf8'); // 兜底：TTY 模式非多路复用
}

// ---------- 持久化日志 ----------
// 日志原语（appendInstanceLog / readInstanceLog / deleteInstanceLog / appendPanelLog 等）已抽到 logs.ts
// （无 docker 依赖，避免循环）。这里只保留需要 docker 的快照能力。

// 把"即将被删/重建"的容器最后日志快照进持久日志（否则随容器删除丢失）。
export async function snapshotContainerLog(inst: Instance, reason: string): Promise<void> {
  try {
    const logs = (await instanceLogs(inst, 200)).trimEnd();
    appendInstanceLog(inst.id, `──── ${reason} ────\n${logs}\n──── 上一容器日志快照结束 ────`);
  } catch {
    /* 容器可能已不可读，忽略 */
  }
}

// Read only: explicit browser copy retrieves PNG without changing X11 ownership.
export async function readClipboardImage(inst: Instance): Promise<Buffer> {
  requireSupportedApp(inst);
  const script = `set -euo pipefail
export DISPLAY="\${DISPLAY:-:1}"
timeout 5 xclip -selection clipboard -t image/png -o 2>/dev/null | head -c 67108865 | base64 -w0`;
  let encoded: string;
  try { encoded = await execCapture(inst, ['bash', '-c', script], 'abc', 10000); }
  catch { throw new PasteError('微信剪贴板中没有可读取的 PNG 图片，请先在微信内复制图片', 422); }
  const content = Buffer.from(encoded.trim(), 'base64');
  validatePasteImage('image/png', content);
  return content;
}

// Image API never retries a possibly dispatched Ctrl+V.
export async function pasteImageInInstance(
  inst: Instance,
  mime: string,
  content: Buffer,
  opts: { lockHeld?: boolean } = {},
): Promise<void> {
  requireSupportedApp(inst);
  validatePasteImage(mime, content);
  const run = async (): Promise<void> => {
    let dir = '';
    try {
      dir = (await execCapture(inst, ['mktemp', '-d', '/tmp/woc-paste-XXXXXXXXXXXX'], 'abc', 10000)).trim();
      if (!/^\/tmp\/woc-paste-[A-Za-z0-9]{12}$/.test(dir)) throw new Error('无法创建粘贴临时目录');
      await docker.getContainer(inst.containerName).putArchive(tarSingleFile('image', content), { path: dir });
    } catch {
      if (dir && /^\/tmp\/woc-paste-[A-Za-z0-9]{12}$/.test(dir)) await execCapture(inst, ['rm', '-rf', '--', dir], 'abc', 5000).catch(() => {});
      throw new PasteError('图片准备失败，可改用上传为文件', 502);
    }
    try {
      await execCapture(inst, ['bash', '-c', IMAGE_PASTE_SCRIPT, 'woc-image-paste', mime, dir + '/image'], 'abc', 55000);
    } catch {
      throw new PasteError('图片粘贴结果未知，请检查输入框；不会自动重试，可改用上传为文件', 502, 'unknown');
    } finally {
      await execCapture(inst, ['rm', '-f', '--', dir + '/image'], 'abc', 5000).catch(() => {});
      await execCapture(inst, ['rmdir', '--', dir], 'abc', 5000).catch(() => {});
    }
  };
  if (opts.lockHeld) await run();
  else await withInstanceInput(inst.containerName, run);
}

// 通过 xdotool 在实例容器内输入文字（绕过 VNC keysym 限制，解决中文 IME 吞字问题）。
// 用 base64 传递文本避免 shell 转义问题，xclip 写入剪贴板后 xdotool 模拟 Ctrl+V 粘贴。
// 服务端按键一律「先松开 xdotool 自己按住的修饰键，再按」，不用 --clearmodifiers（移植自上游 31c5146，#151）。
// --clearmodifiers 会在按键前松开当前按着的修饰键、按完再「恢复」。用户按 Ctrl+V 粘贴时，粘贴桥截下 V、服务端替他按
// Ctrl+V，这时用户往往还按着 Ctrl：xdotool 按完后用它自己的虚拟键盘（XTEST）把 Ctrl 按回去，而用户松手是从 VNC 键盘
// 来的，XTEST 这边的 Ctrl 就一直按着。下一次 xdotool 再按 Ctrl 被当成重复按键吞掉，应用收到的是光秃秃的 v——
// 粘完图片接着打中文，发出去的是「v」。先 keyup 一遍既能清掉这种残留（包括旧版本留下的），又不会再按回去。
// --delay 0 避免 xdotool 对 11 个修饰键逐个默认 sleep 12ms（提速 ~150ms，移植自上游 5400c86）。
export const XDO_RELEASE_MODS = 'xdotool keyup --delay 0 Control_L Control_R Shift_L Shift_R Alt_L Alt_R Meta_L Meta_R Super_L Super_R ISO_Level3_Shift';
const xdoKey = (key: string) => `${XDO_RELEASE_MODS}\nxdotool key ${key}`;

// 「锁定当前会话」：粘贴前先把焦点送进微信主窗口当前会话的输入框，不再依赖用户事先点好光标
// （焦点停在搜索框、消息列表或别的窗口时，Ctrl+V 和回车都会落空）。
// 主窗口 = class wechat、标题「微信」、尺寸像主窗口的最大那个（排除登录框、图片查看、小程序等）。
// 输入框在会话区底部、高度固定：点「窗口底边上方 80px、可见右缘左侧 200px」（避开右下角「发送」按钮），
// 再 Ctrl+End 把光标移到草稿末尾，粘贴内容总是追加在已有草稿之后。鼠标点完放回原处。
// 找不到主窗口或输入框不在屏幕内就报错退出，不盲发。
export const WECHAT_FOCUS_INPUT = [
  'read -r sw sh <<<"$(xdotool getdisplaygeometry)"',
  'best=0; main=""',
  "for c in $(xdotool search --onlyvisible --class '^wechat$' 2>/dev/null); do",
  '  case "$(xdotool getwindowname "$c" 2>/dev/null)" in 微信|Weixin|WeChat) ;; *) continue ;; esac',
  "  eval \"$(xdotool getwindowgeometry --shell \"$c\" | grep -E '^(X|Y|WIDTH|HEIGHT)=-?[0-9]+$')\"",
  '  [ "${WIDTH:-0}" -ge 600 ] && [ "${HEIGHT:-0}" -ge 400 ] || continue',
  '  [ $((WIDTH * HEIGHT)) -gt "$best" ] || continue',
  '  best=$((WIDTH * HEIGHT)); main=$c; mx=$X; my=$Y; mw=$WIDTH; mh=$HEIGHT',
  'done',
  '[ -n "$main" ] || { echo "未找到微信聊天窗口：请确认微信已登录、主窗口未最小化" >&2; exit 3; }',
  'right=$((mx + mw)); [ "$right" -le "$sw" ] || right=$sw',
  'cx=$((right - 200)); cy=$((my + mh - 80))',
  'if [ "$cx" -lt $((mx + 400)) ] || [ "$cy" -lt 0 ] || [ "$cy" -ge "$sh" ]; then',
  '  echo "微信输入框不在可视区域内：请把浏览器窗口放大后再发" >&2; exit 3',
  'fi',
  'eval "$(xdotool getmouselocation --shell | grep -E \'^(X|Y)=[0-9]+$\')"; ox=$X; oy=$Y',
  'xdotool windowactivate --sync "$main" >/dev/null 2>&1 || true',
  `${XDO_RELEASE_MODS}`,
  // 不用 mousemove --sync：xdotool 3.20160805（Debian bookworm）在指针已停在目标坐标时会空等 500×30ms=15s。
  'xdotool mousemove "$cx" "$cy"',
  'sleep 0.05',
  'xdotool click 1',
  'xdotool key ctrl+End',
  'xdotool mousemove "$ox" "$oy"',
].join('\n');

export interface TypeOptions {
  focusChat?: boolean; // 先锁定到微信当前会话的输入框（见 WECHAT_FOCUS_INPUT），仅微信实例有效
  clearFirst?: boolean; // 聚焦输入框后先全选清空（ctrl+a + BackSpace）再粘贴，防止残留旧草稿拼接
  send?: boolean; // 粘贴后回车发送（与粘贴同一次 exec，中间不会被别的输入插队）
  lockHeld?: boolean; // 调用方已通过 withInstanceInputLock 持有该实例输入锁，这里不再加锁
  killAfterSec?: number; // 容器内用 timeout 限时，超时即杀掉整组进程，保证不会在返回之后才触发按键
}

export async function typeInInstance(inst: Instance, text: string, opts: TypeOptions = {}): Promise<void> {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const focus = opts.focusChat && instanceAppType(inst) === 'wechat';
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xclip >/dev/null 2>&1 || { echo "xclip not installed in instance image" >&2; exit 127; }',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    // xclip -i 会 daemon 化常驻持有剪贴板选区，并继承 exec 的 stdout/stderr；不重定向的话 docker exec
    // 要等这俩 fd 关闭，实测每次卡 ~2s。重定向到 /dev/null 后台后，整条链路从 ~2.1s 降到 ~0.08s。
    `echo '${b64}' | base64 -d | xclip -selection clipboard -i >/dev/null 2>&1`,
    ...(focus ? [WECHAT_FOCUS_INPUT] : []),
    ...(opts.clearFirst ? [xdoKey('ctrl+a'), 'sleep 0.05', xdoKey('BackSpace'), 'sleep 0.05'] : []),
    xdoKey('ctrl+v'),
    // 粘贴时应用要向 xclip 取剪贴板，稍等再回车，免得回车抢在文字上屏之前
    ...(opts.send ? ['sleep 0.15', xdoKey('Return')] : []),
  ].join('\n');
  const run = async (): Promise<void> => {
    if (opts.killAfterSec) assertInputOk(await execInputScript(inst, cmd, [], opts.killAfterSec), '粘贴');
    else await execCapture(inst, ['bash', '-c', cmd]);
  };
  if (opts.lockHeld) await run();
  else await withInstanceInput(inst.containerName, run);
}

// 清空微信当前会话输入框（聚焦输入框后 ctrl+a + BackSpace，绝不按回车）。
export async function clearInputInInstance(inst: Instance, opts: { lockHeld?: boolean } = {}): Promise<void> {
  const focus = instanceAppType(inst) === 'wechat';
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    ...(focus ? [WECHAT_FOCUS_INPUT] : []),
    xdoKey('ctrl+a'),
    'sleep 0.05',
    xdoKey('BackSpace'),
  ].join('\n');
  const run = async (): Promise<void> => {
    assertInputOk(await execInputScript(inst, cmd, [], INPUT_KILL_AFTER_SEC), '清空输入框');
  };
  if (opts.lockHeld) await run();
  else await withInstanceInput(inst.containerName, run);
}

// 让调用方把「校验 + 输入」放进同一把实例输入锁里（锁不可重入：期间其它输入请求直接 409）。
export function withInstanceInputLock<T>(inst: Instance, operation: () => Promise<T>): Promise<T> {
  return withInstanceInput(inst.containerName, operation);
}

// 确认发送专用：校验微信主窗口仍是当前活动窗口后只按一次回车。不加锁，调用方必须已持有实例输入锁。
// 焦点被弹窗 / 其它窗口抢走时以 focus_mismatch 退出，此时确定没有按键发出。
export const SEND_RETURN_SCRIPT = [
  'set -eu',
  'display="${DISPLAY:-}"',
  'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
  'export DISPLAY="${display:-:1}"',
  'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
  'expected="$1"; check="$2"',
  'if [ "$check" = "1" ]; then',
  '  active="$(xdotool getactivewindow 2>/dev/null || true)"',
  '  if [ "$active" != "$expected" ]; then echo "focus_mismatch active=${active:-none} expected=$expected" >&2; exit 4; fi',
  'fi',
  xdoKey('Return'),
].join('\n');

export async function sendReturnInInstance(
  inst: Instance,
  expectedWindowId: string,
  opts: { focusCheck?: boolean } = {},
): Promise<void> {
  if (!/^[0-9]{1,20}$/.test(expectedWindowId)) throw new InputCommandError('input_precondition_failed', 'no', '微信主窗口 ID 非法');
  const res = await execInputScript(
    inst,
    SEND_RETURN_SCRIPT,
    ['woc-send-return', expectedWindowId, opts.focusCheck === false ? '0' : '1'],
    5,
  );
  assertInputOk(res, '发送回车');
}

// 通过 xdotool 在实例容器内模拟一次按键（如 Return / BackSpace）。
// 用于「无感输入」模式：中文经 xclip 转发期间，把被截下的回车/退格按序送出，保证顺序、避免抢跑。
// key 仅允许字母与下划线（xdotool keysym 名），杜绝注入。
export async function keyInInstance(inst: Instance, key: string): Promise<void> {
  if (key !== 'ctrl+v' && !/^[A-Za-z_]{1,20}$/.test(key)) throw new Error('按键名不合法');
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    xdoKey(key),
  ].join('\n');
  await withInstanceInput(inst.containerName, () => execCapture(inst, ['bash', '-c', cmd]));
}

// ---------- 数据卷管理（仅管理员；路由层用 requireAdmin 限制） ----------
// 数据卷 = 容器内 /config 持久卷，含微信全部数据（登录态、加密聊天库等）。提供浏览/上传/解压/下载/
// 改名/移动/删除 + 整卷备份/恢复。主要场景：把 PC 微信数据迁移上来、跨实例迁移、离线备份。
// 路径安全：所有相对路径经 safeVolPath 归一化并严格限制在 /config 内，禁止 .. 穿越。
const VOL_ROOT = '/config';

// 把用户给的相对路径安全解析为 /config 下的绝对路径；禁止 .. 与 NUL；剥离前导 /。
export function safeVolPath(rel: string): string {
  const raw = (rel ?? '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw new Error('路径不合法');
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error('路径不合法（禁止 ..）');
    parts.push(seg);
  }
  return parts.length ? `${VOL_ROOT}/${parts.join('/')}` : VOL_ROOT;
}
const relOf = (abs: string): string => (abs === VOL_ROOT ? '' : abs.slice(VOL_ROOT.length + 1));

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number; // epoch ms
}

// 列目录（仅一层）。dirs/files 混合返回，前端排序。
export async function listVolume(inst: Instance, rel: string): Promise<{ path: string; entries: VolEntry[] }> {
  const abs = safeVolPath(rel);
  // GNU find -printf：%y 类型(d/f/l) \t %s 大小 \t %T@ mtime(秒.纳秒) \t %f 名字。argv 直传不经 shell，名字含空格/引号也安全。
  const out = await execCapture(inst, [
    'find', abs, '-maxdepth', '1', '-mindepth', '1', '-printf', '%y\\t%s\\t%T@\\t%f\\n',
  ]);
  const entries: VolEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const i1 = line.indexOf('\t');
    const i2 = line.indexOf('\t', i1 + 1);
    const i3 = line.indexOf('\t', i2 + 1);
    if (i1 < 0 || i2 < 0 || i3 < 0) continue;
    const y = line.slice(0, i1);
    entries.push({
      type: y === 'd' ? 'dir' : y === 'f' ? 'file' : y === 'l' ? 'link' : 'other',
      size: Number(line.slice(i1 + 1, i2)) || 0,
      mtime: Math.round(parseFloat(line.slice(i2 + 1, i3)) * 1000) || 0,
      name: line.slice(i3 + 1),
    });
  }
  return { path: relOf(abs), entries };
}

export async function volMkdir(inst: Instance, rel: string): Promise<void> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('路径不合法');
  await execCapture(inst, ['mkdir', '-p', abs]);
}

export async function volMove(inst: Instance, fromRel: string, toRel: string): Promise<void> {
  const from = safeVolPath(fromRel);
  const to = safeVolPath(toRel);
  if (from === VOL_ROOT || to === VOL_ROOT) throw new Error('不能移动数据卷根目录');
  if (from === to) return;
  await execCapture(inst, ['mv', '-f', from, to]);
}

export async function volDelete(inst: Instance, rel: string): Promise<void> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('不能删除数据卷根目录');
  await execCapture(inst, ['rm', '-rf', abs]);
}

// 上传单个文件到指定目录（tar 头写 uid/gid 1000，落地即 abc 属主，微信可读）。流式写入，见 putFileStream。
export async function volUploadFile(inst: Instance, rel: string, name: string, size: number, body: AsyncIterable<Buffer>): Promise<void> {
  await putFileStream(inst, safeVolPath(rel), name, size, body);
}

// 上传的压缩包（已暂存在面板数据目录）写进实例前的整体校验：格式对、没被截断、gzip 没坏、路径不越出目标目录、
// 没有设备文件；整卷恢复还要求所有条目都在 config/ 下（本系统备份的格式）。此前不校验直接解到容器根目录，
// 传错了包（比如把 PC 微信文件夹的压缩包当备份传上去）就散落进容器的系统目录。
// 返回解压后普通文件的总字节数，用来预先检查目标盘空间。
export interface ArchiveInfo {
  gzip: boolean;
  bytes: number;
  tops: string[] | null; // 解出来的顶层条目名（解压后改属主用）；太多时为 null
}
export async function volCheckArchive(path: string, mode: 'extract' | 'restore'): Promise<ArchiveInfo> {
  const kind = await sniffArchive(path);
  if (kind === 'zip') throw new Error('暂不支持 zip，请打包成 .tar 或 .tar.gz 后再上传');
  if (kind === 'other') throw new Error('不是 .tar / .tar.gz 压缩包（或文件已损坏）');
  const gzip = kind === 'gzip';
  let entries = 0;
  let bytes = 0;
  const tops = new Set<string>();
  let manyTops = false;
  await scanArchive(path, gzip, (e) => {
    entries++;
    const segs = e.name.split('/').filter((x) => x && x !== '.');
    if (segs.length && !manyTops) {
      tops.add(segs[0]);
      if (tops.size > 200) manyTops = true;
    }
    if (segs.includes('..') || (e.type === '1' && e.linkname.split('/').includes('..'))) {
      throw new Error(`压缩包里有越出目标目录的路径（${e.name}），已拒绝`);
    }
    if (e.type === '3' || e.type === '4' || e.type === '6') throw new Error(`压缩包里有设备文件或管道（${e.name}），已拒绝`);
    if (mode === 'restore' && segs[0] !== 'config') {
      throw new Error(`这不是本系统导出的整卷备份：「${e.name}」不在 config/ 目录下。要导入别处的数据请用「上传并解压」`);
    }
    bytes += e.size;
  });
  if (!entries) throw new Error('压缩包是空的');
  return { gzip, bytes, tops: manyTops ? null : [...tops] };
}

// 上传压缩包并解压到指定目录（PC 微信数据迁移：用户把文件夹打成 .tar/.tar.gz 上传）。
// putArchive 把 tar 内容解到 dir 下，Docker 解包限制在 dir 内、防 .. 穿越。gzip 在面板里流式解开。
export async function volExtractArchive(inst: Instance, rel: string, archivePath: string, info: ArchiveInfo): Promise<void> {
  const dir = safeVolPath(rel);
  await execCapture(inst, ['mkdir', '-p', dir]).catch((e) => {
    throw friendlyWriteError(e);
  });
  await assertFreeSpace(inst, dir, info.bytes);
  const tar = openTarStream(archivePath, info.gzip);
  try {
    await putArchiveStream(inst, tar, dir);
  } catch (e) {
    throw friendlyWriteError(e);
  } finally {
    tar.destroy();
  }
  // putArchive 按压缩包里记录的属主落地：在 NAS 上用 root 打的包解出来是 root，Mac 上打的是 501。应用以 abc 运行，
  // 写不了这些文件——迁移过来的微信数据库打不开 / 写不进去。解完把这次解出来的东西改成 abc（-h：符号链接只改它自己，
  // 不跟过去）；实例的设备标识文件 .woc-machine-id 本来就属于 root，不动。
  const own = ['chown', '-R', '-h', 'abc:abc', '--'];
  let run: string[] | null;
  if (info.tops) {
    const paths = info.tops.filter((t) => !(dir === VOL_ROOT && t === '.woc-machine-id')).map((t) => `${dir}/${t}`);
    run = paths.length ? [...own, ...paths] : null;
  } else if (dir === VOL_ROOT) {
    // 顶层条目太多（>200）没记全：卷根下除设备标识外全部改一遍（卷里本来就都该是 abc 的）
    run = ['find', VOL_ROOT, '-mindepth', '1', '-maxdepth', '1', '!', '-name', '.woc-machine-id', '-exec', ...own.slice(0, -1), '{}', '+'];
  } else {
    run = [...own, dir];
  }
  if (run) {
    await execCapture(inst, run, 'root').catch((e) => {
      throw new Error(`文件已解压，但没能把属主改成应用用户（${e?.message || e}），应用可能改不了这些文件，请重试`);
    });
  }
}

export async function volDownloadFile(inst: Instance, rel: string): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('不能下载整个根目录，请用整卷备份');
  return streamRegularFile(inst, abs);
}

// 整卷备份：把 /config 打成 tar 流并经 gzip 输出（路由直接 pipe 给响应，避免大文件入内存）。
// getArchive('/config') 的条目前缀为 config/，恢复时解到容器根即可落回 /config。
export async function volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream> {
  const tar = (await docker.getContainer(inst.containerName).getArchive({ path: VOL_ROOT })) as NodeJS.ReadableStream;
  const gzip = zlib.createGzip();
  tar.on('error', (e) => gzip.destroy(e as Error));
  return tar.pipe(gzip);
}

// 整卷恢复：仅适用于本系统导出的备份（条目前缀 config/），解到容器根 → 落回 /config。
// 写之前先停掉实例、写完再启动（原本在运行的话）：此前在微信运行时直接覆盖它正开着的数据库文件，
// 容易把聊天库写坏，而且界面上只是提示「恢复后请重启」。停止期间 docker 照样能往卷里写（docker cp 同理）。
// 与重启 / 升级 / 自愈共用同一把生命周期锁，恢复中途不会被别的操作把容器拉起来。
export async function volRestoreArchive(
  inst: Instance,
  archivePath: string,
  info: { gzip: boolean; bytes: number },
  onStage: (stage: string) => void,
): Promise<void> {
  await withLifecycle(inst.id, async () => {
    const c = docker.getContainer(inst.containerName);
    const state: any = await c.inspect().catch(() => null);
    if (!state) throw new Error('实例容器不存在：请先在卡片上启动一次实例，再恢复');
    const wasRunning = !!state.State?.Running;
    if (wasRunning) {
      onStage('停止实例');
      try {
        await c.stop({ t: 10 } as any);
      } catch (e: any) {
        if (e?.statusCode !== 304) throw e; // 304 = 已经停了
      }
      appendInstanceLog(inst.id, '整卷恢复：已停止实例，开始写入备份');
    }
    const tar = openTarStream(archivePath, info.gzip);
    try {
      onStage('写入数据');
      await putArchiveStream(inst, tar, '/');
      appendInstanceLog(inst.id, '整卷恢复：备份已写入');
    } catch (e) {
      appendInstanceLog(inst.id, `整卷恢复失败：${(e as any)?.message || e}`);
      throw friendlyWriteError(e);
    } finally {
      tar.destroy();
      if (wasRunning) {
        onStage('启动实例');
        await c.start().catch((e: any) => {
          if (e?.statusCode !== 304) appendInstanceLog(inst.id, `整卷恢复后启动实例失败：${e?.message || e}`);
        });
      }
    }
  });
}

// ---------- 桌面壁纸 ----------
const BG_DIR = '/config/backgrounds';
const WP_FILE = '/config/.wallpaper';

export async function listBackgrounds(inst: Instance): Promise<string[]> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `ls -1 ${BG_DIR} 2>/dev/null || true`]);
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

// 注：不再用 ImageMagick(convert) 生成缩略图（凭空胖 ~100MB + 引入注入点），直接回原图，前端按需缩放。
// thumb 参数保留以兼容调用方，忽略之。
export async function getBackgroundImage(inst: Instance, name: string, _thumb = false): Promise<Buffer> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  const path = `${BG_DIR}/${name}`;
  const stream = (await docker.getContainer(inst.containerName).getArchive({ path })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return extractSingleFileFromTar(Buffer.concat(chunks));
}

export async function uploadBackground(inst: Instance, name: string, content: Buffer): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['mkdir', '-p', BG_DIR]);
  await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: BG_DIR });
}

export async function applyBackground(inst: Instance, name: string): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['sh', '-c', `DISPLAY=:1 xwallpaper --zoom '${BG_DIR}/${name}' 2>/dev/null`]);
  await execCapture(inst, ['sh', '-c', `echo '${name}' > '${WP_FILE}'`]);
}

export async function deleteBackground(inst: Instance, name: string): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['rm', '-f', `${BG_DIR}/${name}`]);
  await execCapture(inst, ['sh', '-c', `if [ -f '${WP_FILE}' ] && [ "$(cat '${WP_FILE}')" = '${name}' ]; then rm -f '${WP_FILE}'; fi`]);
}

export async function getCurrentBackground(inst: Instance): Promise<string> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `cat ${WP_FILE} 2>/dev/null || true`]);
    return out.trim();
  } catch { return ''; }
}

export async function clearBackground(inst: Instance): Promise<void> {
  await execCapture(inst, ['sh', '-c', 'DISPLAY=:1 xsetroot -solid black 2>/dev/null']);
  await execCapture(inst, ['rm', '-f', WP_FILE]);
}

// ---------- 字体管理 ----------
const FONT_DIR = '/config/.fonts';

export async function listFonts(inst: Instance): Promise<string[]> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `ls -1 ${FONT_DIR} 2>/dev/null || true`]);
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

export async function uploadFont(inst: Instance, name: string, content: Buffer): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['mkdir', '-p', FONT_DIR]);
  await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: FONT_DIR });
  await execCapture(inst, ['fc-cache', '-f'], 'root');
}

export async function deleteFont(inst: Instance, name: string): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['rm', '-f', `${FONT_DIR}/${name}`]);
  await execCapture(inst, ['fc-cache', '-f'], 'root');
}

const FONT_SEL_FILE = '/config/.woc-font';

// 将字体的 fontconfig family name 设为用户首选（fallback 仍用文泉驿等系统字体）。
// 设空字符串或 "default" 则清除偏好，回退系统默认。
export async function applyFont(inst: Instance, fontFile: string): Promise<void> {
  if (fontFile && !safeMediaName(fontFile)) throw new Error('文件名不合法');
  if (fontFile && fontFile !== 'default') {
    // 用 fc-scan 读取字体实际 family name（取第一个）
    const out = await execCapture(inst, ['sh', '-c', `fc-scan --format='%{family[0]}' '${FONT_DIR}/${fontFile}' 2>/dev/null`]);
    const family = out.trim();
    if (!family) throw new Error('未能识别该字体的 family name');
    // 写 fontconfig 系统级配置（/etc/fonts/local.conf 保证被读取，用户级可能被 XDG 路径问题跳过）
    const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <!-- generic families -->
  <alias>
    <family>sans-serif</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>serif</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>monospace</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <!-- system CJK fonts that WeChat/CEF may request -->
  <alias>
    <family>WenQuanYi Micro Hei</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>WenQuanYi Zen Hei</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>Noto Sans CJK SC</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>Noto Sans CJK</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <!-- force user font for any zh text regardless of requested family -->
  <match target="pattern">
    <test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>${family}</string></edit>
  </match>
</fontconfig>`;
    await execCapture(inst, ['bash', '-c', `cat > /etc/fonts/local.conf << 'CONF'\n${xml}\nCONF`], 'root');
    execCapture(inst, ['bash', '-c', `cat > /config/.woc-fc-local.conf << 'CONF'\n${xml}\nCONF`], 'root').catch(() => {});
    await execCapture(inst, ['fc-cache', '-f'], 'root');
    await execCapture(inst, ['sh', '-c', `echo '${fontFile}' > ${FONT_SEL_FILE}`]);
    await execCapture(inst, ['bash', '-c', `cat > ${FONT_SEL_FILE}-family << 'FAMILYEOF'\n${family}\nFAMILYEOF`]);
    // 更新 xsettingsd 配置 → GTK/Qt 应用实时响应
    applyXsettingsFont(inst, family).catch(() => {});
  } else {
    // 清除偏好，回退默认（文泉驿等系统字体）
    await execCapture(inst, ['rm', '-f', '/etc/fonts/local.conf', '/config/.woc-fc-local.conf'], 'root');
    await execCapture(inst, ['rm', '-f', '/config/.config/fontconfig/fonts.conf']);
    await execCapture(inst, ['fc-cache', '-f'], 'root');
    await execCapture(inst, ['rm', '-f', FONT_SEL_FILE, `${FONT_SEL_FILE}-family`]);
    applyXsettingsFont(inst, 'WenQuanYi Micro Hei').catch(() => {});
  }
}

async function applyXsettingsFont(inst: Instance, family: string): Promise<void> {
  const conf = '/config/.xsettingsd';
  const lines = [
    'Xft/Antialias 1',
    'Xft/Hinting 1',
    'Xft/HintStyle "hintslight"',
    'Xft/RGBA "rgb"',
    // XSETTINGS uses DPI * 1024: 96 DPI = 98304.
    'Xft/DPI 98304',
    `Gtk/FontName "${family} 10"`,
  ];
  await execCapture(inst, ['sh', '-c', `printf '%s\\n' ${lines.map(l => `'${l}'`).join(' ')} > ${conf}`]);
  await execCapture(inst, ['sh', '-c', 'pkill -HUP xsettingsd 2>/dev/null || xsettingsd --config=/config/.xsettingsd 2>/dev/null &']);
}

// 返回当前选中的字体文件名，空字符串表示默认
export async function getAppliedFont(inst: Instance): Promise<string> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `cat ${FONT_SEL_FILE} 2>/dev/null || true`]);
    return out.trim();
  } catch { return ''; }
}

export async function getFontFamily(inst: Instance, fontFile: string): Promise<string> {
  if (!safeMediaName(fontFile)) throw new Error('文件名不合法');
  try {
    const out = await execCapture(inst, ['sh', '-c', `fc-scan '${FONT_DIR}/${fontFile}' 2>/dev/null | grep 'family:' | head -1 | cut -d'"' -f2`]);
    return out.trim();
  } catch { return ''; }
}

// 容器重建后从挂载卷恢复字体配置 & xsettingsd（不依赖 autostart 镜像版本）
async function restoreFontFromVolume(inst: Instance): Promise<void> {
  await execCapture(inst, ['bash', '-c', 'if [ -f /config/.woc-fc-local.conf ]; then cp /config/.woc-fc-local.conf /etc/fonts/local.conf && fc-cache -f; fi'], 'root').catch(() => {});
  const famOut = await execCapture(inst, ['sh', '-c', 'cat /config/.woc-font-family 2>/dev/null || true']).catch(() => '');
  const family = famOut.trim();
  if (family) applyXsettingsFont(inst, family).catch(() => {});
}

// 实例容器名（供反代构造 target）。
export function instanceTarget(inst: Instance): string {
  return `http://${inst.containerName}:3000`;
}

// ---------- 只读 MCP 辅助能力（docker ping / X11 窗口信息 / 内存 PNG 截屏） ----------
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024; // 4 MiB 硬上限，防大帧撑爆内存

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WechatWindowRect extends WindowRect {
  id: string;
  title: string;
}

export interface WechatWindowInfo {
  display: string;
  displayWidth: number;
  displayHeight: number;
  wechatWindow: WechatWindowRect | null;
}

export interface ScreenshotCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  maxWidth?: number; // 默认 1280；0 表示原生分辨率不缩放
  crop?: ScreenshotCrop; // 原生屏幕坐标，按显示尺寸裁剪
}

export interface ScreenshotResult {
  png: Buffer;
  displayWidth: number;
  displayHeight: number;
  imageWidth: number;
  imageHeight: number;
  maxWidth: number;
  crop: ScreenshotCrop | null;
  wechatWindow: WechatWindowRect | null;
  bytes: number;
  durationMs: number;
}

// 探测 docker-socket-proxy / Docker daemon 连通性（只读 ping，不抛错）。
export async function dockerHealthy(timeoutMs = 3000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      docker.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('docker ping timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 解析 PNG IHDR 宽高并校验 PNG 魔数（前 24 字节）。
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('截屏输出不是有效的 PNG 图片');
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG 缺少 IHDR 头');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error(`PNG 尺寸非法：${width}x${height}`);
  }
  return { width, height };
}

// 校验并按屏幕边界裁剪截屏区域（原生像素坐标）。
export function clampScreenshotCrop(
  crop: ScreenshotCrop,
  displayWidth: number,
  displayHeight: number,
): ScreenshotCrop {
  if (
    !crop ||
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height)
  ) {
    throw new Error('crop 参数必须是有限数字 { x, y, width, height }');
  }
  if (crop.width <= 0 || crop.height <= 0) {
    throw new Error('crop 的 width 和 height 必须大于 0');
  }
  const x = Math.min(Math.max(0, Math.round(crop.x)), displayWidth - 1);
  const y = Math.min(Math.max(0, Math.round(crop.y)), displayHeight - 1);
  const width = Math.min(Math.max(1, Math.round(crop.width)), displayWidth - x);
  const height = Math.min(Math.max(1, Math.round(crop.height)), displayHeight - y);
  return { x, y, width, height };
}

// 解析 WECHAT_WINDOW_INFO_SCRIPT 输出。
export function parseWechatWindowInfo(raw: string): WechatWindowInfo {
  let display = ':1';
  let displayWidth = 0;
  let displayHeight = 0;
  let wechatWindow: WechatWindowRect | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (trimmed.startsWith('DISPLAY\t')) {
      const parts = trimmed.split('\t');
      if (parts.length >= 4) {
        display = parts[1] || ':1';
        displayWidth = Number(parts[2]) || 0;
        displayHeight = Number(parts[3]) || 0;
      }
    } else if (trimmed.startsWith('WINDOW\t')) {
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        const x = Number(parts[2]);
        const y = Number(parts[3]);
        const width = Number(parts[4]);
        const height = Number(parts[5]);
        if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
          wechatWindow = {
            id: parts[1],
            x,
            y,
            width,
            height,
            title: parts.slice(6).join('\t'),
          };
        }
      }
    }
  }

  if (displayWidth <= 0 || displayHeight <= 0) {
    throw new Error('无法获取实例 X11 显示分辨率');
  }
  return { display, displayWidth, displayHeight, wechatWindow };
}

const WECHAT_WINDOW_INFO_SCRIPT = [
  'set -eu',
  'display="${DISPLAY:-}"',
  'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
  'export DISPLAY="${display:-:1}"',
  'sw=""; sh=""',
  'if command -v xdotool >/dev/null 2>&1; then read -r sw sh <<<"$(xdotool getdisplaygeometry 2>/dev/null || true)"; fi',
  'if [ -z "$sw" ] || [ -z "$sh" ]; then',
  '  read -r sw sh <<<"$(xdpyinfo 2>/dev/null | awk \'/dimensions:/ {split($2,a,"x"); print a[1], a[2]; exit}\')"',
  'fi',
  'printf "DISPLAY\\t%s\\t%s\\t%s\\n" "$DISPLAY" "${sw:-0}" "${sh:-0}"',
  'if command -v xdotool >/dev/null 2>&1; then',
  '  best_pref=0; best_area=0; best_id=""; best_x=0; best_y=0; best_w=0; best_h=0; best_title=""',
  '  ids="$(xdotool search --onlyvisible --class \'^wechat$\' 2>/dev/null || xdotool search --onlyvisible --class \'wechat\' 2>/dev/null || true)"',
  '  for c in $ids; do',
  '    X=0; Y=0; WIDTH=0; HEIGHT=0',
  '    eval "$(xdotool getwindowgeometry --shell "$c" 2>/dev/null | grep -E \'^(X|Y|WIDTH|HEIGHT)=-?[0-9]+$\' || true)"',
  '    [ "${WIDTH:-0}" -gt 0 ] && [ "${HEIGHT:-0}" -gt 0 ] || continue',
  '    title="$(xdotool getwindowname "$c" 2>/dev/null | tr \'\\r\\n\\t\' \'   \' || true)"',
  '    pref=0',
  '    case "$title" in 微信|Weixin|WeChat) pref=1 ;; esac',
  '    area=$((WIDTH * HEIGHT))',
  '    if [ "$pref" -gt "$best_pref" ] || { [ "$pref" -eq "$best_pref" ] && [ "$area" -gt "$best_area" ]; }; then',
  '      best_pref=$pref; best_area=$area; best_id=$c; best_x=$X; best_y=$Y; best_w=$WIDTH; best_h=$HEIGHT; best_title=$title',
  '    fi',
  '  done',
  '  if [ -n "$best_id" ]; then',
  '    printf "WINDOW\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$best_id" "$best_x" "$best_y" "$best_w" "$best_h" "$best_title"',
  '  fi',
  'fi',
].join('\n');

// 查询运行中实例的 X11 显示尺寸与微信主窗口几何信息（只读，不启动容器）。
export async function wechatWindowInfo(inst: Instance): Promise<WechatWindowInfo> {
  const out = await execCapture(inst, ['bash', '-c', WECHAT_WINDOW_INFO_SCRIPT], 'abc', 8000);
  return parseWechatWindowInfo(out);
}

// 收集 docker exec 多路复用流中的原始 stdout 字节（供 execCaptureBuffer 使用并可独立单测）。
// 关键：在 TCP docker-socket-proxy 上，hijacked socket 往往在 'end' 后立即触发 'close'，
// 此时 exec.inspect() 仍在异步等待中；必须同步置 ended=true，避免 'close' 误判为异常中断。
export function collectDemuxedStream(
  stream: NodeJS.EventEmitter & { destroy: () => void },
  demux: (
    s: any,
    stdout: { write: (b: Buffer) => void },
    stderr: { write: (b: Buffer) => void },
  ) => void,
  inspectExec: () => Promise<{ Running?: boolean; ExitCode?: number | null }>,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const maxBytes = opts.maxBytes ?? MAX_SCREENSHOT_BYTES;
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let ended = false;
    let totalBytes = 0;
    const outChunks: Buffer[] = [];
    let err = '';
    const errDecoder = new StringDecoder('utf8');

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream.destroy();
      reject(e);
    };

    const timer = timeoutMs
      ? setTimeout(() => fail(new Error('截屏执行超时')), timeoutMs)
      : undefined;

    const stdout = {
      write: (b: Buffer) => {
        if (settled) return;
        totalBytes += b.length;
        if (totalBytes > maxBytes) {
          fail(new Error(`截屏结果超出上限（>${maxBytes} 字节）`));
          return;
        }
        outChunks.push(Buffer.from(b));
      },
    };
    const stderr = {
      write: (b: Buffer) => {
        if (err.length < 4096) err += errDecoder.write(b);
      },
    };

    demux(stream, stdout, stderr);
    stream.on('close', () => {
      if (!ended && !settled) fail(new Error('截屏连接异常中断'));
    });
    stream.on('end', async () => {
      ended = true;
      if (settled) return;
      err += errDecoder.end();
      try {
        const info = await inspectExec();
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (info.Running || info.ExitCode == null) {
          reject(new Error('无法确认截屏进程已结束'));
          return;
        }
        if (info.ExitCode !== 0) {
          reject(new Error((err || `截屏命令失败，退出码 ${info.ExitCode}`).trim()));
          return;
        }
        resolve(Buffer.concat(outChunks));
      } catch (e: any) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    stream.on('error', (e: any) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

// 在实例容器内执行命令并直接收集原始二进制 stdout（用于内存截屏，带超时和字节上限）。
async function execCaptureBuffer(
  inst: Instance,
  cmd: string[],
  user = 'abc',
  timeoutMs = 10000,
  maxBytes = MAX_SCREENSHOT_BYTES,
): Promise<Buffer> {
  const c = docker.getContainer(inst.containerName);
  const exec = await execCreate(c, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: user });
  const stream = await exec.start({ hijack: true, stdin: false });
  return collectDemuxedStream(
    stream,
    (s, stdout, stderr) => docker.modem.demuxStream(s, stdout as any, stderr as any),
    () => exec.inspect(),
    { timeoutMs, maxBytes },
  );
}

// ---------- 受控输入脚本执行（限时必杀 + 区分「确定没执行」与「结果未知」） ----------
export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// dispatched='no'：确定没有任何点击 / 滚轮 / 按键发出；'unknown'：可能已部分执行。
export class InputCommandError extends Error {
  readonly code: 'input_timeout' | 'focus_mismatch' | 'input_precondition_failed' | 'input_failed';
  readonly dispatched: 'no' | 'unknown';

  constructor(code: InputCommandError['code'], dispatched: InputCommandError['dispatched'], message: string) {
    super(message);
    this.name = 'InputCommandError';
    this.code = code;
    this.dispatched = dispatched;
  }
}

export const INPUT_KILL_AFTER_SEC = 8;
// 脚本内约定的「前置条件不满足」退出码：这些分支都在第一个点击 / 按键之前退出。
// 3=找不到微信主窗口或输入框不可见；4=活动窗口不是微信主窗口；5=指针未到达目标坐标；127=缺少命令。
const INPUT_PRECONDITION_EXIT_CODES = new Set([3, 4, 5, 127]);

// 收集 docker exec 的退出码与输出：非零退出码不抛错，交给 assertInputOk 判定。
export function collectScriptResult(
  stream: NodeJS.EventEmitter & { destroy: () => void },
  demux: (
    s: any,
    stdout: { write: (b: Buffer) => void },
    stderr: { write: (b: Buffer) => void },
  ) => void,
  inspectExec: () => Promise<{ Running?: boolean; ExitCode?: number | null }>,
  opts: { timeoutMs: number },
): Promise<ScriptResult> {
  return new Promise<ScriptResult>((resolve, reject) => {
    let settled = false;
    let ended = false;
    let out = '';
    let err = '';
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('命令结果未知：执行超时')), opts.timeoutMs);

    demux(
      stream,
      { write: (b: Buffer) => { if (out.length < 4096) out += outDecoder.write(b); } },
      { write: (b: Buffer) => { if (err.length < 4096) err += errDecoder.write(b); } },
    );
    stream.on('close', () => {
      if (!ended) fail(new Error('命令结果未知：连接关闭'));
    });
    stream.on('end', async () => {
      ended = true;
      if (settled) return;
      try {
        const info = await inspectExec();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (info.Running || info.ExitCode == null) {
          reject(new Error('命令结果未知：无法确认执行已结束'));
          return;
        }
        resolve({ exitCode: info.ExitCode, stdout: out + outDecoder.end(), stderr: err + errDecoder.end() });
      } catch (e: any) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    stream.on('error', (e: any) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

// 在实例容器内以 `timeout -k 1 N bash -c script` 执行输入脚本：超过 N 秒整组进程被 SIGTERM（再 1 秒 SIGKILL），
// 所以调用返回之后不会再有迟到的点击 / 按键；面板侧超时比容器内再多留 3 秒。
async function execInputScript(
  inst: Instance,
  script: string,
  args: string[],
  killAfterSec: number,
): Promise<ScriptResult> {
  const c = docker.getContainer(inst.containerName);
  const cmd = ['timeout', '-k', '1', String(killAfterSec), 'bash', '-c', script, ...args];
  const exec = await execCreate(c, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: 'abc' });
  const stream = await exec.start({ hijack: true, stdin: false });
  return collectScriptResult(
    stream,
    (s, stdout, stderr) => docker.modem.demuxStream(s, stdout as any, stderr as any),
    () => exec.inspect(),
    { timeoutMs: (killAfterSec + 3) * 1000 },
  );
}

export function assertInputOk(res: ScriptResult, what: string): void {
  if (res.exitCode === 0) return;
  const detail = (res.stderr || res.stdout).trim().slice(0, 300);
  if (res.exitCode === 124 || res.exitCode === 137) {
    throw new InputCommandError(
      'input_timeout',
      'unknown',
      `${what}超时：容器内进程已被终止，不会延迟触发；是否已部分执行未知`,
    );
  }
  if (INPUT_PRECONDITION_EXIT_CODES.has(res.exitCode)) {
    throw new InputCommandError(
      res.exitCode === 4 ? 'focus_mismatch' : 'input_precondition_failed',
      'no',
      detail || `${what}前置条件不满足（退出码 ${res.exitCode}）`,
    );
  }
  throw new InputCommandError('input_failed', 'unknown', detail || `${what}失败（退出码 ${res.exitCode}）`);
}

const SCREENSHOT_CAPTURE_SCRIPT = [
  'set -eu',
  'display="$1"; cap_w="$2"; cap_h="$3"; cap_x="$4"; cap_y="$5"; scale_w="$6"',
  'export DISPLAY="$display"',
  'command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not installed in instance image" >&2; exit 127; }',
  'if [ "$scale_w" -gt 0 ] && [ "$cap_w" -gt "$scale_w" ]; then',
  '  exec ffmpeg -loglevel error -f x11grab -video_size "${cap_w}x${cap_h}" -i "${display}+${cap_x},${cap_y}" -vframes 1 -vf "scale=${scale_w}:-1" -f image2pipe -vcodec png -',
  'else',
  '  exec ffmpeg -loglevel error -f x11grab -video_size "${cap_w}x${cap_h}" -i "${display}+${cap_x},${cap_y}" -vframes 1 -f image2pipe -vcodec png -',
  'fi',
].join('\n');

// 内存截屏：单次 docker exec 经 ffmpeg x11grab 输出 PNG 流，不落盘、不打印图片内容。
export async function captureInstanceScreenshot(
  inst: Instance,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const t0 = Date.now();
  const winInfo = await wechatWindowInfo(inst);
  const clampedCrop = opts.crop
    ? clampScreenshotCrop(opts.crop, winInfo.displayWidth, winInfo.displayHeight)
    : null;
  const rect = clampedCrop ?? { x: 0, y: 0, width: winInfo.displayWidth, height: winInfo.displayHeight };
  const maxWidth = opts.maxWidth === undefined ? 1280 : Math.max(0, Math.round(opts.maxWidth));
  if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
    throw new Error('实例 DISPLAY 名称非法');
  }

  const png = await execCaptureBuffer(
    inst,
    [
      'bash',
      '-c',
      SCREENSHOT_CAPTURE_SCRIPT,
      'woc-screenshot',
      winInfo.display,
      String(rect.width),
      String(rect.height),
      String(rect.x),
      String(rect.y),
      String(maxWidth),
    ],
    'abc',
    10000,
    MAX_SCREENSHOT_BYTES,
  );

  const dims = parsePngDimensions(png);
  return {
    png,
    displayWidth: winInfo.displayWidth,
    displayHeight: winInfo.displayHeight,
    imageWidth: dims.width,
    imageHeight: dims.height,
    maxWidth,
    crop: clampedCrop,
    wechatWindow: winInfo.wechatWindow,
    bytes: png.length,
    durationMs: Date.now() - t0,
  };
}

// ---------- 受控写操作 MCP 辅助能力（点击 / 滚动 / 会话指纹） ----------
export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export class DisplaySizeMismatchError extends Error {
  readonly code = 'display_size_mismatch';
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly actualWidth: number;
  readonly actualHeight: number;

  constructor(expectedWidth: number, expectedHeight: number, actualWidth: number, actualHeight: number) {
    super(
      `显示分辨率已变化：预期 ${expectedWidth}x${expectedHeight}，当前实际 ${actualWidth}x${actualHeight}`,
    );
    this.name = 'DisplaySizeMismatchError';
    this.expectedWidth = expectedWidth;
    this.expectedHeight = expectedHeight;
    this.actualWidth = actualWidth;
    this.actualHeight = actualHeight;
  }
}

export interface ClickOptions {
  x: number;
  y: number;
  displayWidth: number;
  displayHeight: number;
  button?: MouseButton;
  doubleClick?: boolean;
}

export interface ScrollOptions {
  x: number;
  y: number;
  displayWidth: number;
  displayHeight: number;
  direction: ScrollDirection;
  clicks?: number;
}

// 移动指针后核对落点再点击。不用 `mousemove --sync`：xdotool 3.20160805（Debian bookworm）的 --sync 是
// 「等指针离开原位置」，指针本来就在目标坐标时会空等 500×30ms=15s —— 同一坐标连续两次点击 / 滚动必然超时。
const MOVE_POINTER_LINES = [
  'xdotool mousemove "$x" "$y"',
  'sleep 0.05',
  'X=""; Y=""',
  'eval "$(xdotool getmouselocation --shell | grep -E \'^(X|Y)=[0-9]+$\')"',
  'if [ "$X" != "$x" ] || [ "$Y" != "$y" ]; then echo "pointer_not_at_target actual=${X:-?},${Y:-?} target=$x,$y" >&2; exit 5; fi',
];

export const CLICK_SCRIPT = [
  'set -eu',
  'display="$1"; x="$2"; y="$3"; btn="$4"; dbl="$5"',
  'export DISPLAY="$display"',
  'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
  XDO_RELEASE_MODS,
  ...MOVE_POINTER_LINES,
  'if [ "$dbl" = "1" ]; then',
  '  xdotool click --repeat 2 --delay 80 "$btn"',
  'else',
  '  xdotool click "$btn"',
  'fi',
].join('\n');

export const SCROLL_SCRIPT = [
  'set -eu',
  'display="$1"; x="$2"; y="$3"; btn="$4"; clicks="$5"',
  'export DISPLAY="$display"',
  'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
  XDO_RELEASE_MODS,
  ...MOVE_POINTER_LINES,
  'xdotool click --repeat "$clicks" --delay 40 "$btn"',
].join('\n');

const MOUSE_BUTTON_MAP: Record<MouseButton, string> = {
  left: '1',
  middle: '2',
  right: '3',
};

const SCROLL_BUTTON_MAP: Record<ScrollDirection, string> = {
  up: '4',
  down: '5',
  left: '6',
  right: '7',
};

export async function clickInInstance(
  inst: Instance,
  opts: ClickOptions,
): Promise<{ displayWidth: number; displayHeight: number }> {
  const btn = MOUSE_BUTTON_MAP[opts.button ?? 'left'];
  if (!btn) throw new Error('鼠标按键名不合法');
  return withInstanceInput(inst.containerName, async () => {
    const winInfo = await wechatWindowInfo(inst);
    if (winInfo.displayWidth !== opts.displayWidth || winInfo.displayHeight !== opts.displayHeight) {
      throw new DisplaySizeMismatchError(
        opts.displayWidth,
        opts.displayHeight,
        winInfo.displayWidth,
        winInfo.displayHeight,
      );
    }
    const x = Math.round(opts.x);
    const y = Math.round(opts.y);
    if (x < 0 || x >= winInfo.displayWidth || y < 0 || y >= winInfo.displayHeight) {
      throw new Error(`点击坐标越界：(${x}, ${y}) 超出 ${winInfo.displayWidth}x${winInfo.displayHeight}`);
    }
    if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
      throw new Error('实例 DISPLAY 名称非法');
    }
    assertInputOk(
      await execInputScript(
        inst,
        CLICK_SCRIPT,
        ['woc-click', winInfo.display, String(x), String(y), btn, opts.doubleClick ? '1' : '0'],
        INPUT_KILL_AFTER_SEC,
      ),
      '点击',
    );
    return { displayWidth: winInfo.displayWidth, displayHeight: winInfo.displayHeight };
  });
}

export async function scrollInInstance(
  inst: Instance,
  opts: ScrollOptions,
): Promise<{ displayWidth: number; displayHeight: number }> {
  const btn = SCROLL_BUTTON_MAP[opts.direction];
  if (!btn) throw new Error('滚动方向不合法');
  const clicks = opts.clicks ?? 3;
  if (!Number.isInteger(clicks) || clicks < 1 || clicks > 20) {
    throw new Error('滚动步数必须为 1-20 的整数');
  }
  return withInstanceInput(inst.containerName, async () => {
    const winInfo = await wechatWindowInfo(inst);
    if (winInfo.displayWidth !== opts.displayWidth || winInfo.displayHeight !== opts.displayHeight) {
      throw new DisplaySizeMismatchError(
        opts.displayWidth,
        opts.displayHeight,
        winInfo.displayWidth,
        winInfo.displayHeight,
      );
    }
    const x = Math.round(opts.x);
    const y = Math.round(opts.y);
    if (x < 0 || x >= winInfo.displayWidth || y < 0 || y >= winInfo.displayHeight) {
      throw new Error(`滚动坐标越界：(${x}, ${y}) 超出 ${winInfo.displayWidth}x${winInfo.displayHeight}`);
    }
    if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
      throw new Error('实例 DISPLAY 名称非法');
    }
    assertInputOk(
      await execInputScript(
        inst,
        SCROLL_SCRIPT,
        ['woc-scroll', winInfo.display, String(x), String(y), btn, String(clicks)],
        INPUT_KILL_AFTER_SEC,
      ),
      '滚动',
    );
    return { displayWidth: winInfo.displayWidth, displayHeight: winInfo.displayHeight };
  });
}

// 检测坐标是否落入微信主窗口右下角「发送(S)」按钮防误触区（防止经 woc_click 绕过草稿确认链路）。
export function isInSendButtonZone(x: number, y: number, win: WechatWindowRect | null): boolean {
  if (!win) return false;
  return (
    x >= win.x + win.width - 160 &&
    x <= win.x + win.width &&
    y >= win.y + win.height - 72 &&
    y <= win.y + win.height
  );
}

// ---------- 微信 4.1.1.8 原生 1:1 标题栏 + 原生 1:1 输入区灰度指纹（零落盘、单帧原子采集） ----------
export const HEADER_INK_DELTA = 20;
// 实测 1836x884「文件传输助手」(6 汉字)在 280x44 原生标题区占 721 px (|px-bg|>=20)；
// 2 汉字约 240 px，取 75 px 作为防空白下限，兼顾细笔画短名且稳定拦截空白标题栏。
export const MIN_HEADER_INK_PIXELS = 75;
// 输入区按原生 1:1 逐像素比对，确认时最多 3 帧取最小差异（t=0, 350ms, 700ms）消除光标闪烁。
// 缩放到 280x32 时实测同草稿 3 帧最小差异恒为 0，而单个数字的改动只有约 10 px、标点更小，
// 所以不留容差：默认 0，差 1 像素即拒绝。上机标定后可用 MCP_EDITOR_MAX_DIFF_PIXELS 调整。
export const DEFAULT_EDITOR_MAX_DIFF_PIXELS = 0;

export interface SessionFingerprint {
  displayWidth: number;
  displayHeight: number;
  wechatWindow: WechatWindowRect;
  headerRegion: ScreenshotCrop;
  editorRegion: ScreenshotCrop;
  headerGray: Buffer; // native 1:1 grayscale (headerRegion.width * headerRegion.height bytes), strictly in-memory
  editorGray: Buffer; // native 1:1 grayscale (editorRegion.width * editorRegion.height bytes), strictly in-memory
  headerInkPixels: number;
  headerBg: number;
  headerDigest: string; // 32-hex-char SHA-256 of the header bitmap + its size: stable identity of the open chat title
  digest: string; // 16-hex-char SHA-256 summary for metadata/logging
}

// 会话标题栏身份摘要：只取标题位图与其尺寸，同一会话多次采集恒定，可跨调用比对。
export function computeHeaderDigest(headerGray: Buffer, width: number, height: number): string {
  return createHash('sha256').update(headerGray).update(`|${width}x${height}`).digest('hex').slice(0, 32);
}

export interface HeaderCheckMetrics {
  match: boolean;
  diffPixels: number;
  totalPixels: number;
  meanAbsDiff: number;
}

export interface EditorCheckMetrics {
  enforced: boolean;
  match: boolean;
  diffPixels: number;
  changedPixels20: number;
  totalPixels: number;
  meanAbsDiff: number;
  changedPixelRatio: number;
  maxDiffPixels: number | null;
}

export interface FingerprintComparison {
  match: boolean;
  reason?: 'window_geometry_mismatch' | 'session_fingerprint_mismatch' | 'editor_fingerprint_mismatch';
  detail?: string;
  headerCheck: HeaderCheckMetrics;
  editorCheck: EditorCheckMetrics;
}

// 基于微信 Linux 4.1.1.8 实测布局计算当前会话标题核心裁剪区（1836x884 下精确为 {x:355,y:12,w:280,h:44}）：
// 左侧栏分隔线在 x=352，x=355 留出 3px 安全间隔，标题文字实测落在相对 (14,22)..(109,37)。
export function computeHeaderRegion(
  win: WechatWindowRect,
  displayWidth: number,
  displayHeight: number,
): ScreenshotCrop | null {
  if (win.width < 480 || win.height < 300) return null;
  const sidebarOffset = win.width >= 900 ? 355 : Math.round(win.width * 0.32);
  const rawX = win.x + sidebarOffset;
  const rawY = win.y + 12;
  const maxRight = Math.min(displayWidth, win.x + win.width - 140);
  const availW = maxRight - rawX;
  if (availW < 80) return null;
  const rawW = Math.min(280, Math.max(120, availW));
  const rawH = Math.min(44, Math.max(24, Math.round(win.height * 0.06)));
  if (rawW < 80 || rawH < 16) return null;
  const clamped = clampScreenshotCrop(
    { x: rawX, y: rawY, width: rawW, height: rawH },
    displayWidth,
    displayHeight,
  );
  if (clamped.width < 80 || clamped.height < 16) return null;
  return clamped;
}

// 基于微信 Linux 4.1.1.8 实测布局计算输入编辑区裁剪区（位于工具栏下方、底部「发送(S)」按钮行上方）。
export function computeEditorRegion(
  win: WechatWindowRect,
  displayWidth: number,
  displayHeight: number,
): ScreenshotCrop | null {
  if (win.width < 480 || win.height < 300) return null;
  const sidebarOffset = win.width >= 900 ? 355 : Math.round(win.width * 0.32);
  const rawX = win.x + sidebarOffset;
  const rawY = win.y + win.height - 142;
  const rawW = Math.max(120, Math.min(displayWidth, win.x + win.width - 20) - rawX);
  const rawH = Math.min(82, Math.max(32, win.y + win.height - 60 - rawY));
  if (rawW < 80 || rawH < 16) return null;
  const clamped = clampScreenshotCrop(
    { x: rawX, y: rawY, width: rawW, height: rawH },
    displayWidth,
    displayHeight,
  );
  if (clamped.width < 80 || clamped.height < 16) return null;
  return clamped;
}

// 统计原生 1:1 灰度标题栏中的文字墨迹像素数（以众数为背景灰度，统计 |px - bg| >= 20 的像素）。
export function countHeaderInkPixels(buf: Buffer): { bg: number; inkPixels: number; totalPixels: number } {
  const totalPixels = buf.length;
  if (totalPixels === 0) return { bg: 0, inkPixels: 0, totalPixels: 0 };
  const hist = new Uint32Array(256);
  for (let i = 0; i < totalPixels; i++) hist[buf[i]]++;
  let bg = 0;
  let maxCount = 0;
  for (let v = 0; v < 256; v++) {
    if (hist[v] > maxCount) {
      maxCount = hist[v];
      bg = v;
    }
  }
  let inkPixels = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (Math.abs(buf[i] - bg) >= HEADER_INK_DELTA) inkPixels++;
  }
  return { bg, inkPixels, totalPixels };
}

// 对比草稿期与确认期的会话指纹：
// 1. 窗口/屏幕/裁剪区几何必须完全一致（否则 window_geometry_mismatch）；
// 2. HEADER 原生 1:1 灰度图逐像素精确比对，零容差（diffPixels === 0，差 1 像素即 session_fingerprint_mismatch）；
// 3. EDITOR 原生 1:1 灰度图 diffPixels 比对，默认上限 DEFAULT_EDITOR_MAX_DIFF_PIXELS=0（配合确认时最多 3 帧早退采样消除光标闪烁）；显式传入 null 可退回仅诊断模式。
export function compareSessionFingerprints(
  draft: SessionFingerprint,
  live: SessionFingerprint,
  opts: { editorMaxDiffPixels?: number | null } = {},
): FingerprintComparison {
  const maxEditorDiff =
    opts.editorMaxDiffPixels === undefined ? DEFAULT_EDITOR_MAX_DIFF_PIXELS : opts.editorMaxDiffPixels;
  const failHeader: HeaderCheckMetrics = { match: false, diffPixels: -1, totalPixels: draft.headerGray.length, meanAbsDiff: 255 };
  const failEditor: EditorCheckMetrics = {
    enforced: maxEditorDiff !== null,
    match: maxEditorDiff === null,
    diffPixels: -1,
    changedPixels20: -1,
    totalPixels: draft.editorGray.length,
    meanAbsDiff: 255,
    changedPixelRatio: 1,
    maxDiffPixels: maxEditorDiff,
  };

  if (
    draft.displayWidth !== live.displayWidth ||
    draft.displayHeight !== live.displayHeight ||
    draft.wechatWindow.id !== live.wechatWindow.id ||
    draft.wechatWindow.x !== live.wechatWindow.x ||
    draft.wechatWindow.y !== live.wechatWindow.y ||
    draft.wechatWindow.width !== live.wechatWindow.width ||
    draft.wechatWindow.height !== live.wechatWindow.height ||
    draft.wechatWindow.title !== live.wechatWindow.title ||
    draft.headerRegion.x !== live.headerRegion.x ||
    draft.headerRegion.y !== live.headerRegion.y ||
    draft.headerRegion.width !== live.headerRegion.width ||
    draft.headerRegion.height !== live.headerRegion.height ||
    draft.editorRegion.x !== live.editorRegion.x ||
    draft.editorRegion.y !== live.editorRegion.y ||
    draft.editorRegion.width !== live.editorRegion.width ||
    draft.editorRegion.height !== live.editorRegion.height
  ) {
    return {
      match: false,
      reason: 'window_geometry_mismatch',
      detail: '显示分辨率或微信主窗口几何信息已发生变化',
      headerCheck: failHeader,
      editorCheck: failEditor,
    };
  }

  // Exact pixel-by-pixel HEADER comparison (zero tolerance: diffPixels === 0).
  const expectedHeaderLen = draft.headerRegion.width * draft.headerRegion.height;
  let headerCheck: HeaderCheckMetrics;
  if (draft.headerGray.length !== expectedHeaderLen || live.headerGray.length !== expectedHeaderLen) {
    headerCheck = { match: false, diffPixels: expectedHeaderLen, totalPixels: expectedHeaderLen, meanAbsDiff: 255 };
  } else {
    let diffPixels = 0;
    let absSum = 0;
    for (let i = 0; i < expectedHeaderLen; i++) {
      const d = Math.abs(draft.headerGray[i] - live.headerGray[i]);
      if (d !== 0) diffPixels++;
      absSum += d;
    }
    headerCheck = {
      match: diffPixels === 0,
      diffPixels,
      totalPixels: expectedHeaderLen,
      meanAbsDiff: Number((absSum / expectedHeaderLen).toFixed(4)),
    };
  }

  // Decoupled EDITOR comparison (diagnostic-only when maxEditorDiff === null).
  const expectedEditorLen = draft.editorRegion.width * draft.editorRegion.height;
  let editorCheck: EditorCheckMetrics;
  if (draft.editorGray.length !== expectedEditorLen || live.editorGray.length !== expectedEditorLen) {
    editorCheck = {
      enforced: maxEditorDiff !== null,
      match: maxEditorDiff === null,
      diffPixels: expectedEditorLen,
      changedPixels20: expectedEditorLen,
      totalPixels: expectedEditorLen,
      meanAbsDiff: 255,
      changedPixelRatio: 1,
      maxDiffPixels: maxEditorDiff,
    };
  } else {
    let diffPixels = 0;
    let changedPixels20 = 0;
    let absSum = 0;
    for (let i = 0; i < expectedEditorLen; i++) {
      const d = Math.abs(draft.editorGray[i] - live.editorGray[i]);
      if (d !== 0) diffPixels++;
      if (d >= HEADER_INK_DELTA) changedPixels20++;
      absSum += d;
    }
    const meanAbsDiff = Number((absSum / expectedEditorLen).toFixed(4));
    const changedPixelRatio = Number((changedPixels20 / expectedEditorLen).toFixed(4));
    const enforced = maxEditorDiff !== null;
    const match = !enforced || diffPixels <= maxEditorDiff;
    editorCheck = {
      enforced,
      match,
      diffPixels,
      changedPixels20,
      totalPixels: expectedEditorLen,
      meanAbsDiff,
      changedPixelRatio,
      maxDiffPixels: maxEditorDiff,
    };
  }

  if (!headerCheck.match) {
    return {
      match: false,
      reason: 'session_fingerprint_mismatch',
      detail: `会话标题栏原生 1:1 像素发生变化（diff_pixels=${headerCheck.diffPixels}/${headerCheck.totalPixels}）`,
      headerCheck,
      editorCheck,
    };
  }
  if (editorCheck.enforced && !editorCheck.match) {
    return {
      match: false,
      reason: 'editor_fingerprint_mismatch',
      detail: `输入编辑区像素变化超出阈值（diff_pixels=${editorCheck.diffPixels} > ${editorCheck.maxDiffPixels}）`,
      headerCheck,
      editorCheck,
    };
  }
  return { match: true, headerCheck, editorCheck };
}

// 单帧原子采集：关闭鼠标绘制（-draw_mouse 0），单次 ffmpeg x11grab 切出原生 1:1 的 header (hw x hh) 与
// editor (ew x eh)，都不缩放；两块右侧补黑到同宽 pw 后纵向拼接为 pw x (hh + eh) 原始灰度流。
export const FINGERPRINT_FILTER_GRAPH =
  '[0:v]split=2[h][e];[h]crop=${hw}:${hh}:${hx}:${hy},format=gray,pad=${pw}:${hh}:0:0:black[hs];' +
  '[e]crop=${ew}:${eh}:${ex}:${ey},format=gray,pad=${pw}:${eh}:0:0:black[es];[hs][es]vstack=inputs=2[out]';

const FINGERPRINT_CAPTURE_SCRIPT = [
  'set -eu',
  'display="$1"; sw="$2"; sh="$3"; hx="$4"; hy="$5"; hw="$6"; hh="$7"; ex="$8"; ey="$9"; ew="${10}"; eh="${11}"; pw="${12}"',
  'export DISPLAY="$display"',
  'command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not installed in instance image" >&2; exit 127; }',
  `fc="${FINGERPRINT_FILTER_GRAPH}"`,
  'exec ffmpeg -loglevel error -draw_mouse 0 -f x11grab -video_size "${sw}x${sh}" -i "${display}+0,0" -vframes 1 -filter_complex "$fc" -map "[out]" -f rawvideo -pix_fmt gray -',
].join('\n');

export async function captureSessionFingerprint(inst: Instance): Promise<SessionFingerprint> {
  const winInfo = await wechatWindowInfo(inst);
  if (!winInfo.wechatWindow) {
    throw new Error('未找到可见的微信主窗口，无法采集会话指纹');
  }
  const headerRegion = computeHeaderRegion(
    winInfo.wechatWindow,
    winInfo.displayWidth,
    winInfo.displayHeight,
  );
  const editorRegion = computeEditorRegion(
    winInfo.wechatWindow,
    winInfo.displayWidth,
    winInfo.displayHeight,
  );
  if (!headerRegion || !editorRegion) {
    throw new Error('微信主窗口尺寸过小或不可见，无法安全定位会话标题栏与输入区');
  }
  if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
    throw new Error('实例 DISPLAY 名称非法');
  }
  const stride = Math.max(headerRegion.width, editorRegion.width);
  const expectedTotalBytes = stride * (headerRegion.height + editorRegion.height);
  const combined = await execCaptureBuffer(
    inst,
    [
      'bash',
      '-c',
      FINGERPRINT_CAPTURE_SCRIPT,
      'woc-fingerprint',
      winInfo.display,
      String(winInfo.displayWidth),
      String(winInfo.displayHeight),
      String(headerRegion.x),
      String(headerRegion.y),
      String(headerRegion.width),
      String(headerRegion.height),
      String(editorRegion.x),
      String(editorRegion.y),
      String(editorRegion.width),
      String(editorRegion.height),
      String(stride),
    ],
    'abc',
    8000,
    expectedTotalBytes + 4096,
  );
  if (combined.length !== expectedTotalBytes) {
    throw new Error(`会话指纹原始字节数异常：期望 ${expectedTotalBytes}，实际 ${combined.length}`);
  }
  const headerGray = extractGrayRows(combined, stride, 0, headerRegion.width, headerRegion.height);
  const editorGray = extractGrayRows(combined, stride, headerRegion.height, editorRegion.width, editorRegion.height);
  const { bg: headerBg, inkPixels: headerInkPixels } = countHeaderInkPixels(headerGray);
  const headerDigest = computeHeaderDigest(headerGray, headerRegion.width, headerRegion.height);
  const digest = createHash('sha256')
    .update(headerGray)
    .update(editorGray)
    .update(
      `${winInfo.displayWidth}x${winInfo.displayHeight}:${winInfo.wechatWindow.id}:${headerRegion.x},${headerRegion.y},${headerRegion.width}x${headerRegion.height}:${editorRegion.x},${editorRegion.y},${editorRegion.width}x${editorRegion.height}`,
    )
    .digest('hex')
    .slice(0, 16);
  return {
    displayWidth: winInfo.displayWidth,
    displayHeight: winInfo.displayHeight,
    wechatWindow: winInfo.wechatWindow,
    headerRegion,
    editorRegion,
    headerGray,
    editorGray,
    headerInkPixels,
    headerBg,
    headerDigest,
    digest,
  };
}

// 从步长为 stride 的灰度位图里取出从 rowOffset 行开始、左对齐的 width x height 子块。
export function extractGrayRows(buf: Buffer, stride: number, rowOffset: number, width: number, height: number): Buffer {
  if (width > stride || buf.length < stride * (rowOffset + height)) {
    throw new Error('灰度位图尺寸不足，无法切出指纹区域');
  }
  const out = Buffer.allocUnsafe(width * height);
  for (let r = 0; r < height; r++) {
    const start = (rowOffset + r) * stride;
    buf.copy(out, r * width, start, start + width);
  }
  return out;
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (let i = 0; i < body.length; i++) crc = PNG_CRC_TABLE[(crc ^ body[i]) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}

// 把内存里的 8 位灰度位图编码成 PNG（不落盘）：让调用方看到的图和服务端用来比对 / 算摘要的是同一份字节。
export function encodeGrayPng(gray: Buffer, width: number, height: number): Buffer {
  if (width <= 0 || height <= 0 || gray.length !== width * height) {
    throw new Error('灰度位图尺寸与数据长度不符');
  }
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([PNG_MAGIC, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

export { WECHAT_IMAGE };
