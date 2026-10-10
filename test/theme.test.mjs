import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readClaudeTheme, themeMode } from '../runtime/hosts/claude/theme.mjs';
import { themeAttribute } from '../runtime/core/lib/appearance.mjs';

test('follows the Claude Code theme mode and ignores everything else in its config', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')), '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark-daltonized', projects: { '/tmp/x': { surface: '#ffffff' } } }));
  const theme = readClaudeTheme(file);
  assert.equal(theme.mode, 'dark');
  assert.deepEqual(theme.light, { surface: null, ink: null, accent: null, contrast: null, fontUi: null, fontCode: null });
  assert.deepEqual(theme.dark, theme.light);
  assert.doesNotMatch(themeAttribute(theme), /["<]/);
  assert.equal(readClaudeTheme(path.join(path.dirname(file), 'missing.json')), null);
  fs.writeFileSync(file, 'not json');
  assert.equal(readClaudeTheme(file), null);
  assert.deepEqual(['light', 'light-ansi', 'dark-ansi', 'auto', undefined, 42].map(themeMode), ['light', 'light', 'dark', 'system', 'system', 'system']);
});
