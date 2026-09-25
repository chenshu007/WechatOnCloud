import { assertActive, assertImageRef, assertImageIdentity, RETIRED_MESSAGE } from './no-chromium.js';
import { hostname } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { appendInstanceLog, deleteInstanceLog, appendPanelLog, readInstanceLog, readPanelLog, filterSince } from './logs.js';
import http from 'node:http';
import zlib from 'node:zlib';
import Docker from 'dockerode';
import { instanceAppType, type Instance } from './store.js';

// Explicit immutable configuration: no version rewriting or latest fallback.
const WECHAT_IMAGE = process.env.WOC_WECHAT_IMAGE || '';
export async function resolveInstanceImage(): Promise<void> { assertImageRef(WECHAT_IMAGE); }
async function validatedImage(ref = WECHAT_IMAGE): Promise<string> {
  const image = await docker.getImage(ref).inspect();
  assertImageIdentity(image);
  return image.Id;
}

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
// #134：宿主内核禁用 IPv6（ipv6.disable=1）时，实例 nginx 默认配置里的 `listen [::]` 绑定失败，整个 nginx 起不来，
// 远程桌面随之全挂，用户只能进容器手动 sed。同一内核下所有容器看到的 /proc/net/if_inet6 一致：内核禁用 IPv6 时
// 该文件不存在（普通 Docker 网络只是在容器内关 IPv6，文件仍在、[::] 仍可绑定，不受影响）。也可用 WOC_DISABLE_IPV6 强制。
const NO_IPV6 = /^(1|true|yes)$/i.test(process.env.WOC_DISABLE_IPV6 || '') || !existsSync('/proc/net/if_inet6');

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
  // baseimage 的 init-nginx 只看 DISABLE_IPV6 是否已设置，设了就删掉 `listen [::]`（每次启动重新生成配置，故须常驻于容器环境）
  if (NO_IPV6) env.push('DISABLE_IPV6=1');
  return env;
}

// 确保微信镜像在本地存在；缺失则从 GHCR 拉取（首次新建实例时镜像通常还没拉过）。
async function ensureImage(): Promise<string> {
  assertImageRef(WECHAT_IMAGE);
  try { return await validatedImage(); }
  catch (e: any) { if (e?.statusCode !== 404) throw e; }
  await pullImage();
  return validatedImage();
}

