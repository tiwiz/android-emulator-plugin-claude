import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectDiagnostics } from '../runtime/hosts/claude/diagnostics.mjs';
import { HELPER_VERSION, PLUGIN_VERSION } from '../runtime/hosts/claude/config.mjs';

test('diagnostics never upgrade a helper and only request a read-only chat snapshot when supported', { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-helper-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['index.html', 'app.js', 'app.css']) fs.writeFileSync(path.join(dir, file), 'fixture');
  let helperVersion = '1.2.2';
  let malformed = false;
  let oversized = null;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push(req.url);
    if (oversized === req.url) return res.end(JSON.stringify({ private: 'x'.repeat(70 * 1024) }));
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid, version: helperVersion, pluginVersion: helperVersion === HELPER_VERSION ? PLUGIN_VERSION : '0.2.2', ...(helperVersion === HELPER_VERSION ? { capabilities: { diagnostics: true } } : {}) }));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { threadId: 'this-chat', tool: 'emulator_diagnostics', args: {} });
    assert.equal(req.headers.authorization, 'Bearer private-access-key');
    if (malformed) return res.end('private malformed reply');
    res.end(JSON.stringify({ ok: true, result: { structuredContent: {
      schemaVersion: 1,
      device: { state: 'ready', serial: 'emulator-5602', processRunning: true, privateField: 'secret-device-content' },
      display: { viewers: 2, encoderActive: true, videoSessionReady: true, retryPending: false, consecutiveFailures: 0, inputActive: false, panelUrl: 'http://private/?key=secret' },
      otherThreads: ['private-other-chat'],
    } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { dir, webDir: dir, info: { pid: process.pid, port: server.address().port, token: 'private-access-key' }, threadId: 'this-chat' };
  const old = (await collectDiagnostics(options)).structuredContent;
  assert.equal(old.host.status, 'unsupported', 'Claude Code has no embedded panel logs');
  assert.equal(old.helper.snapshot, 'unsupported');
  assert.ok(old.findings.some(f => f.code === 'AE_VERSION_MISMATCH'));
  assert.deepEqual(calls, ['/health'], 'do not shut down or upgrade an old helper');
  helperVersion = HELPER_VERSION;
  const current = await collectDiagnostics(options);
  assert.equal(current.structuredContent.device.source, 'helper');
  assert.equal(current.structuredContent.device.serial, 'emulator-5602');
  assert.equal(current.structuredContent.display.viewers, 2);
  assert.equal(current.structuredContent.findings.some(f => ['AE_VERSION_MISMATCH', 'AE_DIAGNOSTICS_PARTIAL'].includes(f.code)), false);
  assert.doesNotMatch(JSON.stringify(current), /private|secret/);
  malformed = true;
  const partial = await collectDiagnostics(options);
  assert.equal(partial.structuredContent.helper.status, 'reachable');
  assert.equal(partial.structuredContent.helper.snapshot, 'unavailable');
  assert.ok(partial.structuredContent.findings.some(f => f.code === 'AE_DIAGNOSTICS_PARTIAL'));
  assert.doesNotMatch(JSON.stringify(partial), /private|secret/);
  assert.deepEqual(calls, ['/health', '/health', '/api/call', '/health', '/api/call']);
  malformed = false;
  oversized = '/api/call';
  const largeSnapshot = await collectDiagnostics(options);
  assert.equal(largeSnapshot.structuredContent.helper.snapshot, 'unavailable');
  assert.equal(largeSnapshot.structuredContent.display, null);
  oversized = '/health';
  const largeHealth = await collectDiagnostics(options);
  assert.equal(largeHealth.structuredContent.helper.status, 'unreachable');
  assert.ok(JSON.stringify(largeHealth).length < 8000);
});
