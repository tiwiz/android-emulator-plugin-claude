// Claude Code host adapter for the browser panel served by the local helper.
// Claude Code has no embedded panel, so the shared UI uses its WebSocket transport.
globalThis.emulatorHost = {
  embedded: false,
  label: 'Claude Code',
};
