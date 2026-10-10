import { TOOLS as sharedTools, EMULATOR_INSTRUCTIONS, iconFor } from '../../core/tools.mjs';
export { iconFor };

// Claude Code shows tool names in its transcript; keep them readable. Runtime operation IDs stay stable.
// Plugin tools are exposed as mcp__plugin_android-emulator_emu__<name>; keep that within 64 characters.
export const TOOL_NAMES = Object.freeze({
  emulator_devices: 'list_devices',
  emulator_pin: 'pin_device',
  emulator_navigate: 'navigate_app',
  emulator_backends: 'manage_device_tools',
  emulator_status: 'check_device_status',
  emulator_diagnostics: 'diagnose_device_issues',
  emulator_panel: 'show_device_panel',
  emulator_manager: 'show_device_manager',
  emulator_create: 'create_emulator',
  emulator_start: 'start_emulator',
  emulator_stop: 'stop_or_unpin_device',
  emulator_screenshot: 'take_screenshot',
  emulator_capture: 'view_or_copy_captures',
  emulator_ui_tree: 'read_screen_elements',
  emulator_wait_for: 'wait_for_screen',
  emulator_tap: 'tap_screen',
  emulator_swipe: 'swipe_screen',
  emulator_scroll_to: 'scroll_to_element',
  emulator_observe: 'inspect_screen',
  emulator_type: 'type_text',
  emulator_app: 'manage_app',
  emulator_key: 'press_device_key',
  emulator_install: 'install_app',
  emulator_open: 'open_app_or_link',
  emulator_settings: 'change_device_settings',
  emulator_record: 'record_screen',
  emulator_snapshot: 'manage_emulator_snapshots',
  emulator_adb: 'run_device_command',
  settings_read: 'read_plugin_settings',
  settings_update: 'update_plugin_settings',
});
// Embedded-panel transports and host entrypoints (APK file viewer, composer mentions) have no Claude Code equivalent.
const UNSUPPORTED = new Set(['emulator_apk', 'emulator_mentions', 'emulator_stream']);
// Callable without a session identity.
export const THREADLESS = new Set(['settings_read', 'settings_update', 'emulator_manager']);
// Tools whose result carries a browser panel URL.
export const PANEL_TOOLS = new Set(['emulator_panel', 'emulator_manager', 'emulator_start', 'emulator_create', 'emulator_pin']);

const runtimeNames = new Map(Object.entries(TOOL_NAMES).map(([internal, exposed]) => [exposed, internal]));
export const runtimeToolName = name => runtimeNames.get(name) ?? name;
export const toolReferences = text => text.replace(/\bemulator_[a-z_]+\b|\bsettings_(?:read|update)\b/g, name => TOOL_NAMES[name] ?? name);

const DESCRIPTIONS = {
  emulator_panel: "Open this session's live Android device panel in the browser and return its local URL. Startup already opens it; call this only when the user closed the panel or asks to show it.",
  emulator_manager: 'Open the device manager in the browser: running emulators across all Claude Code sessions and the virtual devices stored on this computer.',
  settings_read: 'Read Android Emulator plugin settings: default device, idle shutdown, whether emulators keep running after a session ends, browser panel opening, and video quality.',
  settings_update: 'Update Android Emulator plugin settings when the user asks to change them.',
};

export const TOOLS = sharedTools.filter(tool => !UNSUPPORTED.has(tool.name)).map(({ _meta, icons, ...tool }) => ({
  ...tool,
  name: TOOL_NAMES[tool.name] ?? tool.name,
  description: toolReferences(DESCRIPTIONS[tool.name] ?? tool.description),
  inputSchema: JSON.parse(toolReferences(JSON.stringify(tool.inputSchema))),
}));

export const INSTRUCTIONS = toolReferences('In Claude Code, "chat" means this Claude Code session. The device panel is a local browser page: startup opens it automatically unless the user turned that off, and every panel result includes its URL. Give the user the URL when the panel did not open. ' +
  'When the session ends, its emulators stop unless the user enabled keepRunningAfterSessionEnd with settings_update; then they stop after the idle timeout and a resumed session can reuse them. ' +
  EMULATOR_INSTRUCTIONS);
