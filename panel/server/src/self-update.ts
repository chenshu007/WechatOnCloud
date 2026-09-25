import { rejectSelfUpdate } from './no-chromium.js';
// Keep both public entrypoints fail-closed, including the old updater CLI.
export async function triggerSelfUpdate(): Promise<{ target: string }> { return rejectSelfUpdate(); }
export async function runUpdaterRecreate(): Promise<void> { rejectSelfUpdate(); }
