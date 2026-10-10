import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { errorDetails, diagnosticError } from '../runtime/core/lib/errors.mjs';
import { HELPER_VERSION } from '../runtime/hosts/claude/config.mjs';
import { recordSessionStart } from '../runtime/hosts/claude/sessions.mjs';

const THREAD = '6f1c2f39-6a55-4a43-9d36-1d7c8b3e2a10';
// The MCP server is a direct child of this test process, which stands in for Claude Code.
const bind = state => recordSessionStart(state, { session_id: THREAD, source: 'startup', cwd: '/project' }, { pid: process.pid });

function client(t, state) {
  const child = spawn(process.execPath, [new URL('../runtime/hosts/claude/mcp.mjs', import.meta.url).pathname], {
    env: { ...process.env, ANDROID_EMULATOR_CLAUDE_STATE_DIR: state, CLAUDE_CODE_REMOTE: 'true' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 0;
  const pending = new Map();
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const result = JSON.parse(line);
    pending.get(result.id)?.(result);
    pending.delete(result.id);
  });
  t.after(async () => {
    reader.close();
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(state, { recursive: true, force: true });
  });
  return (method, params = {}) => new Promise(resolve => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('Claude Code gets no UI resources, and listing never starts a helper', { timeout: 5000 }, async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-error-resource-'));
  bind(state);
  const request = client(t, state);
  assert.deepEqual((await request('resources/list')).result.resources, []);
  assert.equal((await request('resources/read', { uri: 'ui://android-emulator-plugin/panel.html' })).error.code, -32602);
  assert.equal(fs.existsSync(path.join(state, 'daemon.json')), false, 'Listing cannot start a helper');
  assert.ok(fs.readdirSync(path.join(state, 'runtimes')).length, 'The runtime is retained before any call');
});

test('lost helper reply has a diagnostic code and never replays the action', { timeout: 5000 }, async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-error-helper-'));
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid, version: HELPER_VERSION }));
    calls++;
    res.end('invalid reply');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ pid: process.pid, port: server.address().port }));
  fs.writeFileSync(path.join(state, 'token'), 'test-token-never-in-errors');
  bind(state);
  const request = client(t, state);
  const response = await request('tools/call', { name: 'check_device_status' });
  assert.equal(response.result.structuredContent.error.code, 'AE_HELPER_CONNECT');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(response), /test-token|127\.0\.0\.1/);
});


test('public diagnostic metadata never includes arbitrary exception or argument text', () => {
  for (const error of [new Error('secret tool argument'), diagnosticError('AE_HELPER_CONNECT', 'http://127.0.0.1/?key=secret')]) {
    assert.doesNotMatch(JSON.stringify(errorDetails(error)), /secret|127\.0\.0\.1/);
  }
});

test('agent diagnostics work without a helper or chat identity and preserve saved leases', { timeout: 5000 }, async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-diagnostics-mcp-'));
  const saved = JSON.stringify({ leases: {
    [THREAD]: { serial: 'emulator-5602', state: 'ready', pid: process.pid, secret: 'private-owned-field' },
    'other-thread': { serial: 'emulator-5698', state: 'ready', secret: 'private-other-field' },
  } });
  fs.writeFileSync(path.join(state, 'leases.json'), saved);
  bind(state);
  const request = client(t, state);
  const listing = await request('tools/list');
  assert.equal(listing.result.tools.find(tool => tool.name === 'diagnose_device_issues').annotations.readOnlyHint, true);
  const result = (await request('tools/call', { name: 'diagnose_device_issues' })).result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.helper.status, 'not_found');
  assert.equal(result.structuredContent.device.serial, 'emulator-5602');
  assert.equal(result.structuredContent.device.source, 'saved_state');
  assert.equal(result.structuredContent.device.processRunning, true);
  assert.equal(result.structuredContent.display, null);
  assert.doesNotMatch(JSON.stringify(result), /private-|other-thread|emulator-5698/);
  assert.equal(result.structuredContent.host.status, 'unsupported');
  // Another session sees none of this session's saved device.
  recordSessionStart(state, { session_id: crypto.randomUUID(), source: 'startup' }, { pid: process.pid });
  const other = (await request('tools/call', { name: 'diagnose_device_issues' })).result;
  assert.equal(other.structuredContent.chatBound, true);
  assert.equal(other.structuredContent.device.state, 'unassigned');
  assert.doesNotMatch(JSON.stringify(other), /emulator-5602|private-/);
  assert.equal(fs.existsSync(path.join(state, 'daemon.json')), false);
  assert.equal(fs.readFileSync(path.join(state, 'leases.json'), 'utf8'), saved);
});

test('capture tools return labeled image samples to the agent and keep download keys out of content', { timeout: 5000 }, async t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-capture-mcp-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid, version: HELPER_VERSION }));
    res.end(JSON.stringify({ ok: true, result: {
      text: 'Saved video with timestamped samples',
      images: [{ title: 'Frame at 0.00s', data: 'frame-zero', mimeType: 'image/png' }, { title: 'Frame at 1.00s', data: 'frame-one', mimeType: 'image/png' }],
      structuredContent: { capture: { id: 'capture-id', file: '/owned/video.mp4' } },
      meta: { capture: { downloadUrl: 'http://localhost/private?key=hidden-download-key' } },
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ pid: process.pid, port: server.address().port }));
  fs.writeFileSync(path.join(state, 'token'), 'private-token');
  bind(state);
  const request = client(t, state);
  const response = (await request('tools/call', { name: 'view_or_copy_captures', arguments: { action: 'context', captureId: 'capture-id' } })).result;
  assert.deepEqual(response.content.map(block => block.type), ['text', 'text', 'image', 'text', 'image']);
  assert.equal(response.content[3].text, 'Frame at 1.00s');
  assert.equal(response.structuredContent.capture.file, '/owned/video.mp4');
  assert.doesNotMatch(JSON.stringify([response.content, response.structuredContent]), /hidden-download-key|private-token/);
});
