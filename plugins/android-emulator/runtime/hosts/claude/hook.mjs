// Claude Code hook entrypoint: `hook.mjs session-start|session-end` with the hook input on stdin.
// Hooks never block or print: stdout from SessionStart would be added to Claude's context.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './config.mjs';
import { recordSessionEnd, recordSessionStart } from './sessions.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

// Ask a running helper to clean up now instead of on its next interval. No helper, no work.
async function requestSweep(dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
    const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
    await fetch(`http://127.0.0.1:${info.port}/api/sweep`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000) });
  } catch {}
}

try {
  const dir = stateDir();
  const input = await readInput();
  if (process.argv[2] === 'session-start') recordSessionStart(dir, input);
  else if (process.argv[2] === 'session-end' && recordSessionEnd(dir, input)) await requestSweep(dir);
} catch (error) {
  process.stderr.write(`Android Emulator could not record the session: ${error.message}\n`);
}
