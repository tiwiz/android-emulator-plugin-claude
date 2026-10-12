# Android™ Emulator Plugin for Claude Code

Run, control, and test Android apps from Claude Code. Pin emulators and connected Android devices to a session, then watch the agent work or take control in a live device panel in your browser.

## Features

- **Exclusive devices per session:** pin multiple emulators or connected Android devices for before/after testing. Each device belongs to one Claude Code session; moving a connected device to another session requires confirmation in the panel.
- **Live panel in the browser:** the plugin's local helper serves the device panel on `127.0.0.1`. It opens automatically when a session starts or pins a device. Switch between device tabs or drag one tab onto another to view both side by side; hidden tabs pause their streams.
- **Live controls:** tap, swipe, type, rotate, adjust volume, and change foldable posture.
- **Agent tools:** inspect screenshots and UI elements, target controls by name, enter text, and wait for screen changes.
- **App testing:** install APKs, open apps and links, manage permissions, and change device conditions such as dark mode, font size, location, and battery level.
- **Debugging and capture:** read Logcat, diagnose connection problems, capture screenshots, record video, and copy captures to the clipboard.
- **Screen memory:** automatically remember screens and routes as the agent uses an app. Return to a saved destination from the Screen map panel.

The device manager (`/android-emulator:manager`) lists running emulators across sessions and the virtual devices on disk. Multiple views of a device share its video encoder.

## Requirements

- Claude Code with plugin support, on macOS, Linux or Windows, with a desktop browser that supports WebCodecs on the same machine.
- Node.js 20 or newer on `PATH`; the plugin starts its server and hooks with `node`.
- On Windows, the SDK is found in `%LOCALAPPDATA%\Android\Sdk` or `ANDROID_HOME`. Screen memory's managed Minimap download supports only macOS and Linux.
- Android SDK Platform Tools. Virtual devices also need Android SDK Emulator and a system image. Android Studio can install these through SDK Manager.

Use an existing Android Virtual Device or ask Claude to create one. Set `ANDROID_HOME` if your SDK is installed in a custom location. Screen memory prepares its dependencies on first use and needs internet access for missing downloads.

For a physical device, enable USB debugging, connect it, and accept Android's debugging prompt. Select it from the panel's device dropdown. Unpinning releases the connection without shutting down the phone. The panel keeps mirroring while the screen is off or locked and follows the phone's own rotation. If the cable is unplugged, the pin stays with the session and mirroring resumes when the phone reconnects. Apps that block screen capture appear black. Rotation, simulated location/battery, fold posture, and snapshots require an emulator.

