<p align="center">
  <img src="images/logo-banner.svg" width="400" alt="Jellyfin MPV Play">
</p>

<p align="center">
  Control your <b>MPV player</b> from the <b>Jellyfin web interface</b>.<br>
  Play movies and series with hardware acceleration, auto-resume, and auto-play next episode.
</p>

<p align="center">
  <a href="https://github.com/MrGameVlogger/jellyfin-mpv-play/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/MrGameVlogger/jellyfin-mpv-play?style=flat-square&label=latest%20release"></a>
  <a href="https://github.com/MrGameVlogger/jellyfin-mpv-play/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square">
  <a href="https://github.com/MrGameVlogger/jellyfin-mpv-play/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/MrGameVlogger/jellyfin-mpv-play/total?style=flat-square"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%20LTS-brightgreen?style=flat-square&logo=node.js">
</p>

<p align="center">
  <i>Fork of <a href="https://github.com/JohnGlaus/Jellyfin_mpv_play">JohnGlaus/Jellyfin_mpv_play</a> — adds native macOS menubar app, cross-platform bundles, setup wizard, and stability fixes.</i>
</p>

---

## Features

- **Remote Control** — Play from any device on your network
- **Smart Resume** — Remembers where you left off; "Play from beginning" in Jellyfin starts fresh
- **Auto-Play Next Episode** — Binge-watch series seamlessly with cross-season support
- **Full Queue System** — Native MPV playlist; Play Next / Play Last from Jellyfin UI; next/prev navigation
- **SyncPlay Support** — Join SyncPlay groups from Jellyfin web UI; synchronized playback with other clients
- **Auto-Skip Intros/Outros** — MediaSegments API integration; auto-skip after 3s or press S to skip; `autoSkipIntros` config option
- **Next-Up Notification** — Shows "Next up: SeriesName - SxEp" 10 seconds before episode ends
- **EOF Detection** — Reliable end-of-file detection via MPV's `eof-reached` property for accurate auto-advance
- **Error OSD Messages** — Connection/auth errors shown in MPV with rate limiting
- **Hardware Acceleration** — Smooth playback powered by MPV with `--cache=yes` for network streams
- **Auto-Reconnect** — Handles network interruptions with exponential backoff
- **Subtitle Sync** — Change subtitles in MPV, Jellyfin tracks the change
- **Display Messages** — Jellyfin notifications appear as OSD overlays in MPV
- **Fullscreen Mode** — Optional auto-fullscreen on startup
- **Auto-Close** — Optional shutdown when playback queue is exhausted
- **Custom MPV Flags** — Pass any MPV options from config
- **Headless Mode** — Run as a background service on Linux (systemd support)
- **Multi-Config Support** — Run multiple instances with different configs (`node shim.js config.work.js`), or same config with `--allow-duplicates` flag
- **Better Logging** — Structured `[timestamp] [component]` format with `verbose` config option
- **Native macOS App** — Menubar icon, notifications, preferences editor, log viewer, setup wizard, config file selector
- **Self-Contained Bundles** — All platforms bundle Node.js 22 LTS; just install MPV and go
- **Built-in Help** — Reference guide accessible from the menu bar (macOS)

---

## Downloads

<a href="https://github.com/MrGameVlogger/jellyfin-mpv-play/releases/latest"><img alt="macOS" src="https://img.shields.io/badge/macOS-.app-blue?style=for-the-badge&logo=apple"></a>
<a href="https://github.com/MrGameVlogger/jellyfin-mpv-play/releases/latest"><img alt="Linux" src="https://img.shields.io/badge/Linux-.tar.gz-yellow?style=for-the-badge&logo=linux"></a>
<a href="https://github.com/MrGameVlogger/jellyfin-mpv-play/releases/latest"><img alt="Windows" src="https://img.shields.io/badge/Windows-.zip-blue?style=for-the-badge&logo=windows"></a>