// ---------- 自定义数据目录 WOC_DATA_ROOT（#133 #127，取代 PR #69 的做法） ----------
// 需求：实例数据（聊天记录、收到的文件）落到用户自选的宿主目录（大容量盘 / 方便直接取文件），
// 而不是 Docker 默认的卷目录。PR #69 直接把 /config 改绑宿主路径，会让已有实例切到空目录（看似丢数据），
// 且面板里按卷名工作的功能（数据卷浏览/备份/恢复/孤儿卷清理）全部失效。
// 这里改用 local 驱动的「绑定型具名卷」：卷名不变、内容在宿主目录，其余功能原样可用；
// 且只在新建实例（卷尚不存在）时生效——已存在的卷一律不碰，老实例零影响，事后取消该设置也不影响已建实例。
function parseDataRoot(raw: string | undefined): string {
  const v = (raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  // 只接受干净的绝对路径：会被拼进辅助容器的 shell 命令与卷的 device 参数
  if (!/^\/[A-Za-z0-9._\-\/]+$/.test(v) || v.split('/').includes('..')) {
    console.error(`[data-root] 忽略非法的 WOC_DATA_ROOT：${v}（需为不含空格与 .. 的宿主绝对路径）`);
    return '';
  }
  return v;
}
const DATA_ROOT = parseDataRoot(process.env.WOC_DATA_ROOT);
const VOLUME_NAME_RE = /^woc-data-[0-9a-z]+$/;
const SAFE_ID = (v: string) => (/^\d+$/.test(v) ? v : '1000');

// 以 root 跑一次性辅助容器，把宿主 root 目录挂到 /woc-root 执行一段脚本（面板容器本身看不到宿主路径）
async function runDataRootHelper(root: string, image: string, script: string): Promise<void> {
  const c = await docker.createContainer({
    Image: image,
    Entrypoint: ['sh', '-c'],
    Cmd: [script],
    User: '0',
    Labels: { 'woc.helper': 'data-root' },
    HostConfig: { Binds: [`${root}:/woc-root`] },
  } as any);
  try {
    await c.start();
    const r: any = await c.wait();
    if (r?.StatusCode !== 0) throw new Error(`辅助容器退出码 ${r?.StatusCode}`);
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

async function ensureInstanceVolume(inst: Instance, image: string): Promise<void> {
  if (!DATA_ROOT || !VOLUME_NAME_RE.test(inst.volumeName)) return;
  try {
    await docker.getVolume(inst.volumeName).inspect();
    return; // 卷已存在（老实例 / 重启 / 自愈）：绝不改动
  } catch {
    /* 不存在 → 按 WOC_DATA_ROOT 新建 */
  }
  const dir = `${DATA_ROOT}/${inst.volumeName}`;
  await runDataRootHelper(
    DATA_ROOT,
    image,
    `mkdir -p /woc-root/${inst.volumeName} && chown ${SAFE_ID(PUID)}:${SAFE_ID(PGID)} /woc-root/${inst.volumeName}`,
  );
  await docker.createVolume({
    Name: inst.volumeName,
    Driver: 'local',
    DriverOpts: { type: 'none', o: 'bind', device: dir },
    Labels: { 'woc.data-root': DATA_ROOT },
  } as any);
  appendInstanceLog(inst.id, `数据目录：宿主 ${dir}（WOC_DATA_ROOT）`);
  appendPanelLog('INFO', `实例 ${inst.id} 的数据目录建在宿主 ${dir}`);
}

// 删除数据卷；若是 WOC_DATA_ROOT 建的绑定型卷，宿主目录一并删除（「清除数据」的本意），
// 否则删卷只是去掉 Docker 里的卷对象，数据会以用户看不见的形式留在宿主上。
async function removeVolumeWithData(name: string): Promise<void> {
  let root = '';
  try {
    const info: any = await docker.getVolume(name).inspect();
    root = parseDataRoot(info?.Labels?.['woc.data-root']);
  } catch {
    /* 卷不存在 */
  }
  await docker.getVolume(name).remove({ force: true } as any);
  if (!root || !VOLUME_NAME_RE.test(name)) return;
  try {
    await runDataRootHelper(root, WECHAT_IMAGE, `rm -rf /woc-root/${name}`);
    appendPanelLog('INFO', `已删除宿主数据目录 ${root}/${name}`);
  } catch (e: any) {
    appendPanelLog('WARN', `宿主数据目录 ${root}/${name} 未能自动删除（${e?.message || e}），可手动删除`);
  }
}

// 诊断用：说明数据实际落在哪里
export async function describeInstanceVolume(name: string): Promise<string> {
  try {
    const info: any = await docker.getVolume(name).inspect();
    const dev = info?.Options?.device;
    return info?.Options?.o === 'bind' && dev ? `宿主目录 ${dev}` : `Docker 卷 ${info?.Mountpoint || ''}`.trim();
  } catch {
    return '卷尚不存在';
  }
}

// 创建并启动一个微信实例容器。若同名容器已存在则先移除（仅容器，不动卷）。
// keepImage（稳定性关键）：重启/自愈必须幂等——沿用该实例当前正在跑的镜像重建，
// 绝不因"本地 :latest 恰好被某次拉取更新过"就悄悄换镜像（那等于一次没人要求的隐式升级；
// 若本地新镜像恰好是坏的，一次看门狗自愈就能弄坏一个用户从没升级过的实例）。
// 换镜像只允许发生在显式「升级实例」（不带 keepImage）。
export async function runInstance(inst: Instance, opts?: { keepImage?: boolean }): Promise<void> {
  assertActive(inst);
  assertImageRef(WECHAT_IMAGE);
  const existing = docker.getContainer(inst.containerName);
  let info: any;
  try { info = await existing.inspect(); }
  catch (e: any) { if (e?.statusCode !== 404) throw e; }
  const imageOverride = await ensureImage();
  if (opts?.keepImage && info?.Image && await validatedImage(String(info.Image)) !== imageOverride) {
    throw new Error('当前实例镜像与指定定制镜像不一致，请显式升级实例');
  }
  const net = await ensureNetwork();
  if (info) {
    await snapshotContainerLog(inst, '容器重建，保留上一容器最后日志');
    await existing.remove({ force: true });
  }
  await ensureInstanceVolume(inst, imageOverride || WECHAT_IMAGE);
  // 摄像头设备（探测不到则为空数组 → 仅摄像头不可用，音频/麦克风照常）
  const vids = videoDevices();
  const dris = ENABLE_GPU ? driDevices() : [];
  const hostConfig: Docker.HostConfig = {
    Binds: [`${inst.volumeName}:/config`],
    NetworkMode: net || undefined,
    SecurityOpt: ['seccomp=unconfined'],
    ShmSize: SHM_SIZE,
    RestartPolicy: { Name: 'unless-stopped' },
    // 日志硬上限：docker 默认 json-file 无大小限制，应用崩溃循环（每 2s 刷错误）会把宿主磁盘
    // 无限吃掉（群晖用户反馈"一下子 1TB 没了"的元凶之一）。每实例封顶 20MB×2。
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
    Image: imageOverride || WECHAT_IMAGE,
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
  assertActive(inst);
  const c = docker.getContainer(inst.containerName);
  let info: any;
  try { info = await c.inspect(); }
  catch (e: any) { if (e?.statusCode !== 404) throw e; }
  if (!info) return runInstance(inst);
  // Do not disturb an existing running container. Starting requires trusted identity.
  if (!info.State?.Running) {
    assertImageRef(WECHAT_IMAGE);
    const target = await ensureImage();
    if (await validatedImage(String(info.Image)) !== target) throw new Error('当前实例镜像与指定定制镜像不一致，请显式升级实例');
    await c.start();
  }
}

// 升级实例：拉取最新微信镜像后重建容器（保留数据卷 → 登录态不丢）。
// 拉取失败立即停止；不得使用普通版或本地旧镜像兜底。
// skipPull：批量升级时由调用方先统一拉取一次，避免 N 个实例拉 N 次（受限网络下每次
// 都要等到拉取停滞超时，表现为"一键升级卡死"）。
export async function upgradeInstance(inst: Instance, opts?: { skipPull?: boolean }): Promise<void> {
  assertActive(inst);
  if (!opts?.skipPull) await pullImage();
  // 记录升级前镜像，用于事后判断"升级是否真的换了镜像"（issue #112：拉取失败静默回退旧镜像，
  // 用户被告知"完成"、实际什么都没变，且无从自查）。
  const before = await (async () => {
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      return String(info.Image || '');
    } catch {
      return '';
    }
  })();
  // 升级不改变用户的运行状态：原本停止的实例，升级（重建）后停回去，而不是悄悄拉起。
  const wasStopped = (await instanceRuntime(inst)) === 'stopped';
  await runInstance(inst);
  if (wasStopped) {
    try {
      await stopInstance(inst);
      appendInstanceLog(inst.id, '升级完成，恢复原有的停止状态');
    } catch {
      /* 停不回去也不算失败 */
    }
  }
  const after = await (async () => {
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      return String(info.Image || '');
    } catch {
      return '';
    }
  })();
  if (before && after !== before) {
    appendInstanceLog(inst.id, `镜像已更换：${before.slice(7, 19)} → ${after.slice(7, 19)}`);
  } else {
    appendInstanceLog(inst.id, '镜像已是最新，无需更换');
  }
}

// 清理【旧版本 woc 镜像】：删掉不再被任何容器使用、也不是当前版本的 woc-panel / wechat-on-cloud 镜像。
// 背景：版本耦合后面板拉的是带版本号的 tag（:1.4.5），升级到 :1.4.6 后旧的 :1.4.5 镜像仍带 tag、
// 不是 dangling，pruneDanglingImages 清不掉 → 每个历史版本的镜像（各 1~2GB）长期堆积吃满磁盘
// （用户反馈"历史镜像占用太多"）。这里按"无容器引用 + 非当前版本"精准删除，绝不动正在用/未升级实例的镜像。
// 环境变量 WOC_KEEP_OLD_IMAGES=1 可关闭（想保留旧镜像便于快速回滚的用户）。
export async function pruneOldWocImages(): Promise<void> {
  if (process.env.WOC_KEEP_OLD_IMAGES === '1') return;
  try {
    // 1) 要保留的镜像 id 集合：当前实例镜像 + 面板自身镜像 + 所有现存容器（含已停止）在用的镜像。
    const keep = new Set<string>();
    const curInstance = await latestInstanceImageId();
    if (curInstance) keep.add(curInstance);
    try {
      const panelC: any = await docker.getContainer(process.env.WOC_PANEL_CONTAINER || 'woc-panel').inspect();
      if (panelC?.Image) keep.add(String(panelC.Image));
    } catch {
      /* 面板容器名不同/查不到 → 跳过，下面的容器遍历仍会覆盖到 */
    }
    const containers: any[] = await docker.listContainers({ all: true });
    for (const c of containers) if (c?.ImageID) keep.add(String(c.ImageID));

    // 2) 识别 woc 镜像的仓库路径（从 WECHAT_IMAGE 推断 owner，兼容 ghcr/docker.io/无前缀各种 tag 写法）。
    const ref = parseImageRef(WECHAT_IMAGE);
    const owner = ref?.repo.split('/').slice(0, -1).join('/') || 'gloridust';
    const panelRepo = process.env.WOC_PANEL_REPO || 'woc-panel';
    const wocRepoNeedles = [`${owner}/wechat-on-cloud`, `${owner}/${panelRepo}`];

    // 3) 遍历本地镜像，删掉"属于 woc 仓库 + 不在 keep 集"的。
    const images: any[] = await docker.listImages();
    let removed = 0;
    for (const img of images) {
      const tags: string[] = img.RepoTags || [];
      if (!tags.some((t) => wocRepoNeedles.some((n) => t.includes(n)))) continue; // 非 woc 镜像
      if (keep.has(String(img.Id))) continue; // 当前/在用 → 保留
      try {
        await docker.getImage(img.Id).remove({ force: true }); // force：一次删掉该镜像的所有 tag
        removed++;
        appendPanelLog('INFO', `清理旧版本镜像 ${tags.join(', ') || String(img.Id).slice(7, 19)}`);
      } catch {
        /* 仍被占用等 → 跳过，不影响其它 */
      }
    }
    if (removed > 0) appendPanelLog('INFO', `已清理 ${removed} 个旧版本 woc 镜像`);
  } catch (e: any) {
    console.warn('[docker] 清理旧版本镜像失败（忽略）:', e?.message || e);
  }
  // 顺带清一次悬空层（删旧镜像后可能又暴露出无 tag 的中间层）
  await pruneDanglingImages();
}

// 清理悬空（dangling）镜像：升级后旧实例镜像失去 tag 变成 <none>，长期堆积吃磁盘
// （每层 1-2GB，多次升级后可观）。只删无 tag 且无容器引用的镜像，安全。best-effort。
export async function pruneDanglingImages(): Promise<void> {
  try {
    const res: any = await docker.pruneImages({ filters: { dangling: ['true'] } as any });
    const freed = Number(res?.SpaceReclaimed || 0);
    if (freed > 0) appendPanelLog('INFO', `已清理悬空镜像，释放 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB`);
  } catch (e: any) {
    console.warn('[docker] 清理悬空镜像失败（忽略）:', e?.message || e);
  }
}

// 重置实例的设备 machine-id：删掉持久化的 .woc-machine-id 后重启，由 00-woc-identity 钩子重新生成
// 一个全新的唯一值（相当于"换一台新设备"）。用于某账号被腾讯风控标记后手动滚新设备身份。
// 仅对含身份钩子的新镜像有效；旧镜像（升级前）无钩子，先 throw 提示升级，避免做无用功。
export async function regenInstanceMachineId(inst: Instance): Promise<void> {
  assertActive(inst);
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
  await stopInstance(inst);
  await runInstance(inst, { keepImage: true }); // 重置身份=恢复类操作，幂等：不隐式换镜像（R10）
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
      await removeVolumeWithData(inst.volumeName);
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
  await removeVolumeWithData(name);
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

// 本地「最新实例镜像」的 Id（新建/升级实例会用到的镜像）。查不到（未拉取过）返回 null。
export async function latestInstanceImageId(): Promise<string | null> {
  try {
    assertImageRef(WECHAT_IMAGE);
    return await validatedImage();
  } catch {
    return null;
  }
}

// 实例是否「镜像落后」：其运行中容器的镜像 Id 与本地最新镜像不一致（即重建就会换新镜像）。
// 容器不存在 / 查不到最新镜像时返回 false（不打扰）。传入 latestId 复用一次查询，避免 N 次 inspect。
export async function instanceOutdated(inst: Instance, latestId: string | null): Promise<boolean> {
  if (inst.appType === 'chromium' || !latestId) return false;
  try {
    const info: any = await docker.getContainer(inst.containerName).inspect();
    const cur = String(info.Image || '');
    return !!cur && cur !== latestId;
  } catch {
    return false; // 容器不存在（未创建/已删）→ 不算落后
  }
}

// 实例容器当前运行镜像的版本号（CI 打的 org.opencontainers.image.version label，如 "1.4.0"）。
// 本地自构建镜像无该 label → 返回镜像短 id（显示为"自构建 xxxx"级别信息）；容器不存在 → null。
// 背景（issue #112）：用户无从得知实例到底跑的哪版镜像，"以为升级了其实没有"无法自查。
export async function instanceImageVersion(inst: Instance): Promise<string | null> {
  try {
    const info: any = await docker.getContainer(inst.containerName).inspect();
    const imgId = String(info.Image || '');
    if (!imgId) return null;
    try {
      const img: any = await docker.getImage(imgId).inspect();
      const v = img?.Config?.Labels?.['org.opencontainers.image.version'];
      if (v) return String(v);
    } catch {
      /* 镜像记录不可读（containerd 快照残留），退回短 id */
    }
    return imgId.replace(/^sha256:/, '').slice(0, 12);
  } catch {
    return null;
  }
}

// ---------- 远端实例镜像新版检测 ----------
// 盲区背景：instanceOutdated 只比「容器镜像 vs 本地镜像」。用户更新面板后，本地实例镜像
// 往往还是旧的（没人主动 pull）→ 检测恒为"无可升级"→ 升级引导永远不出现。这里用 registry
// manifest digest（HEAD 请求，不下载）对比本地镜像的 RepoDigests，判断远端是否有新版。
// best-effort：离线/被墙/私有源 → null（未知，不打扰）；本地自构建镜像（无 RepoDigests）→ null。
let remoteImageCache: { val: boolean | null; at: number } = { val: null, at: 0 };
let remoteImageInflight: Promise<void> | null = null;
export function invalidateRemoteImageCache(): void {
  remoteImageCache = { val: null, at: 0 };
}
// 同步返回缓存值（可能 null=未知），过期时后台刷新——upgrade-status 是管理页高频接口，不能被 8s 外呼拖住。
export function remoteInstanceImageNewer(): boolean | null {
  const TTL = 30 * 60 * 1000;
  if (Date.now() - remoteImageCache.at >= TTL && !remoteImageInflight) {
    remoteImageInflight = checkRemoteImageNewer()
      .then((v) => {
        remoteImageCache = { val: v, at: Date.now() };
      })
      .catch(() => {
        remoteImageCache = { val: null, at: Date.now() };
      })
      .finally(() => {
        remoteImageInflight = null;
      });
  }
  return remoteImageCache.at ? remoteImageCache.val : null;
}

async function checkRemoteImageNewer(): Promise<boolean | null> {
  const ref = parseImageRef(WECHAT_IMAGE);
  if (!ref) return null;
  let local: any;
  try {
    local = await docker.getImage(WECHAT_IMAGE).inspect();
  } catch {
    // 本地没有该镜像。版本耦合后这是常态：面板刚自更新到 vX，本地还只有旧版镜像、没有 :vX 的 tag。
    // 远端确实存在该镜像 → 视为「有新版可拉取」，让升级引导亮起（一键升级会先拉取）。
    // 连不上（unreachable）→ null=未知，不打扰；确认不存在（missing）→ 也没得升，null。
    const probe = await probeManifest(ref);
    return probe.ok ? true : null;
  }
  const repoDigests: string[] = local.RepoDigests || [];
  if (!repoDigests.length) return null; // 本地自构建（无 registry 来源）→ 无从比较，不打扰
  const probe = await probeManifest(ref);
  if (!probe.ok) return null; // 未知/不存在 → 不打扰
  return !repoDigests.some((d) => d.endsWith('@' + probe.digest));
}

// 解析镜像引用 → { registry, repo, tag }。例：docker.io/gloridust/wechat-on-cloud:latest。
function parseImageRef(image: string): { registry: string; repo: string; tag: string } | null {
  const noDigest = image.split('@')[0];
  const segs = noDigest.split('/');
  let registry = 'docker.io';
  if (segs.length > 1 && (segs[0].includes('.') || segs[0].includes(':'))) registry = segs.shift() as string;
  let last = segs[segs.length - 1] || '';
  let tag = 'latest';
  const ti = last.lastIndexOf(':');
  if (ti > 0) {
    tag = last.slice(ti + 1);
    segs[segs.length - 1] = last.slice(0, ti);
  }
  const repo = segs.join('/');
  return repo ? { registry, repo, tag } : null;
}

async function fetchJsonWithTimeout(url: string, headers: Record<string, string>, ms = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 探测 registry 上该 tag 是否存在及其 manifest digest。
// 关键（issue #114）：必须把「仓库确认没有(404)」与「连不上仓库(网络/超时/鉴权失败)」分开——
// 前者才能据以回退，后者只是未知，不能当作"不存在"（否则受限网络用户会被误判、回退到过期的 :latest）。
type ManifestProbe = { ok: true; digest: string } | { ok: false; reason: 'missing' | 'unreachable' };

async function probeManifest(ref: { registry: string; repo: string; tag: string }): Promise<ManifestProbe> {
  const accept =
    'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';
  let host = ref.registry;
  let token = '';
  try {
    if (ref.registry === 'docker.io') {
      host = 'registry-1.docker.io';
      const d = await fetchJsonWithTimeout(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${ref.repo}:pull`,
        {},
      );
      token = d?.token || '';
    } else if (ref.registry === 'ghcr.io') {
      const d = await fetchJsonWithTimeout(`https://ghcr.io/token?service=ghcr.io&scope=repository:${ref.repo}:pull`, {});
      token = d?.token || '';
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      // HEAD 即可拿 Docker-Content-Digest（不下载 manifest 本体）
      const res = await fetch(`https://${host}/v2/${ref.repo}/manifests/${ref.tag}`, {
        method: 'HEAD',
        headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: ctrl.signal,
      });
      // 404 = 仓库明确回答"没有这个 tag"；其它非 2xx（401/5xx…）当作不可达，不敢断言不存在。
      if (res.status === 404) return { ok: false, reason: 'missing' };
      if (!res.ok) return { ok: false, reason: 'unreachable' };
      const digest = res.headers.get('docker-content-digest');
      return digest ? { ok: true, digest } : { ok: false, reason: 'unreachable' };
    } finally {
      clearTimeout(t);
    }
  } catch {
    // 网络错误 / 超时 / 取 token 失败 → 未知，不是"不存在"
    return { ok: false, reason: 'unreachable' };
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
async function execCapture(inst: Instance, cmd: string[], user = 'abc'): Promise<string> {
  const c = docker.getContainer(inst.containerName);
  const exec = await execCreate(c, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: user });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    const stdout = { write: (b: Buffer) => { out += b.toString('utf8'); } } as any;
    const stderr = { write: (b: Buffer) => { err += b.toString('utf8'); } } as any;
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        if (info.ExitCode && info.ExitCode !== 0) {
          reject(new Error((err || out || `命令执行失败，退出码 ${info.ExitCode}`).trim()));
          return;
        }
        resolve(out || err);
      } catch (e) {
        reject(e);
      }
    });
    stream.on('error', reject);
  });
}

// 触发下载/安装（detached，立即返回，后台下载）。按实例 appType 分发：app-ctl.sh wechat → 委托回
// wechat-ctl.sh；telegram 等各自实现。兼容旧容器（升级前镜像里没有 /woc/app-ctl.sh）：有则用之，无则
// 回退老的 wechat-ctl.sh（旧实例都是微信）。appType 取值受 instanceAppType 约束，可安全内插进 shell。
export async function triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
  assertActive(inst);
  const c = docker.getContainer(inst.containerName);
  const at = instanceAppType(inst);
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
  if (inst.appType === 'chromium') return { ...DEFAULT_STATUS, phase: 'error', message: RETIRED_MESSAGE };
  try {
    // 兼容旧容器（无 /woc/app-ctl.sh）：有则按 appType 取状态，无则回退老的 wechat-ctl.sh（旧实例皆微信）。
    const at = instanceAppType(inst);
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

// 拉取微信镜像（首次部署/更新镜像用）。
// 并发合并：创建实例/单实例升级/一键升级可能同时触发拉取，同一时刻只跑一个（后来者共享结果；
// 其 onProgress 不再接收进度，可接受——进度只影响创建向导的百分比显示）。
let pullInFlight: Promise<void> | null = null;
export function pullImage(onProgress?: (line: any) => void): Promise<void> {
  if (pullInFlight) return pullInFlight;
  assertImageRef(WECHAT_IMAGE);
  pullInFlight = doPullImage(onProgress).then(async () => { await validatedImage(); }).finally(() => {
    pullInFlight = null;
    invalidateRemoteImageCache(); // 本地镜像可能已更新 → 远端新版检测缓存作废
  });
  return pullInFlight;
}

async function doPullImage(onProgress?: (line: any) => void): Promise<void> {
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

// 极简单文件 tar 编码（putArchive 需要 tar；避免引入第三方依赖）。
function tarSingleFile(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8'); // name
  h.write('0000644\0', 100); // mode
  h.write('0001750\0', 108); // uid 1000(octal 1750)
  h.write('0001750\0', 116); // gid 1000
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124); // size
  // mtime 必须写当前时间：此前写死 0，上传进实例的文件全是 1970 年，
  // 微信文件选择器、面板文件列表按时间排序时，刚上传的文件反而沉到最底下。
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136); // mtime
  h.write('        ', 148); // checksum 占位（8 空格）
  h.write('0', 156); // typeflag 普通文件
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); // 真实校验和
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0), Buffer.alloc(1024, 0)]);
}