Screen memory may download Minimap and [Google's Android CLI](https://developer.android.com/tools/agents/android-cli/download) directly from their upstream servers. The CLI launcher can download its own runtime and is invoked even during version checks. Review the applicable [Android SDK terms](https://developer.android.com/studio/terms) before first use; users handle their own agreement. To use installations you manage yourself, set `ANDROID_EMULATOR_MINIMAP` and `ANDROID_EMULATOR_ANDROID_CLI` to those executables. These tools are downloaded separately and are not included in the plugin archive.

## Install

In Claude Code:

```text
/plugin marketplace add tiwiz/android-emulator-plugin-claude
/plugin install android-emulator@tiwiz
```

On Claude Code 2.1.275 or later, one step also works: `/plugin install android-emulator --marketplace tiwiz/android-emulator-plugin-claude`.

Or from your shell:

```sh
claude plugin marketplace add tiwiz/android-emulator-plugin-claude
claude plugin install android-emulator@tiwiz
```

Restart Claude Code, then ask:

> Start an Android emulator for this session.

You can also ask Claude to install an APK, test a screen, inspect Logcat, or diagnose a connection problem. Drag an APK onto the device panel to install it directly.

Device tools ask for permission on first use. To allow all of them, add `"mcp__plugin_android-emulator_emu"` to `permissions.allow` in your Claude Code settings.

## Sessions and settings

Each Claude Code session owns its devices. `/clear` and compaction keep them. When the session ends (you exit Claude Code), its emulators stop, connected phones are released, and AVDs it created are deleted unless you chose to keep them. Turn on **keepRunningAfterSessionEnd** to leave emulators running until the idle timeout instead; resuming the session with `claude --resume` then reuses them.

Use `/android-emulator:settings` (or ask Claude) to change:

| Setting | Default | Effect |
| --- | --- | --- |
| `defaultAvd` | `Automatic` | Device started when none is named. |
| `keepCreatedDevices` | `false` | Keep devices a session creates after the session ends. |
| `idleMinutes` | `60` | Stop emulators nobody is watching or using after this long; `0` never. |
| `keepRunningAfterSessionEnd` | `false` | Keep emulators running after their session ends, until the idle timeout. |
| `openPanelInBrowser` | `true` | Open the device panel in the browser automatically. |
| `videoQuality` | `Balanced` | `Data saver`, `Balanced`, or `High`. |

`/android-emulator:panel` reopens this session's device panel.

## Captures and screen memory

The camera and recording controls open a capture tray from which you can download or copy the capture. Ask Claude to take a screenshot when you want it to see the current screen; screenshots reach Claude as images, and recordings as a local video reference with up to four timestamped frames. Clipboard export requires macOS; video sample frames require `ffmpeg` and `ffprobe`.

Captures and new screen maps stay in the plugin's local state directory. Maps are separated by project and app; an existing matching `.minimap/` map is reused. Supported agent taps, swipes, and Back actions teach routes. Text entry, long presses, custom gestures, and manual panel input remain direct controls. The agent checks the current screen before using a learned route.

## Development

```sh
npm run build
npm test
claude --plugin-dir ./plugins/android-emulator
```

The shared service and UI live in `runtime/core`, MCP support in `runtime/mcp`, and the Claude Code integration in `runtime/hosts/claude`. Session hooks record which Claude Code process runs which session; the MCP server, a child of the same process, uses that record as its identity. Edit source under `runtime/`, then rebuild the generated plugin bundle in `plugins/android-emulator/`. Root `LICENSE` and `NOTICE` are authoritative; the build copies them into the runtime and installable plugin so retained helpers keep their notices. `claude plugin validate ./plugins/android-emulator` checks the manifest.

For a repeatable release ZIP from a clean committed checkout, run `npm run package:submission`. It builds, runs local tests, checks the actual archive and writes the ZIP, checksum, release notes and readiness report to `dist/`. Maintain a matching version entry in [CHANGELOG.md](CHANGELOG.md); packaging rejects missing or empty entries and generates the release notes from that section. The [release workflow](GITHUB-RELEASES.md) documents local publication and an optional manual GitHub workflow that defaults to artifacts and can attach them to an explicitly requested draft release; pushes do not trigger it.

## License and attribution

Apache-2.0. See [LICENSE](LICENSE). This is a modified version of [Matt McKenna's Android Emulator Plugin for Codex](https://github.com/mttmcknn/android-emulator-plugin), adapted for Claude Code.

The bundled, unmodified **scrcpy Android server 5.0.1** is licensed under Apache-2.0. Its [source information and binary component inventory](runtime/core/vendor/SCRCPY-SOURCE.md), [license](runtime/core/vendor/SCRCPY-LICENSE), and component notices are included. The plugin uses its own client and browser decoder; desktop scrcpy, FFmpeg, SDL and ADB are not bundled.

The Logcat icon uses [Lucide's Logs icon](https://lucide.dev/icons/logs) under the [ISC license](runtime/core/vendor/LUCIDE-LICENSE).

Android is a trademark of Google LLC. The Android robot is reproduced or modified from work created and shared by Google and used according to terms described in the [Creative Commons 3.0 Attribution License](https://creativecommons.org/licenses/by/3.0/). Modifications include redrawing, scaling, color and combining with a phone. This plugin is not made or endorsed by Google, OpenAI or Anthropic.

See [NOTICE](NOTICE) for distributed attribution and [LICENSE-AUDIT.md](LICENSE-AUDIT.md) for the release inventory, external tools, managed downloads, authoritative sources and unresolved publication risks. The audit is evidence for this artifact, not a legal guarantee.
