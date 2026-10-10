// Claude Code entrypoint: binds the hook-recorded session to the shared emulator runtime.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelperClient } from '../../mcp/helper-client.mjs';
import { retainRuntime } from '../../mcp/runtime-copy.mjs';
import { createMcpHandler, serveMcp } from '../../mcp/server.mjs';
import { diagnosticError } from '../../core/lib/errors.mjs';
import { Settings } from '../../core/lib/settings.mjs';
import { PLUGIN_VERSION, HELPER_VERSION, stateDir } from './config.mjs';
import { presentResult } from './present.mjs';
import { collectDiagnostics } from './diagnostics.mjs';
import { currentThread, hostPid, recordSessionStart } from './sessions.mjs';
import { INSTRUCTIONS, THREADLESS, TOOLS, iconFor, runtimeToolName } from './tools.mjs';

const dir = stateDir();
const runtimeRoot = retainRuntime(fileURLToPath(new URL('../../', import.meta.url)), dir);
const webDir = path.join(runtimeRoot, 'core', 'web');
const helper = createHelperClient({ dir, daemonFile: path.join(runtimeRoot, 'hosts', 'claude', 'daemon.mjs'), helperVersion: HELPER_VERSION });
const pid = hostPid() ?? process.pid;

// Hooks normally record the session before the first tool call. Without them (hooks disabled,
// or an older Claude Code), this server process registers its own chat, which ends with it.
let fallbackThread;
function threadId() {
  const recorded = currentThread(dir, { pid });
  if (recorded) return recorded;
  fallbackThread ??= recordSessionStart(dir, { session_id: crypto.randomUUID(), source: 'startup', cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd() }, { pid })?.threadId;
  return currentThread(dir, { pid }) ?? fallbackThread;
}

serveMcp(createMcpHandler({
  serverInfo: { name: 'android-emulator', title: 'Android Emulator', version: PLUGIN_VERSION, icons: iconFor('android') },
  instructions: INSTRUCTIONS, tools: TOOLS,
  readResource(uri) {
    throw Object.assign(new Error(`Unknown resource ${uri}`), { code: -32602 });
  },
  async callTool(exposedName, args) {
    const name = runtimeToolName(exposedName);
    const thread = THREADLESS.has(name) ? null : threadId();
    // Diagnostics cannot upgrade/restart a helper, even if the plugin just updated.
    if (name === 'emulator_diagnostics') return collectDiagnostics({ dir, webDir, info: helper.readInfo(), threadId: thread });
    if (!thread && !THREADLESS.has(name)) throw diagnosticError('AE_THREAD_REQUIRED', 'Claude Code did not supply a session identity. Restart Claude Code and try again.');
    const result = await helper.call(thread, name, args);
    return presentResult(name, result, { autoOpen: new Settings(dir).get('openPanelInBrowser') });
  },
}));