// ---------- 诊断包 ----------
// 单个 tar entry（USTAR header + 内容 + 512 对齐填充），复用与 tarSingleFile 相同的格式。
function tarEntry(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136); // mtime（同 tarSingleFile，别写 0）
  h.write('        ', 148); // checksum 占位
  h.write('0', 156); // typeflag 普通文件
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0)]);
}

// 多文件 tar.gz（内存构建；诊断包通常仅数 MB）。文件名用 ASCII 路径避免 utf8 超 100 字节。
function buildTarGz(entries: { name: string; content: string | Buffer }[]): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8')));
  parts.push(Buffer.alloc(1024, 0)); // 两个空块标记归档结束
  return zlib.gzipSync(Buffer.concat(parts));
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
      '  instances/<id>.log 每个实例：容器状态 + 持久日志 + 应用安装状态/日志 + 实时容器日志',
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
    let c = `实例: ${inst.name}\nID: ${inst.id}\n容器: ${inst.containerName}\n类型: ${instanceAppType(inst)}\n数据卷: ${inst.volumeName}（${await describeInstanceVolume(inst.volumeName)}）\n创建: ${inst.createdAt}\n\n`;
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
    // 应用安装状态 + 安装日志：排查「下载卡住/装不上」（此前诊断包里完全看不到安装为何失败）。
    // status.json = 面板轮询的进度/错误；install.log = wechat-ctl.sh 下载/解压每步（含 curl 退出码、已下字节）。
    try {
      // `|| true`：文件不存在时 cat/tail 会以非 0 退出，execCapture 视作失败抛错——加 || true 保证退出 0，
      // 拿到空串走下面的「（无）」分支，不因"还没装/旧镜像无日志"就整段丢失。
      const st = (await execCapture(inst, ['sh', '-c', 'cat /config/.woc-state/status.json 2>/dev/null || true'])).trim();
      c += `===== 应用安装状态（status.json） =====\n${st || '（无 / 尚未触发安装）'}\n\n`;
      const il = (await execCapture(inst, ['sh', '-c', 'tail -n 50 /config/.woc-state/install.log 2>/dev/null || true'])).trimEnd();
      c += `===== 安装日志（install.log 尾 50 行） =====\n${il || '（无 / 旧镜像未记录）'}\n\n`;
    } catch (e: any) {
      c += `===== 应用安装状态 / 安装日志 =====\n获取失败（容器可能未运行）：${e?.message || e}\n\n`;
    }
    try {
      c += `===== 本次容器日志（实时 tail 300） =====\n${(await instanceLogs(inst, 300)).trimEnd() || '（无）'}\n`;
    } catch (e: any) {
      c += `===== 本次容器日志 =====\n获取失败：${e?.message || e}\n`;
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

// 校验文件名为安全 basename（防路径穿越）。
function safeName(name: string): boolean {
  return !!name && name.length <= 200 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..';
}

// 壁纸/字体文件名：在 safeName 基础上，额外拒绝 shell 元字符。这些名字会被拼进 `sh -c '...${name}...'`
// （xwallpaper/fc-scan 等），拒绝 ' " $ ` \ ; & | < > 及换行后，单引号内插值不可能被逃逸/注入，正常文件名
//（含空格/括号/中文）仍放行。
function safeMediaName(name: string): boolean {
  return safeName(name) && !/['"$`\\;&|<>\r\n]/.test(name);
}

export async function uploadToInstance(inst: Instance, name: string, content: Buffer): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['sh', '-c', `mkdir -p ${TRANSFER_DIR}`]); // abc 家目录可写
  const c = docker.getContainer(inst.containerName);
  await c.putArchive(tarSingleFile(name, content), { path: TRANSFER_DIR });
}

