# Copilot Code Review Instructions

## Project Overview

This is a Jellyfin MPV Play project — a Node.js shim that connects to Jellyfin via WebSocket and controls MPV via Unix socket IPC, with native macOS menubar and Linux tray apps.

## Key Review Principles

1. **Log messages are contracts** — stdout is parsed by the macOS and Linux apps. Changing log message patterns will silently break both. See AGENTS.md for the full list.

2. **Tests exist but are limited** — `npm test` runs log-contract and config tests. Changes still need extra scrutiny since coverage is minimal.

3. **Thread safety matters** — Both native apps dispatch log parsing to the main thread from background threads. UI updates must happen on the main thread (GTK: via `GLib.idle_add`; Swift: via `DispatchQueue.main.async`).

4. **IPC race conditions** — MPV IPC communication uses async callbacks and a poll timer. Race conditions and hanging promises are common failure modes.

5. **Jellyfin API compliance** — `SupportedCommands` must use exact `GeneralCommandType` enum names from Jellyfin source. Wrong names cause 400 errors.

6. **WebSocket keep-alive** — The `ws` library v8.x auto-responds to protocol-level ping/pong. Don't add manual ping handlers. KeepAlive messages are sent every 30s. ForceKeepAlive data can be number, string, or object — always parse safely.

7. **Secrets redaction** — API keys and tokens must be redacted in log output using the `redact()` function.

## What to Look For

- Changes to console.log strings that match known patterns (see AGENTS.md)
- Missing error handling in async code
- Race conditions in playback state management
- Hardcoded paths that should be configurable
- Missing cleanup on shutdown
- Changes that would break the build script
- ForceKeepAlive data parsing (can be number, string, or object)
- WebSocket message types that should be handled but aren't

## Style Notes

- CommonJS modules (require/module.exports)
- No build step for Node.js code
- Swift code targets macOS 13.5+
- Python code targets 3.8+ (GTK3/PyGObject)
- MPV arguments are minimal — user's mpv.conf handles most settings
- IPC socket defaults to `$XDG_RUNTIME_DIR` on Linux
- Multi-config support: `node shim.js config.work.js`
