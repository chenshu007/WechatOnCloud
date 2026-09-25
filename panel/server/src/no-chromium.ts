// Downstream policy: never infer image identity from a tag alone.
export const RETIRED_MESSAGE = 'Chromium 已退役（retired）；数据保留，可查看、导出或显式删除';
export const UPDATE_MESSAGE = 'no-Chromium 面板自更新已禁用，请通过定制双镜像发布流程更新';
export function assertActive(inst: { appType?: string }): void {
  if (inst.appType === 'chromium') throw new Error(RETIRED_MESSAGE);
}
export function assertImageRef(ref: string): string {
  if (!/^ghcr\.io\/chenshu007\/wechat-on-cloud:(?:v?\d+\.\d+\.\d+-no-chromium\.\d+)(?:@sha256:[a-f0-9]{64})?$/.test(ref)
      && !/^ghcr\.io\/chenshu007\/wechat-on-cloud@sha256:[a-f0-9]{64}$/.test(ref)) {
    throw new Error('必须显式配置 chenshu007 no-Chromium 实例镜像 tag 或 digest；禁止 latest / 普通版 / fallback');
  }
  return ref;
}
export function assertImageIdentity(image: any, expectedRevision = process.env.WOC_SOURCE_REVISION || '', expectedVersion = process.env.WOC_VERSION || ''): void {
  const labels = image.Config?.Labels || {};
  if (!/^[a-f0-9]{40}$/.test(expectedRevision) || !/^v?\d+\.\d+\.\d+-no-chromium\.\d+$/.test(expectedVersion)
      || labels['io.wechatoncloud.variant'] !== 'no-chromium'
      || labels['org.opencontainers.image.revision'] !== expectedRevision
      || labels['org.opencontainers.image.version'] !== expectedVersion
      || labels['org.opencontainers.image.source'] !== 'https://github.com/chenshu007/WechatOnCloud') {
    throw new Error('实例镜像身份不符：需要与面板相同的 no-Chromium version/source revision');
  }
}
export function rejectSelfUpdate(): never { throw new Error(UPDATE_MESSAGE); }