export interface TransferFile {
  name: string;
  size: number;
  mtime: number; // 秒级 Unix 时间
}
export async function listInstanceFiles(inst: Instance): Promise<TransferFile[]> {
  const out = await execCapture(inst, [
    'sh',
    '-c',
    `find ${TRANSFER_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\t%T@\\n' 2>/dev/null`,
  ]);
  // 按修改时间倒序：最常见的用法是「刚在微信里另存到桌面 → 马上来下载」，最新的应在最上面。
  // （此前是 find 的目录原始顺序，文件一多就得在乱序列表里找。）
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, size, mtime] = line.split('\t');
      return { name, size: Number(size) || 0, mtime: Math.round(Number(mtime) || 0) };
    })
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

export async function deleteInstanceFile(inst: Instance, name: string): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  // argv 数组直传，不经 shell；safeName 已排除路径穿越
  await execCapture(inst, ['rm', '-f', `${TRANSFER_DIR}/${name}`]);
}

export async function downloadFromInstance(inst: Instance, name: string): Promise<Buffer> {
  if (!safeName(name)) throw new Error('文件名不合法');
  const c = docker.getContainer(inst.containerName);
  const stream = (await c.getArchive({ path: `${TRANSFER_DIR}/${name}` })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return extractSingleFileFromTar(Buffer.concat(chunks));
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

// 通过 xdotool 在实例容器内输入文字（绕过 VNC keysym 限制，解决中文 IME 吞字问题）。
// 用 base64 传递文本避免 shell 转义问题，xclip 写入剪贴板后 xdotool 模拟 Ctrl+V 粘贴。
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
    'xdotool key --clearmodifiers ctrl+v',
  ].join('; ');
  await execCapture(inst, ['bash', '-c', cmd]);
}

