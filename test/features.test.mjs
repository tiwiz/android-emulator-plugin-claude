import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseBadging, parseSnapshotList } from '../runtime/core/lib/device.mjs';
import { Settings } from '../runtime/core/lib/settings.mjs';
import { TOOLS } from '../runtime/hosts/claude/tools.mjs';
import { TOOLS as SHARED_TOOLS } from '../runtime/core/tools.mjs';

test('settings validate values, persist, and fall back when the default device is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-settings-'));
  const settings = new Settings(dir);
  assert.equal(settings.get('keepRunningAfterSessionEnd'), false, 'emulators stop with their session by default');
  assert.equal(settings.get('openPanelInBrowser'), true);
  assert.throws(() => settings.update({ keepRunningAfterSessionEnd: 'yes' }), /boolean/);
  assert.throws(() => settings.update({ idleMinutes: -5 }), /0 to 1440/);
  assert.throws(() => settings.update({ videoQuality: 'Ultra' }), /videoQuality/);
  assert.throws(() => settings.update({ bogus: true }), /Unknown setting/);
  settings.update({ defaultAvd: 'Pixel_9', idleMinutes: 0 });
  assert.equal(new Settings(dir).get('idleMinutes'), 0);
  const page = new Settings(dir).describe(['Pixel_10a']);
  assert.equal(page.values.defaultAvd, 'Automatic');
  assert.deepEqual(page.schema.properties.defaultAvd.enum, ['Automatic', 'Pixel_10a']);
  for (const name of Object.keys(page.schema.properties)) assert.ok(name in page.values, `missing value for ${name}`);
});

test('aapt2 badging parses into the APK viewer facts', () => {
  const info = parseBadging(
    "package: name='com.example.app' versionCode='42' versionName='1.2.3' platformBuildVersionName='15'\n" +
      "minSdkVersion:'26'\ntargetSdkVersion:'35'\nuses-permission: name='android.permission.INTERNET'\n" +
      "uses-permission: name='android.permission.CAMERA'\napplication-label:'Example'\nlaunchable-activity: name='com.example.app.MainActivity'  label='' icon=''\n",
  );
  assert.deepEqual(info, {
    packageName: 'com.example.app',
    versionName: '1.2.3',
    versionCode: '42',
    label: 'Example',
    minSdk: '26',
    targetSdk: '35',
    launchActivity: 'com.example.app.MainActivity',
    permissions: ['android.permission.INTERNET', 'android.permission.CAMERA'],
  });
});

test('snapshot list keeps only loadable snapshots', () => {
  const output =
    'List of snapshots present on all disks:\r\nID        TAG                 VM SIZE                DATE       VM CLOCK\r\n' +
    '1         default_boot           312M 2026-09-30 14:24:20   00:01:10.000\r\n2         before_login           320M 2026-09-30 14:30:02   00:02:00.000\r\n\r\n' +
    "List of partial (non-loadable) snapshots on 'userdata':\r\nID        TAG\r\n1         broken                0 2026-09-30 14:24:20   00:00:00.000\r\nOK\r\n";
  assert.deepEqual(parseSnapshotList(output), ['before_login']);
  assert.deepEqual(parseSnapshotList('List of snapshots present on all disks:\r\nNone\r\n'), []);
});

test('shared tools keep a title and a theme-aware icon; Claude Code tools fit its name limit without host UI metadata', () => {
  for (const tool of SHARED_TOOLS) {
    assert.ok(tool.title, tool.name);
    const svg = Buffer.from(tool.icons?.[0]?.src.split(',')[1] ?? '', 'base64').toString();
    if (tool.icons) {
      assert.match(svg, /viewBox="0 0 20 20"/);
      assert.match(svg, /currentColor/);
    }
  }
  for (const tool of TOOLS) {
    assert.ok(`mcp__plugin_android-emulator_emu__${tool.name}`.length <= 64, tool.name);
    assert.equal(tool._meta, undefined, tool.name);
    assert.doesNotMatch(JSON.stringify(tool), /\bemulator_[a-z_]+\b|\bsettings_(?:read|update)\b/, tool.name);
  }
  const names = TOOLS.map(tool => tool.name);
  assert.ok(['read_plugin_settings', 'update_plugin_settings', 'show_device_manager'].every(name => names.includes(name)));
  assert.ok(!names.some(name => ['emulator_stream', 'emulator_apk', 'emulator_mentions'].includes(name)));
  const update = TOOLS.find(tool => tool.name === 'update_plugin_settings');
  assert.deepEqual(update.inputSchema.properties.set.properties.keepRunningAfterSessionEnd, { type: 'boolean' });
});

test('agent interaction tools expose bounded waits and long presses', () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const waitFor = byName.get('wait_for_screen');
  // First navigation use can prepare managed dependencies and notices.
  assert.equal(waitFor.annotations.readOnlyHint, false);
  assert.deepEqual(waitFor.inputSchema.properties.state.enum, ['appears', 'disappears']);
  assert.deepEqual(waitFor.inputSchema.properties.timeoutMs, { type: 'integer', minimum: 1, maximum: 30_000, description: 'Default 10000; maximum 30000.' });
  assert.deepEqual(byName.get('tap_screen').inputSchema.properties.durationMs, { type: 'integer', minimum: 1, maximum: 10_000, description: 'Long-press duration; maximum 10000.' });
});

test('agent device tools bound searches, expose partial observation, and keep app control explicit', () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const scrollTo = byName.get('scroll_to_element');
  assert.equal(scrollTo.annotations.readOnlyHint, false);
  assert.deepEqual(scrollTo.inputSchema.properties.maxSwipes, { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5; maximum 10.' });
  assert.deepEqual(scrollTo.inputSchema.properties.direction.enum, ['up', 'down', 'left', 'right']);
  assert.equal(scrollTo.inputSchema.properties.tap.description, 'Default false. Tap the element only after it is found.');
  // Observation persists screen memory.
  assert.equal(byName.get('inspect_screen').annotations.readOnlyHint, false);

  const type = byName.get('type_text');
  assert.deepEqual(type.inputSchema.required, ['text']);
  assert.deepEqual(Object.keys(type.inputSchema.properties.target.properties), ['text', 'description', 'resourceId']);

  const app = byName.get('manage_app');
  assert.deepEqual(app.inputSchema.required, ['action', 'packageName']);
  assert.deepEqual(app.inputSchema.properties.action.enum, ['restart', 'stop', 'grant_permission', 'revoke_permission']);
  assert.match(app.description, /never clears app data or uninstalls an app/);
});

test('helper versions compare numerically so an older chat never replaces a newer helper', async () => {
  const { compareVersions } = await import('../runtime/core/lib/sdk.mjs');
  assert.ok(compareVersions('0.10.0', '0.9.1') > 0);
  assert.ok(compareVersions('0.4.0', '0.6.0') < 0);
  assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
  assert.ok(compareVersions(undefined, '0.6.0') < 0);
});