All bundles include their own Node.js runtime. Only [MPV Player](https://mpv.io/installation/) is required.

---

## Quick Start

### macOS

1. **Install MPV** via Homebrew:
   ```bash
   brew install mpv
   ```

2. **Download** the latest release from [Releases](https://github.com/MrGameVlogger/jellyfin-mpv-play/releases), or build from source:
   ```bash
   git clone https://github.com/MrGameVlogger/jellyfin-mpv-play.git
   cd jellyfin-mpv-play
   npm install
   cd macapp
   ./build.sh
   ```
   The build compiles the Swift app, downloads Node.js 22 LTS, and bundles everything into a self-contained `.app` (~175MB) deployed to `/Applications`.

3. **Remove quarantine** (required for downloaded apps):
   ```bash
   xattr -cr "/Applications/Jellyfin MPV Play.app"
   ```
   macOS marks downloaded apps with a quarantine flag. Without removing it, you'll get a "damaged or can't be opened" error.

4. **Launch** — if you built from source, the app is already deployed to `/Applications`. Otherwise drag `Jellyfin MPV Play.app` there, then right-click → Open (first launch only, to bypass Gatekeeper)

5. **Set up** — the app walks you through a setup wizard on first launch:
   - Welcome overview
   - Enter your Jellyfin server URL
   - Enter your username and password (with a Test Connection button)
   - Confirm MPV path and device settings
   - Done!

   > Config is saved to `~/Library/Application Support/JellyfinMpvPlay/config.js`. You can edit it manually or from the Settings menu.

### Windows

1. **Install MPV** — download from [mpv.io/installation](https://mpv.io/installation/) and add to your PATH

2. **Download** the latest `JellyfinMPVPlay-Windows-*.zip` from [Releases](https://github.com/MrGameVlogger/jellyfin-mpv-play/releases)

3. **Extract** the zip to any folder (e.g. `C:\Apps\JellyfinMPVPlay`)

4. **Configure** — double-click `launch.bat` once. It creates `config.js` from the template. Edit it with your Jellyfin server details:
   ```javascript
   module.exports = {
       serverUrl: 'http://192.168.1.100:8096',
       username: 'your_username',
       password: 'your_password',
       mpvPath: 'mpv',  // or full path like 'C:\\Program Files\\mpv\\mpv.exe'
       deviceName: 'My-PC',
       deviceId: 'my-pc'
   };
   ```

5. **Run** — double-click `launch.bat`

### Linux

1. **Install MPV:**
   ```bash
   # Ubuntu/Debian
   sudo apt install mpv
   # Fedora
   sudo dnf install mpv
   # Arch
   sudo pacman -S mpv
   ```

2. **Download** the latest `JellyfinMPVPlay-Linux-*.tar.gz` from [Releases](https://github.com/MrGameVlogger/jellyfin-mpv-play/releases)

3. **Extract** and configure:
   ```bash
   tar -xzf JellyfinMPVPlay-Linux-*.tar.gz
   cd JellyfinMPVPlay-Linux-*
   ./launch.sh    # First run creates config.js
   ```
   Edit `config.js` with your Jellyfin server details:
   ```javascript
   module.exports = {
       serverUrl: 'http://192.168.1.100:8096',
       username: 'your_username',
       password: 'your_password',
       mpvPath: '/usr/bin/mpv',
       deviceName: 'My-PC',
       deviceId: 'my-pc',
       // fullscreen: true,       // Start MPV in fullscreen
       // autoClose: true,         // Close app when queue finishes
       // mpvFlags: [],            // Extra MPV flags
       // headless: true,          // Suppress console output, log to data/shim-<configname>.log
   };
   ```

4. **Run:**
   ```bash
   ./launch.sh
   ```

   > To add to your app launcher, copy `jellyfin-mpv-play.desktop` to `~/.local/share/applications/` and update the `Exec` path.

#### Headless / Background Service

Run without a terminal window:

```bash
./launch.sh --headless
```

Logs are written to `data/shim-<configname>.log` instead of the terminal. With `--allow-duplicates`, each instance gets `shim-<configname>-<PID>.log`. If a duplicate is detected without the flag, a random suffix is used to avoid overwriting.

To run as a systemd service (auto-start on login, auto-restart on crash):

```bash
./launch.sh --install-service
systemctl --user start jellyfin-mpv-play
```

View logs: `journalctl --user -u jellyfin-mpv-play -f`

To remove the service:
```bash
./launch.sh --uninstall-service
```

---

## How to Use

1. **Start the app** — macOS: click the menu bar icon · Windows: double-click `launch.bat` · Linux: run `./launch.sh`
2. **Open Jellyfin** in your web browser
3. **Pick something to watch** — any movie or episode
4. **Click "Play on"** — the cast icon or "Play on" button
5. **Enjoy!** — MPV opens automatically and starts playing

<table>
  <tr>
    <td align="center"><img src="images/1.png" width="300"><br><sub>1. Click the cast icon in Jellyfin</sub></td>
    <td align="center"><img src="images/2.png" width="300"><br><sub>2. Select your device from the list</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="images/3.png" width="300"><br><sub>3. Device connects and shows in the top bar</sub></td>
    <td align="center"><img src="images/4.png" width="300"><br><sub>4. Remote control options appear</sub></td>
  </tr>
</table>

---

## Keyboard Shortcuts

While watching in MPV:

| Key | Action |
|-----|--------|
| `>` | Next episode |
| `<` | Previous episode |
| `S` | Skip intro/outro |
| `j` | Cycle subtitles (synced to Jellyfin) |

MPV's native `Media Next` / `Media Previous` keys also work for playlist navigation.

---

## Optional Add-ons

### [thumbfast-jellyfin](https://github.com/MrGameVlogger/thumbfast-jellyfin) — Thumbnail Previews

A drop-in replacement for [thumbfast](https://github.com/po5/thumbfast) that fetches pre-generated thumbnails from Jellyfin's Trickplay API. Hover over the seekbar to see instant thumbnail previews without local video decoding.

**Requirements:** MPV v0.38+, curl, ffmpeg, Jellyfin server with Trickplay enabled, and a thumbfast-compatible OSC such as [uosc](https://github.com/tomasklaen/uosc), [ModernX](https://github.com/cyl0/ModernX), or the [osc.lua fork](https://github.com/po5/thumbfast/blob/vanilla-osc/player/lua/osc.lua) for the vanilla UI.

**Install:** Download `thumbfast-jellyfin.lua` and place it as `thumbfast.lua` in your MPV scripts directory (`~/.config/mpv/scripts/` on Linux/macOS, `%APPDATA%\mpv\scripts\` on Windows).

### [jf-mpv-osc](https://github.com/iwalton3/jf-mpv-osc) — Jellyfin-Styled Player UI

Replaces MPV's default on-screen controller with a Jellyfin-styled UI: Material icons, action sheets for subtitle/audio selection, floating Skip Intro/Skip Credits button, and thumbnail seek previews. The shim automatically detects and integrates with it when installed.

**Requirements:** MPV v0.38+

**Install:** Download `trickplay-jf-osc.lua` and place it in your MPV scripts directory. Add `--script=trickplay-jf-osc.lua --osc=no` to your `mpvFlags` in `config.js`.

**Integration level:** The shim supports Tier 0-3 and partial Tier 4 of the [jf-mpv-osc contract](https://github.com/iwalton3/jf-mpv-osc#adoption-tiers):

| Tier | Feature | Status | Notes |
|------|---------|--------|-------|
| 0 | Jellyfin-styled UI | ✅ | Works automatically when loaded |
| 1 | Track naming | ✅ | Subtitle/audio labels from Jellyfin MediaStreams |
| 2 | Skip button | ✅ | Intro/outro skip button appears when segments detected |
| 3 | Queue navigation | ✅ | Next/previous item buttons work |
| 3 | Favorites | ✅ | Heart button toggles favorite via Jellyfin API |
| 3 | Screenshot | ✅ | Takes MPV screenshot |
| 3 | Fullscreen | ✅ | Toggles MPV fullscreen |
| 3 | Unwatched quit | ✅ | Quits without marking as watched |
| 4 | Subtitle styling | ✅ | Size, position, color options in settings |
| 4 | Quality selection | ❌ | Requires transcode API integration |
| 4 | Shader profiles | ❌ | Requires shader management |
| 4 | SyncPlay | ✅ | Group join/leave, waiting/ready states, UTC time sync |

All integration is optional — if jf-mpv-osc isn't loaded, the `script-message` calls are silently ignored by MPV.

---

## Auto-Start (Optional)

### macOS

The easiest way: click the menu bar icon → **Open at Login**.

Or manually:
1. Open **System Settings** → **General** → **Login Items**
2. Click the **+** button
3. Navigate to `/Applications` and select `Jellyfin MPV Play.app`

### Linux

**Option A: Systemd service (recommended)**

```bash
./launch.sh --install-service
systemctl --user start jellyfin-mpv-play
```

This creates a user service that starts on login and restarts on crash. Logs: `journalctl --user -u jellyfin-mpv-play -f`

**Option B: Desktop file**

Copy `jellyfin-mpv-play.desktop` to `~/.local/share/applications/` and update the `Exec` path. Right-click the entry in your app launcher to set it as a startup app.

**Option C: Cron**

```bash
crontab -e
# Add: @reboot /path/to/launch.sh --headless
```

### Windows

**Option A: Use the bundle** — edit `launch.bat` to add it to your Startup folder, or create a shortcut.

**Option B: Manual setup:**

**Create `start.bat`:**
```batch
@echo off
cd /d "C:\path\to\JellyfinMPVPlay"
node\node.exe shim.js
```

**Create `start.vbs`** (runs silently):
```vbscript
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & "C:\path\to\start.bat" & Chr(34), 0
Set WshShell = Nothing
```

**Add to Startup:**
1. Press `Win + R`, type `shell:startup`, press Enter
2. Create a shortcut to `start.vbs` in the Startup folder

> **Change the paths** to match your installation folder

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **macOS: "app is damaged/can't be opened"** | Run `xattr -cr "/Applications/Jellyfin MPV Play.app"` to remove the quarantine flag |
| **"config.js file not found"** | Run the launcher once to auto-create `config.js`, then edit with your details |
| **`Error: Cannot find module './config.js'`** | Same as above — `config.js` doesn't exist yet. Run the launcher or copy `config.example.js` to `config.js` |
| **`Error: Cannot find module 'ws'`** | Dependencies missing — run `npm install` in the project directory |
| **MPV doesn't open / `spawn ... ENOENT`** | Wrong `mpvPath` — test with `mpv --version` in terminal. Common paths: macOS `/opt/homebrew/bin/mpv`, Linux `/usr/bin/mpv`, Windows `mpv` (if in PATH) |
| **`MPV closed with error` (exit code 1)** | Invalid `mpvFlags`, missing video driver, or display issue. Test `mpv --idle=yes` manually. Check `~/.config/mpv/mpv.conf` |
| **`WebSocket error: connect ECONNREFUSED`** | Server unreachable — verify `serverUrl` includes `http://` and port (e.g., `http://192.168.1.100:8096`). Ensure server is running |
| **`Authentication error: ... 401`** | Wrong credentials — verify `username` and `password` in `config.js` |
| **`Token expired, reauthenticating...`** | Normal during reconnection. If repeated, re-enter your credentials |
| **`IPC error: connect ECONNREFUSED`** | MPV crashed or hasn't started — check `mpvPath`. The shim retries 10 times automatically |
| **`Maximum IPC connection attempts reached`** | MPV won't start — test `mpv --idle=yes` manually. Check for invalid `mpvFlags` |
| **`deviceId` equals `deviceName`** | Must be different strings per Jellyfin's device registration. Leave `deviceId` empty to auto-generate a unique one per config |
| **Device doesn't appear in Jellyfin** | Verify `serverUrl`, username, password. Ensure same network |
| **Playback doesn't resume** | Wait at least 10 seconds before closing MPV |
| **Black screen / no video** | Check `~/.config/mpv/mpv.conf` for valid `vo` and `hwdec` settings |
| **Episode navigation (`>`/`<`) not working** | Custom keybinds in `~/.config/mpv/input.conf` may override defaults |
| **`serverUrl` format** | Use `http://host:port` — no trailing slash, no `ws://` prefix. The shim converts HTTP to WS automatically |
| **Headless mode — where are logs?** | Check `data/shim-<configname>.log`. On Linux with systemd: `journalctl --user -u jellyfin-mpv-play -f` |
| **Multiple instances conflict** | Set different `ipcSocketPath` in each `config.js`, or use multi-config: `node shim.js config.work.js`. For same config: `node shim.js config.js --allow-duplicates` |
| **WebSocket disconnects every ~30 min** | Likely a reverse proxy connection timeout (nginx, Apache, Caddy). The shim reconnects automatically within ~20 seconds. Playback is not affected. |
| **Linux: "mpv is not installed"** | Install via `sudo apt install mpv` (or your distro's package manager) |
| **Windows: "mpv is not installed"** | Download from [mpv.io](https://mpv.io/installation/) and add to your PATH |

---

## Project Structure

```
jellyfin-mpv-play/
├── macapp/                  # Native macOS app
│   ├── Sources/             #   Swift source files
│   ├── build.sh             #   Build script (downloads + bundles Node.js)
│   ├── AppIcon.icns         #   App icon (macOS .icns format)
│   └── Info.plist           #   App metadata
├── linux/                   # Linux bundle launcher
│   ├── launch.sh            #   Launcher script (--headless, --install-service)
│   ├── jellyfin-mpv-play.service  #   Systemd user service
│   └── jellyfin-mpv-play.desktop  #   Desktop integration
├── windows/                 # Windows bundle launcher
│   └── launch.bat           #   Launcher script
├── images/                  # Logo SVGs and screenshots
│   ├── logo.svg             #   Full logo with text
│   ├── icon.svg             #   App icon (no text)
│   ├── icon-light.svg       #   Light variant
│   ├── icon-dark.svg        #   Dark variant
│   ├── logo-banner.svg      #   Horizontal banner for README
│   └── 1-4.png              #   Step-by-step screenshots
├── data/                    # Runtime state (auto-generated, gitignored)
├── node_modules/            # Dependencies (gitignored)
├── config.example.js        # Configuration template
├── config.js                # Your config — never commit! (gitignored)
├── shim.js                  # Main Node.js application (the entire shim)
├── package.json
└── README.md
```

---

## Security

- **Never share `config.js`** — it contains your password
- Your password is only used to authenticate with Jellyfin
- Tokens and playback positions are stored locally in the `data/` folder with restricted permissions (chmod 600/700)
- API keys and tokens are redacted in log output
- `config.js` and `data/` are gitignored — they stay on your machine
- On Linux, the IPC socket defaults to `$XDG_RUNTIME_DIR` (user-private directory) instead of `/tmp`

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full release history.

### Recent Releases

**v1.12.4** — Removed the WS refresh watchdog that disconnected the web UI's cast every 25 min ([details](CHANGELOG.md#v1124))

**v1.12.3** — Reap orphaned mpv processes (stray windows from crashed runs/force-quits) ([details](CHANGELOG.md#v1123))

**v1.12.2** — OSC state fidelity, correct sub_style defaults, safe ASS edits, unwatched-quit semantics ([details](CHANGELOG.md#v1122))

**v1.12.1** — Web-UI parity fixes: DisplayMessage no longer pauses, faster reconnects, restored menu shortcuts, macOS HIG pass C ([details](CHANGELOG.md#v1121))


<details>
<summary><b>Older releases</b></summary>

**v1.12.0** — Web-UI-parity release: track selection, shuffle, series vs specials plays, watched marking, EPIPE crash fix, macOS HIG pass, live E2E suite ([details](CHANGELOG.md#v1120))
**v1.11.7** — Fixed wrong episode playing on queue load, invalid mpv commands for insert-at and volume ([details](CHANGELOG.md#v1117))

**v1.11.6** — Bug audit: stop report timeout, reporting deduplication, EOF queue guard, IPC recovery ([details](CHANGELOG.md#v1116))

**v1.11.5** — Jellyfin 12 auth/API compatibility, duplicate instance handling, headless error dialogs ([details](CHANGELOG.md#v1115))

**v1.11.4** — Fixed NextUp returning same episode (retry with delay for server cache) ([details](CHANGELOG.md#v1114))

**v1.11.3** — NextUp race condition fix, API key redaction in MPV output, Swift weak-self fix ([details](CHANGELOG.md#v1113))

**v1.11.2** — Multi-config support, SyncPlay endpoint fix, security improvements ([details](CHANGELOG.md#v1112))

**v1.11.1** — XDG_RUNTIME_DIR for IPC, stale socket cleanup, cache=yes, secrets redaction ([details](CHANGELOG.md#v1111))

**v1.11.0** — Full SyncPlay support, SetShuffleQueue, SetSubtitleDelay, SetAudioDelay ([details](CHANGELOG.md#v1110))

**v1.10.10** — Bug audit: EOF detection, queue state fixes, OSD corruption fix ([details](CHANGELOG.md#v11010))

**v1.10.9** — Disconnect OSD only on persistent disconnects, detailed disconnect logging ([details](CHANGELOG.md#v1109))

**v1.10.8** — Fixed ForceKeepAlive data parsing, restored KeepAlive in noisyTypes ([details](CHANGELOG.md#v1108))

~~**v1.10.7**~~ — ~~Restored 30s KeepAlive, half-interval on ForceKeepAlive~~ (superseded by v1.10.8)
- Restored default KeepAlive to 30s (was incorrectly changed to 60s)
- ForceKeepAlive handler resets interval to half server's requested value (capped at 30s)
- Added debug logging for server echo of our KeepAlive messages
- Filtered noisy types (RefreshProgress, Sessions) from debug log

~~**v1.10.6**~~ — ~~Fixed KeepAlive interval to match server timeout~~ (wrong — still too slow, superseded by v1.10.8)
- Changed default KeepAlive from 120s to 60s (still wrong — server's ForceKeepAlive resets timer)
- Capped ForceKeepAlive handler at server's requested value
- Added debug logging for unknown WebSocket message types

~~**v1.10.5**~~ — ~~Fixed WebSocket disconnecting every ~30 minutes~~ (redundant — ws already auto-responds, superseded by v1.10.8)
- Added manual WebSocket ping/pong handler (redundant — ws library already auto-responds)
- Changed KeepAlive from 30s to 120s (wrong — too slow, reverted in v1.10.7)

**v1.10.4** — Fixed auto-advance at end of playlist, NextUp episode insertion ([details](CHANGELOG.md#v1104))
- Removed !isMpvPaused check from progress poll
- Fixed NextUp episode insertion to use set_property playlist-pos

**v1.10.3** — Crash reporting, graceful shutdown, shim stays running after MPV closes ([details](CHANGELOG.md#v1103))
- Crash dialog on macOS (NSAlert), Windows (PowerShell), Linux (zenity)
- Crash log file (data/crash.log)
- Shim only exits on SIGINT/SIGTERM or crashes

**v1.10.2** — Bug audit fixes: reconnection, OSD pause, watched marking, Preferences UI ([details](CHANGELOG.md#v1102))
- Fixed reconnection loop, OSD pause state, watched threshold, Preferences UI

**v1.10.1** — OSC integration fixes, subtitle styling, graceful close ([details](CHANGELOG.md#v1101))
- Fixed OSC close button, playlist title flash, subtitle/audio track selection
- Added jf-mpv-osc Tier 1-3 integration, subtitle styling controls

**v1.10.0** — Full season queue, navigation fixes, audit fixes ([details](CHANGELOG.md#v1100))
- Full season queue: playing a single episode loads all season episodes
- NextUp for specials: uses NextUp API when Jellyfin sends season 0
- Playlist navigation observer for reliable MPV navigation detection
- 12 bug fixes, 8 audit fixes, 7 new tests

**v1.9.2** — ConfigParser fix, Preferences UI, bug fixes ([details](CHANGELOG.md#v192))

**v1.9.1** — Audio loss fix, seek race condition, disableSkipIntro option ([details](CHANGELOG.md#v191))

**v1.9.0** — Auto-skip intros/outros, error OSD, next-up notification, better logging ([details](CHANGELOG.md#v190))

**v1.8.3** — Windows headless, troubleshooting, macOS app docs ([details](CHANGELOG.md#v183))
- Windows headless mode, expanded troubleshooting, macOS app architecture docs

**v1.8.2** — CI fix, Info.plist sync, .desktop Exec, SECURITY.md, more ([details](CHANGELOG.md#v182))
- Fixed CI release workflow, Info.plist version stuck at 1.7.6, .desktop Exec line for copied files

**v1.8.1** — Linux headless fix, release notes format ([details](CHANGELOG.md#v181))
- Fixed Linux headless mode — no terminal window when `headless: true`

**v1.8.0** — Queue system, DisplayMessage OSD, subtitle sync, headless mode ([details](CHANGELOG.md#v180))
- Full queue system with native MPV playlist, Play Next/Play Last, cross-season auto-play
- Jellyfin messages appear as OSD overlays in MPV with pause support
- Subtitle changes in MPV synced to Jellyfin
- Headless mode for Linux background operation
- Fullscreen, auto-close, custom MPV flags config options

**v1.7.6** — Bug fixes: stop reporting ([details](CHANGELOG.md#v176))
- Fixed playback stop not reported when Stop command comes from Jellyfin web UI
- Fixed playback stop not reported when MPV IPC connection fails

**v1.7.5** — **Critical fix: playback controls in Jellyfin web UI** ([details](CHANGELOG.md#v175))
- **Fixed playback controls broken since v1.7.0** (API format regression)
- Fixed duplicate progress reporting, help window, preferences alignment, dark mode icon
- Logs now saved to Application Support with timestamps
- About window dark mode icon, preferences alignment, log file saving

**v1.7.4** — Fix: emoji encoding corruption in log output ([details](CHANGELOG.md#v174))

**v1.7.3** — Bug fixes: shutdown race, icon colors, encoding, signal handling ([details](CHANGELOG.md#v173))
- Fixed shutdown waiting for HTTP stop report before exiting
- Fixed StatusBarController icon colors actually rendering
- Fixed signal forwarding in launch.sh, path handling in launch.bat
- Extracted shared utilities, SHA256 checksum verification

**v1.7.2** — Bug fixes: deviceId persistence, pendingQueries hang, stderr buffering ([details](CHANGELOG.md#v172))
- Fixed random deviceId creating zombie sessions on restart
- Fixed pendingQueries not resolved on MPV close (poll timer hang)
- Fixed stderr line buffering in NodeProcessManager
- Fixed `.desktop` file Exec line

**v1.7.1** — CI automation: auto-generated release notes from PRs ([details](CHANGELOG.md#v171))
- Release workflow now auto-generates changelog from merged PR titles
- Version sync: package.json is single source of truth, shim.js reads it at runtime

**v1.7.0** — Security, stability, and 20 bug fixes ([details](CHANGELOG.md#v170--security-stability-bug-fixes))
- API key redaction, token file permissions, crash handlers
- ConfigParser regex, audio/subtitle timing, backward navigation, SF Symbols, setup wizard fixes

**v1.6.0** — Cross-platform bundles and CI workflow ([details](CHANGELOG.md#v160--cross-platform-bundles-ci-build-workflow))
- Self-contained Linux and Windows bundles with bundled Node.js
- GitHub Actions auto-builds releases for all 3 platforms

**v1.5.0** — Apple HIG compliance and major feature release ([details](CHANGELOG.md#v150--apple-hig-compliance-bug-fixes-new-features))
- Full playback control from Jellyfin, auto-play overhaul, 13 bug fixes

**v1.4.0** — Bug fixes, logo, UI overhaul ([details](CHANGELOG.md#v140--bug-fixes-logo-ui-overhaul))

**v1.3.0** — Setup wizard, help window, bundled Node.js ([details](CHANGELOG.md#v130--setup-wizard-help-window-bundled-nodejs))

**v1.2.1** — Native macOS app, play-from-beginning fix, 8 bug fixes ([details](CHANGELOG.md#v121--native-macos-app-play-from-beginning-fix-8-bug-fixes))
</details>

---

## Contributing

Found a bug? Have a suggestion?

- Open an [Issue](https://github.com/MrGameVlogger/jellyfin-mpv-play/issues)
- Submit a Pull Request

This is a fork of [JohnGlaus/Jellyfin_mpv_play](https://github.com/JohnGlaus/Jellyfin_mpv_play). Upstream improvements may be synced periodically.

---

## License

MIT License — Feel free to use and modify! See [LICENSE](LICENSE).

---

## FAQ

**Q: Does this work on macOS?**
A: Yes. Tested on macOS with Homebrew MPV. Use `/opt/homebrew/bin/mpv` (Apple Silicon) or `/usr/local/bin/mpv` (Intel) as your `mpvPath`. The native macOS app bundles Node.js 22 LTS — no separate installation needed.

**Q: Does this work on Linux?**
A: Yes. Download the Linux bundle from [Releases](https://github.com/MrGameVlogger/jellyfin-mpv-play/releases), extract, and run `./launch.sh`. Set `mpvPath` to `/usr/bin/mpv` (or wherever MPV is installed).

**Q: Can I use this over the internet?**
A: Yes, if your Jellyfin server is accessible, but LAN is recommended.

**Q: Can I run multiple instances?**
A: Yes, use multi-config support: `node shim.js config.work.js` or `./launch.sh config.work.js`. Each config gets its own deviceId, token, positions, and IPC socket. On macOS, use the config file selector in Settings.

**Q: Can I run multiple instances of the same config?**
A: Yes, use the `--allow-duplicates` flag: `node shim.js config.js --allow-duplicates` or `./launch.sh --allow-duplicates`. Without this flag, a dialog will warn you about the duplicate instance (headless mode only). With the flag, the dialog is skipped and each instance gets its own log file (e.g., `shim-config-12345.log` in headless mode).

**Q: Does SyncPlay work?**
A: Yes, full SyncPlay support is included. Join a SyncPlay group from the Jellyfin web UI and the MPV client will follow along — pause, unpause, seek, and playlist changes are all synchronized.

**Q: Where is my config on macOS?**
A: `~/Library/Application Support/JellyfinMpvPlay/config.js`. The setup wizard configures this on first launch.

**Q: How do I update the macOS app?**
A: Download the latest release, unzip, and replace the app in `/Applications`. Your config is stored separately and persists across updates.

**Q: How do I update the Linux/Windows bundle?**
A: Download the latest release, extract to a new folder, and copy your `config.js` from the old folder. Your `data/` folder (playback positions) can also be copied over.

---

<p align="center">
  Made with ❤️ for the Jellyfin community<br>
  <a href="https://github.com/MrGameVlogger/jellyfin-mpv-play/stargazers">⭐ Star this repo</a> if you find it useful!
</p>