// 把本机剪贴板里的图片（截图等）粘进应用（issue #91）：写入容器的 X 剪贴板（目标类型即图片 MIME），
// 再按一次 Ctrl+V，效果等同于在容器里复制了一张图片后粘贴。图片先落到 /tmp（非持久卷，重启即清），
// xclip -i 读完文件后会常驻持有剪贴板选区，文件本身随后即可删除；这里顺手清掉 10 分钟前的旧文件。
const PASTE_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
export async function pasteImageInInstance(inst: Instance, mime: string, content: Buffer): Promise<void> {
  const ext = PASTE_IMAGE_TYPES[mime];
  if (!ext) throw new Error('不支持的图片类型');
  const name = `woc-paste-${Date.now()}.${ext}`;
  await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: '/tmp' });
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xclip >/dev/null 2>&1 || { echo "xclip not installed in instance image" >&2; exit 127; }',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    "find /tmp -maxdepth 1 -name 'woc-paste-*' -mmin +10 -delete 2>/dev/null || true",
    // 同 typeInInstance：xclip 常驻后台持有选区，必须重定向 fd，否则 docker exec 要等它退出（~2s）
    `xclip -selection clipboard -t ${mime} -i /tmp/${name} >/dev/null 2>&1`,
    'xdotool key --clearmodifiers ctrl+v',
  ].join('; ');
  await execCapture(inst, ['bash', '-c', cmd]);
}

