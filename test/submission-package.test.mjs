import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { committedBytes, committedFiles, extractChangelog, semanticVersion, validatePackage } from '../scripts/package-submission.mjs';
import { crc32, createZip, inspectZip } from '../scripts/submission-zip.mjs';
import { TOOLS, TOOL_NAMES } from '../runtime/hosts/claude/tools.mjs';
import { TOOLS as SHARED_TOOLS } from '../runtime/core/tools.mjs';

const plugin = new URL('../plugins/android-emulator/', import.meta.url);
const original = JSON.parse(fs.readFileSync(new URL('.claude-plugin/plugin.json', plugin), 'utf8'));
function packageFiles() {
  const files = new Map();
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name; const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) visit(url, relative + '/');
      else files.set(relative, { bytes: fs.readFileSync(url), mode: fs.statSync(url).mode });
    }
  }
  visit(plugin);
  files.set('CHANGELOG.md', { bytes: fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url)), mode: 0o100644 });
  return files;
}

test('the installable plugin passes package checks with its session hooks, skills and commands', () => {
  const checked = validatePackage(packageFiles(), original);
  assert.equal(checked.tool_count, TOOLS.length);
  assert.equal(checked.changelog.version, original.version);
  assert(checked.changelog.section.startsWith(`## [${original.version}]\n`));
  assert.deepEqual(checked.skills.sort(), ['skills/emulator/SKILL.md', 'skills/setup/SKILL.md']);
  assert.deepEqual(checked.commands.sort(), ['commands/manager.md', 'commands/panel.md', 'commands/settings.md']);
  assert.equal(checked.icons[0].file, 'assets/logo.svg');
});

test('package checks reject a top-level bin/, escaping paths, unknown hooks and mismatched versions', () => {
  const withBin = packageFiles(); withBin.set('bin/tool', { bytes: Buffer.from('#!/bin/sh\n'), mode: 0o100755 });
  assert.throws(() => validatePackage(withBin, original), /bin\//);
  const escaping = packageFiles(); escaping.set('.claude-plugin/plugin.json', { bytes: Buffer.from(JSON.stringify({ ...original, icon: './../secret.svg' })), mode: 0o100644 });
  assert.throws(() => validatePackage(escaping, original), /Unsafe contained/);
  const mismatch = packageFiles(); mismatch.set('.claude-plugin/plugin.json', { bytes: Buffer.from(JSON.stringify({ ...original, version: '0.0.0' })), mode: 0o100644 });
  assert.throws(() => validatePackage(mismatch, original));
  const hooks = packageFiles(); const config = JSON.parse(hooks.get('hooks/hooks.json').bytes);
  config.hooks.PreToolUse = config.hooks.SessionStart;
  hooks.set('hooks/hooks.json', { bytes: Buffer.from(JSON.stringify(config)), mode: 0o100644 });
  assert.throws(() => validatePackage(hooks, original), /session lifecycle/);
  const missingLauncher = packageFiles(); missingLauncher.delete('scripts/launch-node');
  assert.throws(() => validatePackage(missingLauncher, original), /Missing referenced file/);
});

test('deterministic standard ZIP retains bytes/executable mode and rejects corruption and traversal', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const entries = [{ name: 'plugin/bin/launch', bytes: Buffer.from('#!/bin/sh\n'), executable: true }, { name: 'plugin/LICENSE', bytes: Buffer.from('license\n') }];
  const zip = createZip(entries); assert.deepEqual(createZip([...entries].reverse()), zip);
  const files = inspectZip(zip); assert.equal(files.get('plugin/bin/launch').mode, 0o100755);
  assert.deepEqual(files.get('plugin/LICENSE').bytes, entries[1].bytes);
  const corrupt = Buffer.from(zip); corrupt[zip.indexOf('license\n')] ^= 1;
  assert.throws(() => inspectZip(corrupt));
  assert.throws(() => createZip([{ name: 'plugin/../secret', bytes: Buffer.from('x') }]), /Unsafe ZIP/);
  assert.throws(() => createZip([entries[0], entries[0]]), /Duplicate ZIP/);
  assert(semanticVersion.test(original.version)); assert(!semanticVersion.test('2026.10.08'));
});

