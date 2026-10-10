import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME_VERSION } from '../../core/version.mjs';

export const PLUGIN_VERSION = RUNTIME_VERSION;

// Helper versions keep the shared runtime's epoch offset, so ordering stays consistent
// with the release history even though this host has its own state directory.
export function helperVersion(version) {
  return version.replace(/^\d+/, (major) => String(Number(major) + 2));
}
export const HELPER_VERSION = helperVersion(PLUGIN_VERSION);

// Kept outside ${CLAUDE_PLUGIN_DATA}: the helper outlives plugin updates and owns running emulators.
export function stateDir() {
  const dir = process.env.ANDROID_EMULATOR_CLAUDE_STATE_DIR
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Android Emulator for Claude Code')
      : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'android-emulator-claude-code'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const helperPort = () => Number(process.env.ANDROID_EMULATOR_CLAUDE_PORT ?? 47660);
