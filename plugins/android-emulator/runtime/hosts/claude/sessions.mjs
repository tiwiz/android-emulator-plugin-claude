// Claude Code session registry. Hooks record which session a Claude Code process is running;
// the MCP server, a child of that same process, resolves its chat identity from the record.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'launch-node']);
// Session switches inside one process are followed by SessionStart; only real exits end a chat.
const CONTINUING = new Set(['clear', 'resume']);
const TITLE_BYTES = 256 * 1024;

const registry = dir => {
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
};
const threadFile = (dir, threadId) => path.join(registry(dir), `thread-${threadId}.json`);
const processFile = (dir, pid) => path.join(registry(dir), `process-${pid}.json`);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function parentOf(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      return { ppid, name };
    } catch { return null; }
  }
  try {
    const [ppid, ...command] = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim().split(/\s+/);
    return { ppid: Number(ppid), name: path.basename(command.join(' ')) };
  } catch { return null; }
}

// The Claude Code process is the nearest ancestor that is not a shell wrapper. Hooks may run
// through `sh -c` while stdio MCP servers are spawned directly, so both resolve the same PID.
export function hostPid(start = process.pid, { parent = parentOf } = {}) {
  let pid = parent(start)?.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth += 1) {
    const info = parent(pid);
    if (!info) return pid;
    if (!SHELLS.has(info.name.replace(/^-/, ''))) return pid;
    pid = info.ppid;
  }
  return null;
}

export function readThread(dir, threadId) {
  return UUID.test(threadId ?? '') ? readJson(threadFile(dir, threadId)) : null;
}

function endThread(dir, threadId, reason) {
  const thread = readThread(dir, threadId);
  if (!thread || thread.state === 'ended') return;
  writeJson(threadFile(dir, threadId), { ...thread, state: 'ended', endedAt: new Date().toISOString(), endReason: reason });
}

function threadForSession(dir, sessionId) {
  const direct = readThread(dir, sessionId);
  if (direct?.sessionIds?.includes(sessionId)) return direct;
  for (const name of fs.readdirSync(registry(dir))) {
    if (!/^thread-.*\.json$/.test(name)) continue;
    const thread = readJson(path.join(registry(dir), name));
    if (thread?.sessionIds?.includes(sessionId)) return thread;
  }
  return null;
}

// SessionStart. /clear and compaction keep the chat; resuming a session continues its chat
// when no other live Claude Code process still owns it.
export function recordSessionStart(dir, input, { pid = hostPid(), now = new Date() } = {}) {
  const sessionId = input?.session_id;
  if (!UUID.test(sessionId ?? '') || !pid) return null;
  const previous = readJson(processFile(dir, pid));
  const current = previous && readThread(dir, previous.threadId);
  let thread = null;
  if (['clear', 'compact'].includes(input.source) && current?.state === 'active') thread = current;
  else if (input.source !== 'fork') {
    const known = threadForSession(dir, sessionId);
    if (known && (known.state === 'ended' || known.pid === pid || !processAlive(known.pid))) thread = known;
  }
  if (current && current.threadId !== thread?.threadId) endThread(dir, current.threadId, 'switched');
  const threadId = thread?.threadId ?? (readThread(dir, sessionId) ? crypto.randomUUID() : sessionId);
  const next = {
    threadId,
    sessionIds: [...new Set([...(thread?.sessionIds ?? []), sessionId])],
    cwd: typeof input.cwd === 'string' ? input.cwd : thread?.cwd ?? null,
    transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : thread?.transcriptPath ?? null,
    title: typeof input.session_title === 'string' && input.session_title.trim() ? input.session_title.trim().slice(0, 120) : thread?.title ?? null,
    pid, state: 'active', startedAt: thread?.startedAt ?? now.toISOString(), updatedAt: now.toISOString(),
  };
  writeJson(threadFile(dir, threadId), next);
  writeJson(processFile(dir, pid), { pid, threadId, sessionId, updatedAt: now.toISOString() });
  return next;
}

// SessionEnd. Returns the ended chat, or null when the process continues in another session.
export function recordSessionEnd(dir, input, { pid = hostPid() } = {}) {
  if (CONTINUING.has(input?.reason)) return null;
  const owner = pid ? readJson(processFile(dir, pid)) : null;
  const thread = (owner && readThread(dir, owner.threadId)) ?? (UUID.test(input?.session_id ?? '') ? threadForSession(dir, input.session_id) : null);
  if (!thread) return null;
  endThread(dir, thread.threadId, input?.reason ?? 'other');
  if (owner?.threadId === thread.threadId) fs.rmSync(processFile(dir, pid), { force: true });
  return thread.threadId;
}

// The chat identity for calls from this MCP server, or null when no hook has recorded one.
export function currentThread(dir, { pid = hostPid() } = {}) {
  const owner = pid ? readJson(processFile(dir, pid)) : null;
  const thread = owner && readThread(dir, owner.threadId);
  return thread?.state === 'active' ? thread.threadId : null;
}

function transcriptTitle(file) {
  if (!file) return null;
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(TITLE_BYTES);
    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString('utf8', 0, bytes).split('\n')) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'user' || entry.isMeta) continue;
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find(part => part?.type === 'text')?.text : null;
      const title = text?.replace(/\s+/g, ' ').trim();
      if (title && !title.startsWith('<')) return title.length > 80 ? `${title.slice(0, 79)}…` : title;
    }
  } catch {}
  finally { if (handle !== undefined) fs.closeSync(handle); }
  return null;
}

// Map<threadId, { state: 'active' | 'ended' | 'missing', title, cwd }> for the shared runtime.
// A chat whose Claude Code process died without SessionEnd counts as ended.
export function threadStates(dir, threadIds) {
  const states = new Map();
  for (const id of new Set(threadIds)) {
    if (!UUID.test(id ?? '')) continue;
    const thread = readThread(dir, id);
    if (!thread) { states.set(id, { state: 'missing', title: null, cwd: null }); continue; }
    const state = thread.state === 'active' && processAlive(thread.pid) ? 'active' : 'ended';
    let title = thread.title;
    if (!title && (title = transcriptTitle(thread.transcriptPath))) {
      // Panels poll chat titles; remember the first prompt instead of rereading the transcript.
      try { writeJson(threadFile(dir, id), { ...(readThread(dir, id) ?? thread), title }); } catch {}
    }
    states.set(id, { state, title, cwd: thread.cwd });
  }
  return states;
}
