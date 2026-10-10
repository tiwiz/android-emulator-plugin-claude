import { collectDiagnostics as collectRuntimeDiagnostics } from '../../core/lib/diagnostics.mjs';
import { PLUGIN_VERSION, HELPER_VERSION } from './config.mjs';

// Claude Code renders no embedded panel, so the runtime reports host logs as unsupported.
export function collectDiagnostics(options) {
  return collectRuntimeDiagnostics({ ...options, version: PLUGIN_VERSION, helperVersion: HELPER_VERSION });
}
