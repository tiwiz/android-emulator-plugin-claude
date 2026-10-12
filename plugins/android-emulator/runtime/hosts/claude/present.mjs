// Shapes runtime results for Claude Code. It has no embedded panel, so device panels are
// pages served by the local helper.
import { spawn } from 'node:child_process';
import { PANEL_TOOLS } from './tools.mjs';

export function openInBrowser(url, { platform = process.platform, launch = spawn } = {}) {
  if (process.env.CLAUDE_CODE_REMOTE === 'true' || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return false;
  // rundll32 opens the URL without cmd.exe, which would split it at `&`.
  const [command, ...prefix] = { darwin: ['open'], linux: ['xdg-open'], win32: ['rundll32', 'url.dll,FileProtocolHandler'] }[platform] ?? [];
  if (!command) return false;
  try {
    const child = launch(command, [...prefix, url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

// Claude Code has no embedded panel: surface the helper's local page instead of host metadata.
export function presentPanel(name, result, { open = openInBrowser, autoOpen = true } = {}) {
  const { meta, ...rest } = result ?? {};
  const url = PANEL_TOOLS.has(name) ? meta?.panel?.panelUrl : null;
  if (!url) return rest;
  const explicit = name === 'emulator_panel' || name === 'emulator_manager';
  const opened = (explicit || (autoOpen && !meta.panel.viewing)) && open(url);
  const label = name === 'emulator_manager' ? 'Device manager' : 'Device panel';
  const note = opened ? `${label} opened in the browser: ${url}` : meta.panel.viewing && !explicit ? `${label} is already open in the browser: ${url}` : `${label}: ${url}`;
  return { ...rest, text: [rest.text, note].filter(Boolean).join('\n') };
}

const MIRROR_LIMIT = 16_000;

// Claude reads tool content blocks; mirror structured results there unless the text already is that JSON.
export function presentResult(name, result, options) {
  const shown = presentPanel(name, result, options);
  if (!shown.structuredContent) return shown;
  const full = JSON.stringify(shown.structuredContent);
  const json = full.length > MIRROR_LIMIT ? `${full.slice(0, MIRROR_LIMIT)}… (structured result truncated)` : full;
  const text = shown.text ?? '';
  try { if (JSON.stringify(JSON.parse(text)) === full) return shown; } catch {}
  return { ...shown, text: text ? `${text}\n\n${json}` : json };
}
