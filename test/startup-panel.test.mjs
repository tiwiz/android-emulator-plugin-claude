import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startDaemon } from '../runtime/core/daemon.mjs';
import { HELPER_VERSION } from '../runtime/hosts/claude/config.mjs';
import { recordSessionStart } from '../runtime/hosts/claude/sessions.mjs';

class Leases extends EventEmitter {
  leases = {};
  starts = [];
  get(id) { return this.leases[id]; }
  touch() {}
  async avds() { return ['Test']; }
  async sweep() {}
  async create(_id, { name = 'Created' }) { return { name, profile: 'Pixel', image: 'Android' }; }
  async start(id, options) {
    this.starts.push(options);
    if (options.avd === 'Broken') throw new Error('Emulator could not boot.');
    return this.leases[id] ??= { avd: options.avd ?? 'Test', serial: `owned-${id}`, state: 'ready', readOnly: true };
  }
}

// The MCP server is a direct child of this test process, which stands in for Claude Code.
const session = (dir, source = 'startup') => recordSessionStart(dir, { session_id: crypto.randomUUID(), source, cwd: '/project' }, { pid: process.pid }).threadId;

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-startup-panel-')));
  const leases = new Leases();
  const service = await startDaemon({ dir, helperVersion: HELPER_VERSION, createLeases: () => leases, log() {} });
  const child = spawn(process.execPath, [new URL('../runtime/hosts/claude/mcp.mjs', import.meta.url).pathname], {
    env: { ...process.env, ANDROID_EMULATOR_CLAUDE_STATE_DIR: dir, CLAUDE_CODE_REMOTE: 'true' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let id = 0;
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  t.after(async () => {
    reader.close();
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = (method, params) => new Promise(resolve => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { dir, leases, request, call: (name, args = {}) => request('tools/call', { name, arguments: args }) };
}

const panelUrl = result => result.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/t\/\S+/)?.[0];

test('startup returns the session panel URL and reuses it for the same session', { timeout: 10_000 }, async t => {
  const { dir, call } = await fixture(t);
  const thread = session(dir);
  const first = await call('start_emulator');
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.emulator.serial, `owned-${thread}`);
  assert.equal(first._meta, undefined, 'Claude Code receives no host panel metadata');
  const url = new URL(panelUrl(first));
  assert.equal(url.pathname, `/t/${thread}`);
  assert.equal(url.searchParams.get('workspace'), '1');
  assert.match(first.content[0].text, /Device panel: /);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-view="device"/);
  assert.equal(panelUrl(await call('start_emulator')), url.href);
  assert.equal(panelUrl(await call('show_device_panel')), url.href);
  const other = session(dir, 'resume');
  const next = await call('start_emulator');
  assert.equal(new URL(panelUrl(next)).pathname, `/t/${other}`);
  assert.notEqual(new URL(panelUrl(next)).searchParams.get('k'), url.searchParams.get('k'));
});

test('create returns the panel only when it starts the device', { timeout: 10_000 }, async t => {
  const { dir, call, leases } = await fixture(t);
  session(dir);
  const saved = await call('create_emulator', { name: 'Saved', start: false });
  assert.equal(panelUrl(saved), undefined);
  assert.equal(leases.starts.length, 0);
  const started = await call('create_emulator', { name: 'New' });
  assert.equal(started.structuredContent.emulator.avd, 'New');
  assert.match(started.structuredContent.created, /Created New/);
  assert.equal(panelUrl(started), panelUrl(await call('show_device_panel')));
  assert.deepEqual(leases.starts, [{ avd: 'New' }]);
});

test('failed startup never returns a panel; tools carry no host UI metadata', { timeout: 10_000 }, async t => {
  const { dir, call, request } = await fixture(t);
  session(dir);
  for (const name of ['start_emulator', 'create_emulator']) {
    const failed = await call(name, { avd: 'Broken', name: 'Broken' });
    assert.equal(failed.isError, true);
    assert.equal(panelUrl(failed), undefined);
    assert.match(failed.content[0].text, /could not boot/);
  }
  const { tools } = await request('tools/list');
  assert.deepEqual(tools.filter(tool => tool._meta).map(tool => tool.name), []);
  for (const name of ['emulator_stream', 'emulator_apk', 'emulator_mentions']) assert.ok(!tools.some(tool => tool.name === name));
});

test('without a recorded session the server registers its own and keeps using it', { timeout: 10_000 }, async t => {
  const { call } = await fixture(t);
  const first = new URL(panelUrl(await call('show_device_panel'))).pathname;
  assert.match(first, /^\/t\/[0-9a-f-]{36}$/);
  assert.equal(new URL(panelUrl(await call('show_device_panel'))).pathname, first);
});
