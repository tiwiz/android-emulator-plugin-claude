// Follows the Claude Code terminal theme (`theme` in ~/.claude.json). Claude Code has no
// chrome palette to share, so only the light/dark mode is passed to the panel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const claudeConfigFile = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json');

const EMPTY = { surface: null, ink: null, accent: null, contrast: null, fontUi: null, fontCode: null };

export function themeMode(value) {
  if (typeof value !== 'string') return 'system';
  if (value.startsWith('dark')) return 'dark';
  if (value.startsWith('light')) return 'light';
  return 'system';
}

// { mode: 'light' | 'dark' | 'system', light, dark }, or null when Claude Code has no readable config.
export function readClaudeTheme(file = claudeConfigFile()) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return { mode: themeMode(config?.theme), light: { ...EMPTY }, dark: { ...EMPTY } };
}

export function watchTheme(listener) {
  const file = claudeConfigFile();
  let last = JSON.stringify(readClaudeTheme(file));
  // ~/.claude.json changes often for unrelated reasons; only report a different theme.
  const onChange = () => {
    const theme = readClaudeTheme(file);
    const next = JSON.stringify(theme);
    if (next === last) return;
    last = next;
    listener(theme);
  };
  fs.watchFile(file, { interval: 2000, persistent: false }, onChange);
  return () => fs.unwatchFile(file, onChange);
}