// 通过 xdotool 在实例容器内模拟一次按键（如 Return / BackSpace）。
// 用于「无感输入」模式：中文经 xclip 转发期间，把被截下的回车/退格按序送出，保证顺序、避免抢跑。
// key 为 xdotool keysym 名，可带至多 3 个修饰键前缀（如 ctrl+v、ctrl+shift+Tab）；
// 只允许字母 / 下划线 / 固定修饰键名与 "+"，杜绝 shell 注入。
export async function keyInInstance(inst: Instance, key: string): Promise<void> {
  if (!/^(?:(?:ctrl|shift|alt|super)\+){0,3}[A-Za-z_]{1,20}$/.test(key)) throw new Error('按键名不合法');
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    `xdotool key --clearmodifiers ${key}`,
  ].join('; ');
  await execCapture(inst, ['bash', '-c', cmd]);
}

// ---------- 数据卷管理（仅管理员；路由层用 requireAdmin 限制） ----------
// 数据卷 = 容器内 /config 持久卷，含微信全部数据（登录态、加密聊天库等）。提供浏览/上传/解压/下载/
// 改名/移动/删除 + 整卷备份/恢复。主要场景：把 PC 微信数据迁移上来、跨实例迁移、离线备份。
// 路径安全：所有相对路径经 safeVolPath 归一化并严格限制在 /config 内，禁止 .. 穿越。
const VOL_ROOT = '/config';

