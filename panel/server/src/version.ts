import { UPDATE_MESSAGE } from './self-update.js';
export const CURRENT_VERSION = (process.env.WOC_VERSION || 'dev-no-chromium').trim();
export const BUILD_REVISION = (process.env.WOC_BUILD_REVISION || '').trim();
export interface VersionInfo {
  current: string; revision: string | null; latest: string | null;
  hasUpdate: boolean; isDev: boolean; checkedAt: number;
  source: string | null; error: string | null; updatePolicy: string;
}
export function versionInfo(): VersionInfo {
  return { current: CURRENT_VERSION, revision: BUILD_REVISION || null,
    latest: null, hasUpdate: false, isDev: CURRENT_VERSION.startsWith('dev'),
    checkedAt: 0, source: 'no-chromium', error: null, updatePolicy: UPDATE_MESSAGE };
}
export async function checkForUpdate(): Promise<VersionInfo> { return versionInfo(); }
export function ensureChecked(): void {}
export function startUpdateChecker(): void {}
