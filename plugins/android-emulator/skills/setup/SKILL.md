---
name: setup
description: Set up the Android Emulator plugin after installation by checking the Android SDK, making sure a virtual device exists, and opening the device panel. Use when the user asks to set up the plugin or Android emulators in Claude Code.
---

# Set Up Android Emulator

1. Call `check_device_status`.
   - If Platform Tools are missing, tell the user to install them with Android Studio or sdkmanager and set `ANDROID_HOME` if the SDK is in a custom location. Stop there. Physical devices do not need the emulator package.
2. If the status lists no AVDs, call `create_emulator` with `profile: "pixel_9"`. If it reports that no system images are installed, tell the user to install one from Android Studio's SDK Manager, then stop.
3. Otherwise call `start_emulator` with no arguments.
4. Successful startup opens the device panel in the default browser and returns its local URL. Do not follow it with `show_device_panel`; use that tool only to reopen a closed panel or when the user asks to show it. If the panel did not open (for example over SSH), give the user the URL.
5. Tell the user, briefly, where things are:
   - The **device panel** in the browser shows the devices pinned to this session. Use its dropdown to pin a connected phone or add another emulator. Compare or drag one device tab onto another for side-by-side testing. Drag an APK onto the device to install it; the device controls list keyboard shortcuts.
   - `/android-emulator:manager` opens the device manager: every running emulator and the devices on disk.
   - `/android-emulator:settings` shows and changes settings: default device, idle shutdown, video quality, automatic panel opening, and whether emulators keep running after the session ends (off by default: they stop when the session ends).
   - Device tools ask for permission on first use. To allow them all, the user can add `"mcp__plugin_android-emulator_emu"` to `permissions.allow` in their Claude Code settings.