// 把用户给的相对路径安全解析为 /config 下的绝对路径；禁止 .. 与 NUL；剥离前导 /。
function safeVolPath(rel: string): string {
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
// gzip 魔数自动识别（用户上传可能是 .tar 或 .tar.gz；本系统备份恒为 .gz）。
const maybeGunzip = (buf: Buffer): Buffer =>
  buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;

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

// 上传单个文件到指定目录（tarSingleFile 写入 uid/gid 1000，落地即 abc 属主，微信可读）。
export async function volUploadFile(inst: Instance, rel: string, name: string, content: Buffer): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  const dir = safeVolPath(rel);
  await execCapture(inst, ['mkdir', '-p', dir]);
  await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: dir });
}

// 上传压缩包并解压到指定目录（PC 微信数据迁移：用户把文件夹打成 .tar/.tar.gz 上传）。
// putArchive 把 tar 内容解到 dir 下，Docker 解包限制在 dir 内、防 .. 穿越。
export async function volExtractArchive(inst: Instance, rel: string, archive: Buffer): Promise<void> {
  const dir = safeVolPath(rel);
  await execCapture(inst, ['mkdir', '-p', dir]);
  await docker.getContainer(inst.containerName).putArchive(maybeGunzip(archive), { path: dir });
}

export async function volDownloadFile(inst: Instance, rel: string): Promise<Buffer> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('不能下载整个根目录，请用整卷备份');
  const stream = (await docker.getContainer(inst.containerName).getArchive({ path: abs })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return extractSingleFileFromTar(Buffer.concat(chunks));
}

