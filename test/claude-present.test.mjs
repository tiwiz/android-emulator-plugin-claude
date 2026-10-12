import assert from 'node:assert/strict';
import test from 'node:test';
import { openInBrowser, presentPanel, presentResult } from '../runtime/hosts/claude/present.mjs';

const url = 'http://127.0.0.1:47660/t/6f1c2f39-6a55-4a43-9d36-1d7c8b3e2a10?workspace=1&k=key';
const panel = (viewing = false) => ({ text: 'Started Pixel.', structuredContent: { emulator: { serial: 'emulator-5600' } }, meta: { panel: { panelUrl: url, viewing, channel: { key: 'key' } } } });

test('startup opens the browser panel once; explicit requests always open it', () => {
  const opened = [];
  const open = target => { opened.push(target); return true; };
  assert.equal(presentPanel('emulator_start', panel(), { open }).text, `Started Pixel.\nDevice panel opened in the browser: ${url}`);
  assert.equal(presentPanel('emulator_start', panel(true), { open }).text, `Started Pixel.\nDevice panel is already open in the browser: ${url}`);
  assert.equal(presentPanel('emulator_create', panel(), { open, autoOpen: false }).text, `Started Pixel.\nDevice panel: ${url}`);
  assert.match(presentPanel('emulator_panel', panel(true), { open, autoOpen: false }).text, /opened in the browser/);
  assert.deepEqual(opened, [url, url]);
  assert.equal(presentPanel('emulator_status', panel(), { open }).text, 'Started Pixel.', 'other tools never surface panel links');
  assert.equal(presentPanel('emulator_start', panel(), { open }).meta, undefined, 'host metadata is never forwarded');
});

test('structured results are mirrored into text that Claude reads', () => {
  const shown = presentResult('emulator_status', { text: 'Ready.', structuredContent: { emulator: { serial: 'emulator-5600' } } });
  assert.equal(shown.text, 'Ready.\n\n{"emulator":{"serial":"emulator-5600"}}');
  assert.equal(presentResult('settings_read', { text: '', structuredContent: { values: { idleMinutes: 60 } } }).text, '{"values":{"idleMinutes":60}}');
  const json = JSON.stringify({ a: 1 }, null, 2);
  assert.equal(presentResult('emulator_ui_tree', { text: json, structuredContent: { a: 1 } }).text, json);
  assert.equal(presentResult('emulator_key', { text: 'Pressed.' }).text, 'Pressed.');
});

test('only local helper pages open, and remote sessions never launch a browser', t => {
  const remote = process.env.CLAUDE_CODE_REMOTE;
  t.after(() => { if (remote === undefined) delete process.env.CLAUDE_CODE_REMOTE; else process.env.CLAUDE_CODE_REMOTE = remote; });
  delete process.env.CLAUDE_CODE_REMOTE;
  const launched = [];
  const launch = (command, args) => { launched.push([command, ...args]); return { on() {}, unref() {} }; };
  assert.equal(openInBrowser(url, { platform: 'darwin', launch }), true);
  assert.equal(openInBrowser(url, { platform: 'linux', launch }), true);
  assert.equal(openInBrowser(url, { platform: 'win32', launch }), true);
  assert.equal(openInBrowser(url, { platform: 'aix', launch }), false);
  assert.equal(openInBrowser('https://example.com/t/x', { platform: 'linux', launch }), false);
  process.env.CLAUDE_CODE_REMOTE = 'true';
  assert.equal(openInBrowser(url, { platform: 'linux', launch }), false);
  assert.deepEqual(launched, [['open', url], ['xdg-open', url], ['rundll32', 'url.dll,FileProtocolHandler', url]]);
});

test('large structured results are truncated in the mirrored text', () => {
  const text = presentResult('emulator_navigate', { text: 'Map.', structuredContent: { map: 'x'.repeat(20_000) } }).text;
  assert.ok(text.length < 16_100);
  assert.match(text, /\(structured result truncated\)$/);
});