test('tool hints cover confirmed persistence, downloads and destructive panel messages', () => {
  const tools = new Map(TOOLS.map(tool => [tool.name, tool]));
  const tool = name => tools.get(TOOL_NAMES[name] ?? name);
  for (const name of ['emulator_screenshot', 'emulator_ui_tree', 'emulator_wait_for', 'emulator_observe']) assert.equal(tool(name).annotations.readOnlyHint, false, name);
  for (const name of ['emulator_navigate', 'emulator_ui_tree', 'emulator_wait_for', 'emulator_tap', 'emulator_swipe', 'emulator_scroll_to', 'emulator_observe', 'emulator_type', 'emulator_app', 'emulator_key', 'emulator_open']) assert.equal(tool(name).annotations.openWorldHint, true, name);
  const shared = new Map(SHARED_TOOLS.map(item => [item.name, item]));
  assert.equal(shared.get('emulator_stream').annotations.destructiveHint, true);
  assert.equal(shared.get('emulator_apk').annotations.openWorldHint, true);
});

test('changelog extraction selects one nonempty version entry and normalizes line endings', () => {
  const section = '## [2026.10.9]\n\n### Added\n\n- A real release change.\n';
  const text = `# Changelog\n\n## [Unreleased]\n\n- Later work.\n\n${section}\n## [2026.10.8]\n\n- Earlier work.\n`;
  assert.equal(extractChangelog(Buffer.from(text), '2026.10.9'), section);
  assert.equal(extractChangelog(Buffer.from(text.replaceAll('\n', '\r\n')), '2026.10.9'), section);
  assert.throws(() => extractChangelog(Buffer.from(text), '0.0.0'), /exactly one/);
  assert.throws(() => extractChangelog(Buffer.from(text + section), '2026.10.9'), /exactly one/);
  for (const body of ['', '\n### Added\n', '\n<!-- pending actual notes -->\n### Fixed\n']) {
    assert.throws(() => extractChangelog(Buffer.from(`## [2026.10.9]\n${body}\n## [2026.10.8]\nPrior notes.\n`), '2026.10.9'), /empty/);
  }
});

test('package checks reject a missing changelog', () => {
  const missingChangelog = packageFiles(); missingChangelog.delete('CHANGELOG.md');
  assert.throws(() => validatePackage(missingChangelog, original), /Missing packaged CHANGELOG/);
});

test('ZIP inspection rejects inconsistent or unsupported local and central headers', () => {
  const zip = createZip([{ name: 'plugin/test.txt', bytes: Buffer.from('payload') }]);
  const central = zip.readUInt32LE(zip.length - 22 + 16);
  const mutations = [
    bytes => { bytes.writeUInt16LE(0x801, 6); bytes.writeUInt16LE(0x801, central + 8); },
    bytes => bytes.writeUInt16LE(0, 6),
    bytes => bytes.writeUInt32LE(0, central + 20),
    bytes => bytes.writeUInt32LE(0, 22),
    bytes => bytes.writeUInt32LE(0, 14),
    bytes => bytes.writeUInt16LE(8, central + 10),
    bytes => bytes.writeUInt16LE(8, 8),
    bytes => bytes.writeUInt32LE(central, central + 42),
    bytes => bytes.writeUInt16LE(2, zip.length - 22 + 8),
  ];
  for (const mutate of mutations) {
    const altered = Buffer.from(zip); mutate(altered);
    assert.throws(() => inspectZip(altered));
  }
});

test('packaging uses committed bytes and executable modes across clean host permission differences', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'android-plugin-git-mode-'));
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet'); fs.mkdirSync(path.join(repository, 'plugin'));
    const notice = path.join(repository, 'plugin/NOTICE'); const launcher = path.join(repository, 'plugin/launch');
    fs.writeFileSync(notice, 'notice\n'); fs.chmodSync(notice, 0o644);
    fs.writeFileSync(launcher, '#!/bin/sh\n'); fs.chmodSync(launcher, 0o755);
    git('add', 'plugin'); git('-c', 'user.name=Local Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    const archive = () => createZip([...committedFiles(repository, 'plugin/')].map(([name, file]) => ({ name: `plugin/${name}`, bytes: file.bytes, executable: Boolean(file.mode & 0o111) })));
    const before = archive();
    fs.chmodSync(notice, 0o654); assert.equal(git('status', '--porcelain'), '');
    git('config', 'core.filemode', 'false'); fs.chmodSync(launcher, 0o644);
    assert.equal(git('status', '--porcelain'), ''); assert.deepEqual(archive(), before);
    assert.equal(committedFiles(repository, 'plugin/').get('launch').mode, 0o100755);
    git('config', 'core.autocrlf', 'true'); fs.unlinkSync(notice); git('checkout', '--', 'plugin/NOTICE');
    assert.equal(fs.readFileSync(notice, 'utf8'), 'notice\r\n'); assert.equal(git('status', '--porcelain'), '');
    assert.equal(committedBytes('plugin/NOTICE', repository).toString('utf8'), 'notice\n'); assert.deepEqual(archive(), before);
  } finally { fs.rmSync(repository, { recursive: true, force: true }); }
});
