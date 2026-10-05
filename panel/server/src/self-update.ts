export const UPDATE_MESSAGE = 'no-Chromium 面板自更新已禁用，请通过定制发布流程更新';
// Both the HTTP path and legacy updater CLI must reject before Docker operations.
export async function triggerSelfUpdate(): Promise<{ target: string }> { throw new Error(UPDATE_MESSAGE); }
export async function runUpdaterRecreate(): Promise<void> { throw new Error(UPDATE_MESSAGE); }