// 整卷备份：把 /config 打成 tar 流并经 gzip 输出（路由直接 pipe 给响应，避免大文件入内存）。
// getArchive('/config') 的条目前缀为 config/，恢复时解到容器根即可落回 /config。
export async function volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream> {
  let helper: Docker.Container | undefined;
  let source = docker.getContainer(inst.containerName);
  try { await source.inspect(); }
  catch (e: any) {
    if (e?.statusCode !== 404) throw e;
    // inspect first: never let Docker silently create a missing production volume.
    await docker.getVolume(inst.volumeName).inspect();
    const image = await ensureImage();
    helper = await docker.createContainer({ Image: image, Entrypoint: ['/bin/sh'], Cmd: ['-c', 'sleep 3600'],
      HostConfig: { Binds: [`${inst.volumeName}:/config:ro`], NetworkMode: 'none', ReadonlyRootfs: true,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] } });
    try { await helper.start(); } catch (err) { await helper.remove({ force: true }); throw err; }
    source = helper;
  }
  let tar: NodeJS.ReadableStream;
  try { tar = await source.getArchive({ path: VOL_ROOT }) as NodeJS.ReadableStream; }
  catch (err) { if (helper) await helper.remove({ force: true }); throw err; }
  const gzip = zlib.createGzip();
  tar.on('error', (e) => gzip.destroy(e as Error));
  gzip.once('close', () => { (tar as any).destroy?.(); if (helper) void helper.remove({ force: true }).catch(() => {}); });
  return tar.pipe(gzip);
}

// 整卷恢复：仅适用于本系统导出的备份（条目前缀 config/），解到容器根 → 落回 /config。要求实例已停止。
export async function volRestoreArchive(inst: Instance, archive: Buffer): Promise<void> {
  await docker.getContainer(inst.containerName).putArchive(maybeGunzip(archive), { path: '/' });
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

// 检查实例容器内是否有某命令；没有则抛出友好错误（多为旧镜像未升级，避免用户看懵"退出码 127"）。
async function assertHasTool(inst: Instance, tool: string, msg: string): Promise<void> {
  let ok = false;
  try {
    const out = await execCapture(inst, ['sh', '-c', `command -v ${tool} >/dev/null 2>&1 && printf ok`]);
    ok = out.trim() === 'ok';
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(msg);
}

export async function applyBackground(inst: Instance, name: string): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await assertHasTool(inst, 'xwallpaper', '该实例镜像过旧（缺壁纸组件 xwallpaper）。请先在「管理」对该实例点「升级」，再设置壁纸。');
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
  // ⚠️ XSETTINGS 规范里 Xft/DPI 单位是「DPI × 1024」：96 DPI 必须写 98304。误写 96 会让所有
  // Chromium 内核应用（系统 Chromium / 微信内嵌 CEF）把缩放因子算成≈0 → 变换矩阵不可逆 →
  // GPU 进程连崩 → 窗口秒关/黑屏（v1.2.9~v1.3.1 的总根因，issue #111）。
  const lines = [
    'Xft/Antialias 1',
    'Xft/Hinting 1',
    'Xft/HintStyle "hintslight"',
    'Xft/RGBA "rgb"',
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
