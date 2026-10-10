---
description: Show or change Android Emulator plugin settings
argument-hint: "[setting=value ...]"
---

Call the Android Emulator `read_plugin_settings` tool and show the current values briefly.

If the user supplied changes ($ARGUMENTS), apply only those with `update_plugin_settings`, then confirm the new values. Settings:

- `defaultAvd`: device started when none is named (`Automatic` or an AVD name).
- `keepCreatedDevices`: keep devices a session creates after the session ends.
- `idleMinutes`: stop emulators nobody is watching or using after this many minutes (0 never).
- `keepRunningAfterSessionEnd`: when true, emulators keep running after their session ends until the idle timeout, so a resumed session can reuse them. Default false: they stop when the session ends.
- `openPanelInBrowser`: open the device panel in the browser automatically.
- `videoQuality`: `Data saver`, `Balanced`, or `High`.
