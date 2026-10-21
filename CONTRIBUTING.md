# Contributing to Jellyfin MPV Play

Thanks for your interest in contributing! This is a fork of [JohnGlaus/Jellyfin_mpv_play](https://github.com/JohnGlaus/Jellyfin_mpv_play).

## Development Setup

### Prerequisites

- **Node.js** v22 LTS (recommended) or v18+ (minimum, for running the shim directly)
- **MPV Player** — [mpv.io](https://mpv.io/installation/)
- **Jellyfin Server** — for testing
- **Xcode Command Line Tools** (macOS only, for building the native app)

### Quick Start

```bash
git clone https://github.com/MrGameVlogger/jellyfin-mpv-play.git
cd jellyfin-mpv-play
npm install
cp config.example.js config.js
# Edit config.js with your Jellyfin server details
npm start
```

### Building the macOS App

```bash
cd macapp
./build.sh
```

This compiles the Swift sources, bundles Node.js 24 LTS, and deploys to `/Applications`.

## Project Structure

```
jellyfin-mpv-play/
├── shim.js                  # Main Node.js application (the entire shim)
├── config.example.js        # Configuration template
├── package.json
├── macapp/
│   ├── Sources/             # Swift source files (11 files)
│   ├── Info.plist           # App metadata
│   ├── AppIcon.icns         # App icon
│   └── build.sh             # Build script
├── .github/
│   ├── ISSUE_TEMPLATE/      # Bug report, feature request
│   └── pull_request_template.md
├── AGENTS.md                # Agent context for AI assistants
├── SECURITY.md
└── README.md
```

## Code Style

### shim.js (Node.js)

- Uses CommonJS (`require`/`module.exports`)
- No build step — plain Node.js
- Log messages must match the patterns in `AGENTS.md` (the macOS app parses stdout)
- Use `console.log()` for state changes, `console.error()` for errors
- API keys and tokens must be redacted in log output (use `redact()` function)
- IPC socket defaults to `$XDG_RUNTIME_DIR` on Linux (user-private directory)
- Supports multi-config: `node shim.js config.work.js` for multiple Jellyfin accounts

### macapp/ (Swift)

- macOS 13.0+ minimum deployment target
- Uses Cocoa framework (AppKit)
- `ConfigParser.swift` is the shared utility for config file parsing
- `processLogLine()` runs on the main thread — keep it fast

## Queue System Architecture

The queue system manages playback of multiple items using MPV's native playlist.

### Key Concepts

- **`playQueue`** — Array of item IDs representing the user's queue
- **`queuePosition`** — Index of the currently playing item in `playQueue`
- **MPV Playlist** — MPV's built-in playlist, loaded from `playQueue` on connect

### How It Works

1. **PlayNow** — Clears the queue, adds the item, and loads it into MPV
2. **PlayNext** — Inserts the item at `queuePosition + 1` in both `playQueue` and MPV's playlist
3. **PlayLast** — Appends the item to the end of both `playQueue` and MPV's playlist
4. **Auto-advance** — MPV handles transitions natively via its playlist; the `playlist-pos` property observer updates `queuePosition`
5. **Cross-season** — When the queue is exhausted, queries `GET /Shows/NextUp` for the next season's episodes

### Important Flags

- **`isNewQueueLoad`** — Set when loading a new queue; prevents `playlist-pos` handler from treating it as an auto-advance
- **`isPlayingNext`** — Prevents double-triggering of episode transitions; has a 10s timeout fallback

### Log Line Contracts

The macOS app parses stdout from shim.js. These patterns must be preserved:

| Pattern | What Swift code does |
|---------|---------------------|
| `Episode detected: <title>` | Sets now-playing title |
| `Starting next episode: <title>` | Updates now-playing title |
| `Starting previous episode: <title>` | Updates now-playing title |
| `No more episodes` | Clears now-playing |

### Common Pitfalls

- Never push to `playQueue` without also updating MPV's playlist
- Clear `isPlayingNext` after 10s timeout in case `loadfile` silently fails
- The `markedWatched` Set prevents duplicate API calls; clear it on each new file load

## macOS App Architecture

The native macOS menubar app (`macapp/`) spawns the Node.js shim and parses its stdout for UI state.

### File Map (11 files)

| File | Role |
|------|------|
| `main.swift` | Entry point — creates NSApplication, assigns AppDelegate |
| `AppDelegate.swift` | Lifecycle: checks setup needed, starts/stops shim, prompts before quit during playback |
| `ConfigParser.swift` | Shared utility: config path, regex extraction, value escaping, Jellyfin auth test |
| `NodeProcessManager.swift` | Spawns `node shim.js`, captures stdout/stderr, parses log lines, sends MPV IPC commands |
| `StatusBarController.swift` | Menu bar icon (dynamic SF Symbols), dropdown menu, dispatches all actions |
| `PreferencesWindowController.swift` | Reads/writes config.js, "Test Connection" button, restarts shim on save (window title: Settings) |
| `SetupWindowController.swift` | 5-step wizard on first launch: server, credentials, MPV path, device info |
| `NotificationManager.swift` | UNUserNotificationCenter wrapper for connection/error banners |
| `LogWindowController.swift` | Timestamped, color-coded log viewer with auto-scroll, export, copy |
| `HelpWindowController.swift` | Scrollable reference guide (Getting Started, Controls, Shortcuts, Troubleshooting) |
| `AboutWindowController.swift` | Version, features, fork attribution, links |

### How It Works

1. `AppDelegate` checks if config is complete via `ConfigParser`
2. If incomplete → shows `SetupWindowController` wizard
3. If complete → calls `NodeProcessManager.start()`:
   - Copies shim.js + package.json to `~/Library/Application Support/JellyfinMpvPlay/`
   - Finds node binary (bundled → system → nvm)
   - Spawns `node shim.js` with `NODE_PATH` pointing to bundle's node_modules
   - Captures stdout/stderr via Pipe, dispatches to main thread
4. `processLogLine()` runs on main thread, parses each line:
   - Updates `isPlaying`, `isPaused`, `nowPlaying` state
   - Fires callbacks → `StatusBarController` updates icon/menu
   - Fires `notificationHandler` for errors and connection events
5. `StatusBarController` manages the NSStatusItem with dynamic SF Symbol icons

### Key Design Decisions

- `processLogLine` always runs on main thread (dispatched from GCD background)
- `isStoppingPlayback` flag prevents stale log lines after user clicks Stop
- Config is a CommonJS module parsed with regex (not `eval`)
- `setupApplicationSupport()` always overwrites shim.js from bundle on launch

## Submitting Changes

1. **Fork** the repository
2. **Create a branch** from `main`
3. **Make your changes** — follow the code style above
4. **Test** on your platform (macOS, Windows, or Linux)
5. **Submit a Pull Request** — fill out the PR template

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Update README if adding user-facing features
- Bump version in `package.json` if releasing (Info.plist is auto-synced by CI)
- No secrets or credentials in the diff

## Reporting Bugs

Use the [Bug Report](https://github.com/MrGameVlogger/jellyfin-mpv-play/issues/new?template=bug_report.md) template. Include:
- Platform and OS version
- App version (menu bar → About)
- Steps to reproduce
- Logs (menu bar → Show Logs → Export on macOS)

## Feature Requests

Use the [Feature Request](https://github.com/MrGameVlogger/jellyfin-mpv-play/issues/new?template=feature_request.md) template.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
