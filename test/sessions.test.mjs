import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { currentThread, hostPid, parseWindowsProcesses, recordSessionEnd, recordSessionStart, threadStates } from '../runtime/hosts/claude/sessions.mjs';

const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const id = () => crypto.randomUUID();
const pid = process.pid;

test('the Claude Code process is the nearest ancestor that is not a shell wrapper', () => {
  const tree = { 50: { ppid: 40, name: 'node' }, 40: { ppid: 30, name: 'sh' }, 30: { ppid: 20, name: 'claude' }, 20: { ppid: 1, name: '-zsh' }, 60: { ppid: 30, name: 'node' } };
  const parent = pid => tree[pid] ?? null;
  assert.equal(hostPid(50, { parent }), 30, 'hook run through sh -c');
  assert.equal(hostPid(60, { parent }), 30, 'MCP server spawned directly');
  assert.equal(hostPid(process.pid), process.ppid, 'the test runner is not a shell');
});

test('on Windows the process table comes from one CIM listing and .exe shells are skipped', () => {
  const table = parseWindowsProcesses('0 0 System Idle Process\r\n4120 3010 node.exe\r\n3010 2900 bash.exe\r\n\r\n2900 1200 claude.exe\r\n5000 2900 node.exe\r\n6100 6000 node.exe\r\n6000 2950 cmd.exe\r\n2950 1200 node.exe\r\n');
  assert.deepEqual(table.get(3010), { ppid: 2900, name: 'bash.exe' });
  const parent = pid => table.get(pid) ?? null;
  assert.equal(hostPid(4120, { parent }), 2900, 'hook run through Git Bash');
  assert.equal(hostPid(5000, { parent }), 2900, 'MCP server spawned directly');
  assert.equal(hostPid(6100, { parent }), 2950, 'a hook run through cmd.exe under npm-installed Claude Code (node.exe)');
});

test('a session keeps its chat across /clear and compaction, and ends only on exit', t => {
  const dir = temporary(t);
  const first = id();
  const started = recordSessionStart(dir, { session_id: first, source: 'startup', cwd: '/projects/app', transcript_path: '/missing.jsonl' }, { pid });
  assert.equal(started.threadId, first);
  assert.equal(currentThread(dir, { pid }), first);
  assert.equal(recordSessionEnd(dir, { session_id: first, reason: 'clear' }, { pid }), null);
  const cleared = id();
  assert.equal(recordSessionStart(dir, { session_id: cleared, source: 'clear' }, { pid }).threadId, first);
  assert.equal(recordSessionStart(dir, { session_id: cleared, source: 'compact' }, { pid }).threadId, first);
  assert.deepEqual(Object.fromEntries(threadStates(dir, [first])), { [first]: { state: 'active', title: null, cwd: '/projects/app' } });
  assert.equal(recordSessionEnd(dir, { session_id: cleared, reason: 'prompt_input_exit' }, { pid }), first);
  assert.equal(currentThread(dir, { pid }), null);
  assert.equal(threadStates(dir, [first]).get(first).state, 'ended');
});

test('resuming continues the ended chat; switching sessions ends the previous one; forks start fresh', t => {
  const dir = temporary(t);
  const original = id();
  recordSessionStart(dir, { session_id: original, source: 'startup' }, { pid });
  recordSessionEnd(dir, { session_id: original, reason: 'other' }, { pid });
  assert.equal(recordSessionStart(dir, { session_id: original, source: 'resume' }, { pid }).threadId, original);
  assert.equal(threadStates(dir, [original]).get(original).state, 'active');
  const forked = recordSessionStart(dir, { session_id: original, source: 'fork' }, { pid }).threadId;
  assert.notEqual(forked, original, 'a fork never shares devices with its source');
  assert.equal(threadStates(dir, [original]).get(original).state, 'ended');
  const other = id();
  recordSessionStart(dir, { session_id: other, source: 'resume' }, { pid });
  assert.equal(threadStates(dir, [forked]).get(forked).state, 'ended');
  assert.equal(currentThread(dir, { pid }), other);
});

test('a session still owned by another live process is not taken over on resume', t => {
  const dir = temporary(t);
  const shared = id();
  recordSessionStart(dir, { session_id: shared, source: 'startup' }, { pid: process.ppid });
  const second = recordSessionStart(dir, { session_id: shared, source: 'resume' }, { pid }).threadId;
  assert.notEqual(second, shared);
  assert.equal(currentThread(dir, { pid: process.ppid }), shared);
});

test('chats end when their Claude Code process dies without SessionEnd; titles come from the first prompt', async t => {
  const dir = temporary(t);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  t.after(() => child.kill());
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'system', content: 'ignored' }),
    JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Test   the login\nscreen in dark mode' }] } }),
  ].join('\n'));
  const thread = recordSessionStart(dir, { session_id: id(), source: 'startup', transcript_path: transcript }, { pid: child.pid }).threadId;
  assert.deepEqual(threadStates(dir, [thread]).get(thread), { state: 'active', title: 'Test the login screen in dark mode', cwd: null });
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(threadStates(dir, [thread]).get(thread).state, 'ended');
  const unknown = id();
  assert.deepEqual(Object.fromEntries(threadStates(dir, [unknown, "x' or 1=1 --"])), { [unknown]: { state: 'missing', title: null, cwd: null } });
});

test('the hook entrypoint records sessions silently', async t => {
  const dir = temporary(t);
  const session = id();
  const hook = new URL('../runtime/hosts/claude/hook.mjs', import.meta.url).pathname;
  const run = (event, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, event], { env: { ...process.env, ANDROID_EMULATOR_CLAUDE_STATE_DIR: dir } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
    child.stdin.end(JSON.stringify(input));
  });
  assert.deepEqual(await run('session-start', { session_id: session, source: 'startup', cwd: '/p' }), { code: 0, output: '' });
  assert.equal(currentThread(dir, { pid }), session, 'the hook resolves the same Claude Code process as its MCP server');
  assert.deepEqual(await run('session-end', { session_id: session, reason: 'logout' }), { code: 0, output: '' });
  assert.equal(threadStates(dir, [session]).get(session).state, 'ended');
  assert.deepEqual(await run('session-start', 'not json'), { code: 0, output: '' });
});
