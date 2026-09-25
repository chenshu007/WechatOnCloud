import { UPDATE_MESSAGE } from './no-chromium.js';
export const CURRENT_VERSION = (process.env.WOC_VERSION || 'dev-no-chromium').trim();
export interface VersionInfo {
  current: string; latest: string | null; hasUpdate: boolean; isDev: boolean;
  checkedAt: number; source: string | null; error: string | null;
  updatePolicy: string;
}
export function versionInfo(): VersionInfo {
  return { current: CURRENT_VERSION, latest: null, hasUpdate: false,
    isDev: !/^v?\d+\.\d+\.\d+-no-chromium\.\d+$/.test(CURRENT_VERSION),
    checkedAt: 0, source: 'no-chromium', error: null, updatePolicy: UPDATE_MESSAGE };
}
export async function checkForUpdate(): Promise<VersionInfo> { return versionInfo(); }
export function ensureChecked(): void {}
export function startUpdateChecker(): void {}
