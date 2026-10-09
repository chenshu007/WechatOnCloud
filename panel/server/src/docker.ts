import { IMAGE_PASTE_SCRIPT, PasteError, validatePasteImage, withInstanceInput } from './image-paste.js';
import { parseTransferFiles } from './transfer-format.js';
import { StringDecoder } from 'node:string_decoder';
import { hostname } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { appendInstanceLog, deleteInstanceLog, appendPanelLog, readInstanceLog, readPanelLog, filterSince } from './logs.js';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
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
  if (opts?.keepImage) await docker.getImage(image).inspect();
  else await ensureImage();
  if (info) {
    // 删除前先把旧容器最后日志快照进持久日志，否则随容器删除就看不到"上次为何停/崩"。
    await snapshotContainerLog(inst, '容器重建（重启/升级/自愈），保留上一容器最后日志');
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

// 确保实例容器在运行：缺失则按需创建（不会重建已有卷），停止则启动。
export async function ensureRunning(inst: Instance): Promise<void> {
  requireSupportedApp(inst);
  try {
    const c = docker.getContainer(inst.containerName);
    const info = await c.inspect();
    if (!info.State?.Running) await c.start();
  } catch {
    await runInstance(inst);
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

// 停止实例容器（保留容器与数据卷，可再启动）。
export async function stopInstance(inst: Instance): Promise<void> {
  try {
    await docker.getContainer(inst.containerName).stop({ t: 5 } as any);
    appendInstanceLog(inst.id, '容器已停止');
  } catch {
    /* 已停止或不存在 */
  }
}

export async function removeInstance(inst: Instance, purgeVolume: boolean): Promise<void> {
  try {
    const c = docker.getContainer(inst.containerName);
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
    const json = JSON.parse(raw.trim());
    return { ...DEFAULT_STATUS, ...json };
  } catch {
    return DEFAULT_STATUS;
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
export async function pasteImageInInstance(inst: Instance, mime: string, content: Buffer): Promise<void> {
  requireSupportedApp(inst);
  validatePasteImage(mime, content);
  return withInstanceInput(inst.containerName, async () => {
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
  });
}

// 通过 xdotool 在实例容器内输入文字（绕过 VNC keysym 限制，解决中文 IME 吞字问题）。
// 用 base64 传递文本避免 shell 转义问题，xclip 写入剪贴板后 xdotool 模拟 Ctrl+V 粘贴。
// 服务端按键一律「先松开 xdotool 自己按住的修饰键，再按」，不用 --clearmodifiers（移植自上游 31c5146，#151）。
// --clearmodifiers 会在按键前松开当前按着的修饰键、按完再「恢复」。用户按 Ctrl+V 粘贴时，粘贴桥截下 V、服务端替他按
// Ctrl+V，这时用户往往还按着 Ctrl：xdotool 按完后用它自己的虚拟键盘（XTEST）把 Ctrl 按回去，而用户松手是从 VNC 键盘
// 来的，XTEST 这边的 Ctrl 就一直按着。下一次 xdotool 再按 Ctrl 被当成重复按键吞掉，应用收到的是光秃秃的 v——
// 粘完图片接着打中文，发出去的是「v」。先 keyup 一遍既能清掉这种残留（包括旧版本留下的），又不会再按回去。
export const XDO_RELEASE_MODS = 'xdotool keyup Control_L Control_R Shift_L Shift_R Alt_L Alt_R Meta_L Meta_R Super_L Super_R ISO_Level3_Shift';
const xdoKey = (key: string) => `${XDO_RELEASE_MODS}\nxdotool key ${key}`;

export async function typeInInstance(inst: Instance, text: string): Promise<void> {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
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
    xdoKey('ctrl+v'),
  ].join('\n');
  await withInstanceInput(inst.containerName, () => execCapture(inst, ['bash', '-c', cmd]));
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

export { WECHAT_IMAGE };
