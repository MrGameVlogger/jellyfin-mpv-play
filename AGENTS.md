# AGENTS.md

## ⚠️ CRITICAL: NEVER PUSH DIRECTLY TO MAIN ⚠️

**You MUST create a branch and PR for ALL changes.** The pre-push hook will block direct pushes, but you must also remember this workflow:

```
git checkout -b fix/my-fix      # Create branch FIRST
git add ...
git commit -m "fix: description"
git push origin fix/my-fix
gh pr create --repo MrGameVlogger/jellyfin-mpv-play --head fix/my-fix --base main --title "fix: description" --body "description"
gh pr merge <PR_NUMBER> --repo MrGameVlogger/jellyfin-mpv-play --squash
git checkout main && git pull origin main && git branch -D fix/my-fix
```

**NEVER do:**
- `git push origin main` — pre-push hook will block this
- `git commit` on main — you must be on a branch BEFORE committing
- `git push origin fix/my-fix` when you're still on main — branch doesn't exist yet

**Common mistake:** Committing to main first, then trying to push to a branch. The branch doesn't exist on the remote yet, so the push fails. Always `git checkout -b <branch>` BEFORE `git add` and `git commit`.

## Proactiveness

You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:

1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking
3. Giving the user time to review and interject before you commit/push

For example, if the user asks you to fix a bug:
1. Make the changes
2. Show what you've done and wait for approval
3. Only commit and push after the user confirms

**Do NOT** immediately commit, push, create PR, and merge in one shot. The user needs time to review your analysis and catch mistakes before they become permanent commits.

## What this is

Node.js shim (`shim.js`) that connects to Jellyfin via WebSocket, receives play commands, and controls MPV via Unix socket IPC. Optional macOS menubar app (`macapp/`) spawns the shim and parses its stdout for UI state. Linux and Windows users run `shim.js` directly via platform-specific launcher scripts.

## Commands

```bash
npm install && npm start     # run shim directly
cd macapp && ./build.sh      # compile Swift, bundle Node.js 24 LTS, deploy to /Applications
cd macapp && CI=true ./build.sh  # build without deploying to /Applications
```

No lint or typecheck steps exist. Tests run via `npm test`.

## Key files

| File | Role |
|------|------|
| `shim.js` | Entire Node.js application — all Jellyfin API, MPV control, queue, OSD, subtitle sync, headless logic |
| `config.js` | User config with credentials (gitignored) |
| `config.example.js` | Template for `config.js` |
| `package.json` | Version source of truth (single source — `clientVersion` reads from here at runtime) |
| `data/` | Runtime state: auth tokens, playback positions, device ID (gitignored) |
| `data/shim-<configname>.log` | Headless mode log output (created when `headless: true`) |
| `macapp/Sources/*.swift` | Native macOS menubar app (11 files) |
| `macapp/build.sh` | Compile Swift, bundle Node.js 24 LTS, deploy to `/Applications` |
| `macapp/Info.plist` | App version — auto-synced by CI from `package.json`; don't edit manually |
| `linux/launch.sh` | Smart launcher: detects headless config, manages systemd service |
| `linux/jellyfin-mpv-play.desktop` | Desktop entry with actions (Launch, Headless, Quit) |
| `linux/jellyfin-mpv-play.service` | Systemd user service for headless mode |
| `windows/launch.bat` | Windows launcher with `--headless` flag support |
| `.github/workflows/build.yml` | CI: tag-triggered, builds 3 platforms, creates GitHub Release |
| `.github/workflows/node-lts-bump.yml` | Weekly check of the bundled Node.js pin against the latest LTS; opens a bump PR (same major) or an evaluation issue (new LTS major) |
| `.editorconfig` | 4-space indent for JS/Swift, 2-space for YAML, CRLF for .bat |

## Architecture

- **Design principle — emulate jellyfin-web**: the shim is the Jellyfin web UI with mpv as the playback backend. Queue semantics, which item starts, shuffle, watched state, specials handling, etc. must match what jellyfin-web's own player does (its `playbackManager` is the reference; it resolves queues client-side via `translateItemsForPlayback` and sends explicit ItemIds + StartIndex). When behavior is ambiguous, look up what jellyfin-web does and copy it — two intentional deviations: (a) the "full season queue" feature — the queue includes earlier episodes so mpv's playlist navigation can go backwards, and (b) PreviousTrack restarts the current item past 30s before stepping back (the web goes strictly to the previous item; this is standard video-player UX and prevents losing a long watch-in to a mispress). Everything else — queue semantics, StartIndex handling, specials handling, shuffle, DisplayMessage (shows the message without pausing playback), watched threshold — mirrors jellyfin-web.
- **IPC**: Unix socket at `$XDG_RUNTIME_DIR/mpv-ipc.sock` on Linux (user-private directory), `/tmp/mpv-ipc.sock` on macOS (configurable via `ipcSocketPath` in config.js). Windows uses named pipe `\\.\pipe\mpv-ipc`.
- **MPV flags**: `--idle=yes --keep-open=yes --save-position-on-quit=no --cache=yes` (plus optional `--fullscreen` and user `mpvFlags`)
- **Multi-config support**: Run multiple instances with different configs: `node shim.js config.work.js`, `./launch.sh config.work.js`, `launch.bat config.work.js`. Each config gets its own deviceId, token, positions, and IPC socket. On macOS, config file selector in Preferences UI.
- **Queue system**: `playQueue` array tracks all item IDs; `queuePosition` tracks current index. Items loaded into MPV's native playlist via `loadlist` of in-memory M3U playlists (`memory://#EXTM3U` with `#EXTINF` titles — the stock OSC playlist shows these names instead of raw stream URLs, which carry the ApiKey token). MPV auto-advances through the playlist. External (sidecar) subtitle/audio streams are added per file via `sub-add`/`audio-add` since the static container stream does not carry them.
- **Episode transitions**: MPV's native playlist handles auto-advance. The `playlist-pos` property observer detects all playlist navigation (auto-advance, native keys, keybinds) and updates state. `loadNewQueue()` reuses the existing MPV for PlayNow commands. `playMedia()` spawns a fresh MPV (used for initial play and when IPC is down).
- **Cross-season**: When queue is exhausted, queries `GET /Shows/NextUp` for next season's episodes.
- **Full season queue**: Playing a single episode loads all episodes from that season into the playlist (expands around the started item, honoring StartIndex). Specials (season 0) expand to the specials season like any other season. Series-level requests (server-side expansion sorts specials first via SortName) start at the next unwatched regular episode, matching jellyfin-web; explicit specials selections play the special. When the queue is exhausted, NextUp continues into the next season.
- **PlayNext/PlayLast**: Inserts items into both the queue and MPV's playlist at the correct position using `insert-at`.
- **Auto-play**: Poll timer queries `time-pos` and `duration` via IPC every 1s. For the last item in the playlist, triggers `playNextEpisode()` when `pos >= dur - 1`. MPV handles all other transitions natively.
- **DisplayMessage**: Shows OSD overlay in MPV, pauses playback for 10s, then resumes. Original pause state tracked globally (`displayMessageOriginalPause`) to handle concurrent messages.
- **Subtitle sync**: Observes `sid` property. Changes from MPV are reported to Jellyfin via progress API. Changes from Jellyfin are flagged (`isSettingSubtitleFromJellyfin`) to prevent echo. 5s timeout clears the flag if no echo detected.
- **Headless mode**: `headless: true` in config.js logs to `data/shim-<configname>.log` (writes to both log file and stdout/stderr). On Linux, `launch.sh` auto-detects headless config and runs in background via nohup.
- **Playable types**: `Episode`, `Movie`, `Video`, `MusicVideo`, `Audio` — anything else is skipped.
- **Watched threshold**: Item marked watched at 90% of runtime.
- **EOF detection**: Observes `eof-reached` property (ID 8). Logs item ID, position, duration, queue index, and whether it's the last item. This is more reliable than the progress poll's position-based check for triggering auto-close.
- **Reconnection**: hot-probe loop on disconnect — `GET /System/Info` every 1s and connect the moment it answers, so a 5-30s outage costs ~1s of extra gap instead of a backoff slot (up to 30s). WS connect attempts are paced exponentially (1s × 1.5, 30s cap — jellyfin-web SDK shape) so a broken WS endpoint isn't hammered. On reconnect the shim immediately re-reports playback progress so the session reappears with `NowPlayingItem` set.
- **Redundant presence socket (the web-UI cast fix).** Jellyfin merges every WebSocket with the same token+deviceId into one session's socket list (`WebSocketController._sockets`) and closes the session only when NO socket is open (`SessionManager.CloseIfNeededAsync`). The shim therefore keeps a second ("presence") connection open: a single-socket drop never removes the session from `/Sessions`, which is the exact condition for jellyfin-web's `sessionPlayer` plugin (`processUpdatedSessions`) to drop the cast selection and playback controls — it flips to the local player the moment the session is missing from a `Sessions` broadcast and never re-attaches on its own. Commands are single-delivered to the most recently active socket (`MaxBy(LastActivityDate)`) so both sockets must process messages (MessageId LRU dedupe guards any fan-out). `SessionsStart` is per-connection — only the primary subscribes. Disable via `wsPresenceSocket: false`.
- **Dead-connection watchdog (client-side)**: protocol-level `ws.ping()` every 15s; any inbound frame (pong, app KeepAlive echo, any message) counts as liveness proof. If nothing arrives for 35s the socket is `terminate()`d (NOT `close()`d — the ws docs' "How to detect and close broken connections" pattern) to force the reconnect path immediately. A half-open TCP connection otherwise accepts our sends silently and can take many minutes to surface an error. Verified live: Kestrel auto-pongs protocol pings. TCP keepalive (20s) is also enabled on the raw socket as NAT insurance.
- **Only `KeepAlive` messages refresh the server's `LastKeepAliveDate`.** In `WebSocketConnection.SendKeepAliveResponse` the server stamps it on every inbound `KeepAlive` message; other traffic does not count. Keep the app-level KeepAlive cadence at ≤30s (server ForceKeepAlive nudges at 45s of silence, disposes the socket at 60s).
- **No planned refresh, ever.** v1.12.1 added a watchdog that closed/reopened the socket every ~25 min to preempt external cuts. It was removed in v1.12.4: the cuts are not connection-age-based (a 1006 drop was logged 5 min after a refresh), while every refresh was a client-visible disconnect — the Jellyfin web UI drops its cast selection and playback controls on it (progress/watched marking are HTTP and unaffected). Users with healthy connections got a cast-disconnect every 25 minutes. Do not reintroduce a keep-alive-reconnect without evidence that the cuts are age-based.
- **jf-mpv-osc integration**: Optional integration with [jf-mpv-osc](https://github.com/iwalton3/jf-mpv-osc) for Jellyfin-styled MPV UI. Pushes state via `shim-jf-osc-state` (track lists, queue, favorites, subtitle styling, SyncPlay groups). Handles actions via `shim-jf-osc-action` (skip, next/prev, set-sub, set-audio, screenshot, fullscreen, syncplay-join, syncplay-new, syncplay-disable, syncplay-refresh, etc.). Also handles direct `shim-close` and `shim-jf-osc-ui-seek` messages. All integration is optional — messages are silently ignored if OSC isn't loaded. See README.md for full tier support table.

## WebSocket behavior (learned the hard way)

- **`ws` library v8.x auto-responds to protocol-level `ping`/`pong` frames.** No manual handler needed. Adding a `ws.on('ping')` handler that calls `ws.pong()` causes double-pong responses.
- **Jellyfin sends `ForceKeepAlive` every ~48 seconds.** The server's `SessionWebSocketListener` checks every 12 seconds (60 × 0.2). If elapsed > 45s, sends `ForceKeepAlive`. If elapsed > 60s, marks connection lost.
- **`ForceKeepAlive` resets our interval timer.** If we reset `keepAliveInterval` on every `ForceKeepAlive`, our own timer never fires independently. Use half the server's requested interval (capped at 30s).
- **`msg.Data` in `ForceKeepAlive` can be a number, string, or object (`{Timeout: N}`).** NaN from bad parsing causes a 0ms tight loop flooding the socket. Always parse safely with fallback to 30.
- **KeepAlive messages are echoed back.** When we send `{ MessageType: 'KeepAlive' }`, the server broadcasts it to all clients including us. Use this to verify the server received our message.
- **Close code 1006 = abnormal closure.** No close frame received — TCP connection was reset by something in the network path (NAT, router, ISP, WiFi), not by the server.
- **Disconnects while actively communicating are network-level issues.** If the last message was received <20 seconds before disconnect, it's not a keep-alive timeout — something is killing the TCP connection.
- **`NOISY_WS_TYPES` constant** — `['KeepAlive', 'RefreshProgress', 'Sessions']` — used to filter frequent messages from info-level logs. Keep this consistent across all handlers.

## Disconnect diagnosis

When WebSocket disconnects occur, check:
1. **Close code** — 1006 = network-level drop, 1000 = normal close, 1001 = going away
2. **Time since last message** — <20s = network issue, >60s = keep-alive issue
3. **Server logs** — `127.0.0.1` disconnects are the web UI, NOT our client. Our client's IP would be different.
4. **Reconnection pattern** — "Server unavailable" during retry = network was briefly down. Immediate success = server closed the connection.

## OSD behavior

- **Don't show "Connection lost" immediately on disconnect.** Only show after the first reconnection attempt fails (~5 seconds). Brief network blips (<5 seconds) should show no message.
- **Show "Reconnected" when successfully reconnecting** after a disconnect. Use `showErrorOsd` (top-right), not `showSkipOsd` (bottom-right).
- **OSD auto-clears after 3 seconds.** No need to explicitly clear on reconnection.

## Known issues and investigation history

- **WebSocket disconnects every ~30 minutes** — Investigated in v1.10.5–v1.10.8. (A "planned refresh" watchdog shipped in v1.12.1 to preempt them and was removed in v1.12.4 after field reports showed it prevented nothing and disconnected the web UI's cast every 25 min — see the WebSocket behavior section.) Conclusion: network-level drops between client and server (close code 1006), NOT server-side timeouts. The `127.0.0.1` disconnects in server logs are the Jellyfin web UI, NOT our client. Our client connects from the Mac's IP. To diagnose further, run `sudo tcpdump -i any -w ~/ws-capture.pcap host <server-ip> and port 8096` during playback.
- **`ws.close()` vs `ws.terminate()`** — `ws.close()` is correct. `ws.terminate()` was briefly tried based on wrong analysis of `127.0.0.1` logs (thought they were zombie connections, but they were the web UI). Reverted.
- **`close()` on a CONNECTING socket emits `'error'` asynchronously** — `ws.close()` during an unfinished handshake calls `abortHandshake`, which fires the error via `process.nextTick`. That sails past any `try/catch` around the call, so `removeAllListeners()` + `close()` (the old `closeAllWs`/`connectSocket` cleanup) turned every quit-with-a-reconnect-in-flight into an uncaughtException + crash dialog (crash.log 2026-10-23). Keep a swallow `on('error', () => {})` handler attached at close time, and make the uncaughtException handler inert when `isShuttingDown`.
- **Copilot review is useful** — GitHub Copilot found real issues: ForceKeepAlive data parsing (NaN from object format), noisyTypes inconsistency. Run `gh pr comment` or check PR reviews for Copilot feedback.
- **Orphaned mpv processes survive unclean shutdowns** — `mpv --idle --keep-open` outlives its parent when the app is force-quit or a test run crashes (found in the wild: a 3.5-day-old orphan holding a stray window, PPID=1). The shim now quits any leftover mpv on its IPC socket at startup (`reapOrphanedMpv`), and the e2e suite sweeps test mpvs whose owning run is dead (`reapStaleTestMpvs`). When inspecting processes, check the socket path/PPID before assuming a live user session — an orphan's media title is just whatever it last played.
- **Duplicate v1.10.10 tag** — PR #254 (bug audit) and PR #255 (SyncPlay) were both tagged v1.10.10. The tag ended up pointing to PR #255. Lesson: don't tag multiple PRs with the same version. v1.11.0 was released to properly version the SyncPlay feature.

## mpv IPC command reference

mpv's JSON IPC protocol uses different command names than the input.conf system. **Wrong names are silently ignored** — mpv won't error, it just won't do anything. Always verify command names against https://mpv.io/manual/master/#command-interface.

### Common mistakes

| Wrong | Correct | Why |
|-------|---------|-----|
| `add_property` | `add` | `add` is an input command. `set_property`/`get_property`/`observe_property` are IPC-specific, but `add` has no `_property` variant. |
| `insert-at-index` | `insert-at` | The flag is `insert-at`, index is a separate third argument. `insert-at-index` was never valid — mpv silently fell back to `replace`. |
| `set_property playlist-pos` | `playlist-play-index` | Setting `playlist-pos` only *may* start playback. `playlist-play-index` explicitly guarantees it. Use `playlist-play-index` when loading a new playlist from idle. |
| `loadfile` on an M3U URL | `loadlist` | `loadfile` on `memory://#EXTM3U...` drops the `#EXTINF` titles for `insert-at`/`append` entries (verified on mpv 0.41). `loadlist` keeps them in every mode. Only `loadfile`+`replace` retained titles. |

### Valid IPC commands used in shim.js

| Command | Type | Syntax | Notes |
|---------|------|--------|-------|
| `set_property` | IPC-only | `["set_property", "name", value]` | Sets a property |
| `get_property` | IPC-only | `["get_property", "name"]` | Gets a property value |
| `observe_property` | IPC-only | `["observe_property", id, "name"]` | Subscribes to property changes |
| `add` | Input | `["add", "name", value]` | Adds value to property (e.g. volume) |
| `cycle` | Input | `["cycle", "name"]` | Cycles property (e.g. fullscreen) |
| `seek` | Input | `["seek", seconds, "flag"]` | Flags: `absolute`, `relative`, `absolute+keyframes` |
| `loadfile` | Input | `["loadfile", "url", "flag", index]` | Flags: `replace`, `append`, `insert-at`. Add `+play` to force start (e.g. `append+play`). |
| `loadlist` | Input | `["loadlist", "url", "flag", index]` | Same flags as `loadfile`; `url` may be a `memory://#EXTM3U` playlist whose `#EXTINF` titles become playlist entry titles + `media-title`. `loadfile` on an M3U URL does NOT preserve titles for `insert-at`/`append` — use `loadlist`. |
| `sub-add` | Input | `["sub-add", "url", "flags", "title", "lang"]` | Adds an external subtitle stream. Flags: `select`, `auto` (don't hijack selection), `cached`. |
| `audio-add` | Input | `["audio-add", "url", "flags", "title", "lang"]` | Adds an external audio stream (same shape as `sub-add`). |
| `playlist-play-index` | Input | `["playlist-play-index", index]` | Explicitly starts playback at index |
| `playlist-next` | Input | `["playlist-next"]` | Go to next playlist entry |
| `playlist-prev` | Input | `["playlist-prev"]` | Go to previous playlist entry |
| `playlist-clear` | Input | `["playlist-clear"]` | Clear playlist (except current file) |
| `show-text` | Input | `["show-text", "text", duration_ms]` | Show OSD message |
| `keybind` | Input | `["keybind", "key", "command"]` | Bind a key |
| `script-message` | Input | `["script-message", "name", ...args]` | Send message to scripts |
| `screenshot` | Input | `["screenshot"]` | Take screenshot |
| `quit` | Input | `["quit"]` | Exit mpv |

### Verifying mpv changes

We have no automated mpv tests. To verify IPC changes:

1. **Check the output** — Run `npm start` and watch the terminal. On macOS, if using the app, check `~/Library/Application Support/JellyfinMpvPlay/data/jellyfin-mpv-play-*.log`. On Linux/Windows, check `data/shim-<config>.log` if using headless mode. After making a change, play an episode and look for:
   - `📺 Episode detected` — confirms the right episode loaded
   - `📋 Playlist changed: queuePosition=N` — confirms playlist navigation
   - `▶️ Playback resumed` — confirms playback started
   - No `⚠️ MPV Error` lines
2. **Test queue scenarios** — Play episode 10 of a season (not episode 1), verify it starts at ep 10
3. **Test PlayNext/PlayLast** — Queue items should insert at correct positions
4. **Test volume controls** — VolumeUp/VolumeDown from Jellyfin dashboard should work
5. **Test shuffle** — Shuffling while at position 0 should not stop playback
6. **Check mpv docs** — Always verify command names at https://mpv.io/manual/master/#command-interface before using them

## Config options

All options go in `config.js` (copy from `config.example.js`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverUrl` | string | **required** | Jellyfin server URL (e.g. `http://192.168.1.10:8096`) |
| `username` | string | **required** | Jellyfin username |
| `password` | string | **required** | Jellyfin password |
| `apiKey` | string | `''` (falls back to the access token) | Jellyfin API key (Dashboard → API Keys) used in media URLs handed to mpv — survives token reauth so a mid-session token invalidation can't kill the rest of the queue |
| `mpvPath` | string | `"mpv"` | Path to MPV binary |
| `deviceName` | string | `"Jellyfin MPV Play"` | Display name in Jellyfin session |
| `deviceId` | string | auto-generated | Unique device ID (must differ from `deviceName` per Jellyfin) |
| `ipcSocketPath` | string | `$XDG_RUNTIME_DIR/mpv-ipc.sock` (Linux), `/tmp/mpv-ipc.sock` (macOS), `\\.\pipe\mpv-ipc` (Windows) | Unix socket path |
| `fullscreen` | boolean | `false` | Start MPV in fullscreen mode |
| `autoClose` | boolean | `false` | Close shim when playback ends |
| `mpvFlags` | array | `[]` | Additional MPV arguments (e.g. `["--hwdec=auto"]`) |
| `headless` | boolean | `false` | Redirect logs to `data/shim-<configname>.log`, suppress stdout/stderr |
| `autoSkipIntros` | boolean | `false` | Auto-skip intros/outros after 3s (or show "Press S to skip" OSD) |
| `disableSkipIntro` | boolean | `false` | Completely disable intro/outro skip feature (hides prompts, no S key) |
| `verbose` | boolean | `false` | Show debug-level logs with timestamps and component names |
| `wsPresenceSocket` | boolean | `true` | Redundant second WebSocket so the session survives a single-socket drop (keeps the web UI's cast alive) |

`config.js` is gitignored. Missing file → `MODULE_NOT_FOUND` on start.

**Command-line flags** (after the optional config file name): `--headless` forces headless log-to-file behavior even without `headless: true` in the config; `--allow-duplicates` skips the duplicate-instance dialog and names the log `shim-<config>-<PID>.log`. Without it, duplicates are detected via `data/<config>.lock` and the log is always `data/shim-<config>.log`.

**Multi-config support**: Create multiple config files (e.g., `config.work.js`, `config.personal.js`) and run with `node shim.js config.work.js`. Each config gets its own deviceId, token, positions, and IPC socket. On macOS, use the config file selector in Preferences. Auto-generated device IDs are stored per-config in `data/.device-id-<configname>` (leave `deviceId` empty to auto-generate).

## Key functions map

All functions live in `shim.js`. There are no classes — the entire app is procedural with module-level state.

### Lifecycle & auth

| Function | Line | Description |
|----------|------|-------------|
| `main()` | 3148 | Entry point: creates `data/`, loads token or authenticates, connects WebSocket |
| `authenticateUser()` | 391 | POSTs to `/Users/AuthenticateByName`, saves token |
| `loadToken()` | 354 | Reads JWT from `data/jellyfin_token_{deviceId}.json` |
| `saveToken(authResponse)` | 379 | Persists JWT to disk |
| `getAuthHeaders()` | 450 | Returns `Authorization: MediaBrowser Token=...` header |
| `generateOrLoadDeviceId()` | 324 | Reads or generates the per-config device ID from `data/.device-id-{config}` (one-time adopter of the legacy `data/.device-id`) |

### WebSocket & Jellyfin communication

| Function | Line | Description |
|----------|------|-------------|
| `connectSocket(sock)` | — | Establishes one WS connection (primary/presence), message handler, keep-alive, watchdog |
| `ensureSocketsConnected()` | — | Connects any socket that is down (boot, post-reauth) |
| `sendWsMessage(obj)` / `sendOnSocket(sock, obj)` | — | Outbound WS traffic (primary preferred; per-socket for subscriptions) |
| `scheduleReconnect()` | 595 | Reconnect backoff matching jellyfin-web's SDK (1s × 1.5, 30s cap) |
| `handleMessage(msg)` | 700 | Main WS message dispatcher — handles Play, Playstate, GeneralCommand |
| `reportCapabilities()` | 659 | Registers session capabilities with Jellyfin |
| `getEpisodeInfo(itemId, silent)` | 1174 | Fetches item metadata + season episode list |
| `queryNextUp(seriesId, excludeItemId)` | 2399 | Queries `/Shows/NextUp` for next unwatched episode |

### MPV control

| Function | Line | Description |
|----------|------|-------------|
| `playMedia(itemId, startTicks)` | 1503 | Spawns fresh MPV process with IPC socket |
| `loadNewQueue(itemId, startTicks)` | 1389 | Loads new queue into running MPV (clears playlist, reloads) |
| `connectToMpvIpc(gen)` | 1687 | Connects to MPV Unix socket, observes properties, binds keys |
| `killMpv()` | 1891 | Kills MPV, cleans up IPC, resolves pending queries |
| `sendMpvCommand(command, args)` | 1932 | Sends JSON command to MPV via IPC |
| `queryProperty(property, timeoutMs)` | 1952 | Queries MPV property (returns Promise) |
| `startProgressPoll()` | 1975 | 1s interval: polls `time-pos`/`duration`, triggers next episode near end |
| `stopProgressPoll()` | 2015 | Clears progress poll timer |
| `handleMpvEvent(event)` | 2022 | Processes MPV IPC events (file-loaded, property changes, keybinds) |

### Queue & episode transitions

| Function | Line | Description |
|----------|------|-------------|
| `playNextEpisode()` | 2638 | Advances to next episode (queue → season → NextUp → end) |
| `playPreviousEpisode()` | 2824 | Goes to previous episode (restart if >30s, queue, or season prev) |
| `beginPlaybackReporting(itemId)` | — | Start report + fresh playSessionId + progress interval for a transition target (required whenever a path pre-updates queue state and bypasses the playlist-pos handler) |

### Item info cache & queue construction

| Function | Line | Description |
|----------|------|-------------|
| `buildStreamIndexMap(mediaStreams, mpvTracks, itemId)` | 153 | Explicit Jellyfin Index ↔ mpv track id map (embedded zipped by order, external by URL) |
| `jellyfinStreamIndexToMpvId(streamIndex, type)` | 193 | Jellyfin stream index → mpv aid/sid (map first, then legacy fallbacks) |
| `mpvTrackIdToJellyfinIndex(mpvId, type)` | 210 | mpv track id → Jellyfin stream index (inverse) |
| `cacheItemInfo(item)` | 271 | Stores title/mediaStreams/mediaSourceId in `itemInfoCache` |
| `fetchItemInfoBatch(ids)` | 286 | One `Ids=` batch request filling titles + streams for a queue |
| `buildQueueM3u(ids)` | 311 | `memory://#EXTM3U` with `#EXTINF` titles + stream URLs (stock OSC playlist names) |
| `externalStreamUrl(stream, itemId)` | 329 | Delivery URL for a sidecar subtitle/audio stream |
| `loadExternalStreams(itemId)` | 354 | `sub-add`/`audio-add` each external stream of the loaded file |
| `applyRequestedStreamSelection()` | 398 | Re-applies the server-requested audio/subtitle track (covers late external adds) |

### Auto-skip & OSD

| Function | Line | Description |
|----------|------|-------------|
| `getIntroSegments(itemId)` | 1248 | Fetches intro/outro segments from Jellyfin MediaSegments API |
| `skipIntro()` | 1290 | Seeks to end of current intro/outro segment |
| `checkIntroSegment(positionTicks)` | 1308 | Checks if position is inside an intro/outro segment |
| `showSkipOsd(text)` | 1338 | Shows bottom-right OSD (skip prompts, next-up notification) |
| `showErrorOsd(text)` | 1362 | Shows top-right OSD (connection/auth errors, rate limited) |

### Playback reporting

| Function | Line | Description |
|----------|------|-------------|
| `reportPlaybackStart(itemId, positionTicks)` | 2509 | Reports start to `/Sessions/Playing` |
| `reportPlaybackProgress(itemId, positionTicks)` | 2566 | Reports progress to `/Sessions/Playing/Progress` |
| `reportPlaybackStop(itemId, positionTicks)` | 2595 | Reports stop to `/Sessions/Playing/Stopped` |
| `startProgressReporting(itemId)` | 2545 | 10s interval: saves local playback positions |
| `markItemAsUnwatched(itemId)` | 1847 | Resets item to unwatched in Jellyfin (`DELETE /PlayedItems`), clears local position |
| `markItemAsWatched(itemId)` | 1869 | Marks item as played, clears local position |
| `savePlaybackPosition(itemId, positionTicks)` | 436 | Persists position to `data/playback_positions_{deviceId}.json` |
| `loadPlaybackPositions()` | 424 | Reads saved positions from disk |

### Shutdown

| Function | Line | Description |
|----------|------|-------------|
| `shutdown(signal)` | 2935 | Graceful exit: saves positions (unless `isUnwatchedQuit`), kills MPV, sends SessionsStop, closes WS |

### jf-mpv-osc integration

| Function | Line | Description |
|----------|------|-------------|
| `handleOscAction(verb, arg)` | 2625 | Handles actions from OSC. Verbs: `skip-segment`, `next-item`, `prev-item`, `set-sub`, `set-audio`, `set-sub-size`, `set-sub-position`, `set-sub-color`, `toggle-favorite`, `screenshot`, `set-fullscreen`, `unwatched-quit`, `syncplay-refresh`, `syncplay-join`, `syncplay-new`, `syncplay-disable`, `syncplay-toggle-pause` |
| `pushOscState(hasMedia)` | 2725 | Pushes state blob to OSC (queue, favorites, tracks, subtitle styling) |
| `pushOscSkipButton(label)` | 2851 | Pushes skip button label to OSC (or empty to hide) |
| `toggleFavorite()` | 2915 | Toggles favorite via Jellyfin API and pushes updated state |
| `setAssPrimaryColourOverride(colorOrNull)` | 259 | Sets/clears the `PrimaryColour` entry in `sub-ass-style-overrides` (ASS colour edit), preserving any entries from the user's mpv.conf |

Note on `unwatched-quit`: quits without saving a resume position anywhere (no local save, stop report at position 0) and resets the item to unwatched in Jellyfin. The `sub_style` state reports MPV's live values, so mpv.conf settings show through as current; for ASS/SSA tracks the colour reads `Style` until one is forced, since their colour comes from the subtitle style rather than `sub-color`.

Note on Tier 1 track lists: the `subtitles`/`audio` arrays come from `currentEpisodeInfo.mediaStreams`, which `fetchEpisodeInfo()` populates for **every** item type via its shared payload (Episode branch spreads `...info` and adds series-only fields). Never make that payload lopsided — a movie that omitted `mediaStreams` once hid every audio/subtitle option in the OSC. `tests/quality.test.mjs` guards this.

### Utility functions

| Function | Line | Description |
|----------|------|-------------|
| `normalizeSubColor(raw)` | 278 | Normalizes mpv's `#AARRGGBB` (or `r/g/b/a` float) colour form to `#RRGGBB` |
| `redact(value)` | 124 | Masks `api_key` and `X-Emby-Token` in log output for security. |

## State management

All state is module-level variables. No state machine or stores — just mutable globals with flags to coordinate async operations.

### Core playback state

| Variable | Type | Purpose |
|----------|------|---------|
| `currentItemId` | string | ID of currently playing item |
| `currentPositionSeconds` | number | Current playback position in seconds |
| `currentDuration` | number | Duration of current item |
| `currentEpisodeInfo` | object | Episode metadata (series name, season/episode numbers, next/prev episodes) |
| `playSessionId` | string | Unique session ID for Jellyfin progress reports |

### Queue state

| Variable | Type | Purpose |
|----------|------|---------|
| `playQueue` | array | Ordered list of item IDs |
| `queuePosition` | number | Index into `playQueue` (-1 when not playing) |

### MPV / IPC state

| Variable | Type | Purpose |
|----------|------|---------|
| `mpvProcess` | Process | Spawned MPV child process |
| `ipcClient` | Socket | Unix socket connection to MPV IPC |
| `ipcCommandId` | number | Auto-incrementing request ID for IPC commands |
| `isMpvPaused` | boolean | Current pause state |
| `isMuted` | boolean | Current mute state |
| `volumeLevel` | number | Current volume (0-100) |
| `mpvTrackList` | array | mpv `track-list` snapshot (ff-index ↔ per-type id mapping, refreshed on `file-loaded`) |
| `streamIndexMap` | object | `{toMpv, toJf}` explicit Jellyfin Index ↔ mpv track id maps (rebuilt on `file-loaded` and after external adds) |
| `fileLoadGeneration` | number | Bumped per `file-loaded` AND at navigation via `invalidateFileGeneration()` — stale async continuations (external stream adds, track-map rebuilds) bail when superseded |
| `queueLoadGeneration` | number | Bumped per `loadNewQueue` — a superseded queue run must not send playlist commands |
| `itemInfoCache` | Map | itemId → `{title, mediaStreams, mediaSourceId}` for the current queue (batch-fetched) |
| `externalStreamsAdded` | Set | Sidecar stream URLs already added for the loaded file (cleared per file) |

### Coordination flags

| Variable | Type | Purpose |
|----------|------|---------|
| `isPlayingNext` | boolean | Prevents double-triggering episode transitions (30s timeout fallback) |
| `isPlayingNextTimestamp` | number | Timestamp when `isPlayingNext` was set (for timeout) |
| `isNewQueueLoad` | boolean | True during `loadNewQueue()` to suppress file-loaded handlers |
| `isReportingStop` | boolean | Prevents duplicate stop reports; stays set until the next `reportPlaybackStart()`/`file-loaded` (clearing it when the stop lands lets a late progress report resurrect the session) |
| `isStoppingPlayback` | boolean | Quit initiated/stop reported — suppresses progress reports until the next playback (mpv's phantom `pause=false` during exit must not outlive the stop report) |
| `reportChain` | Promise | Serialized playback-report chain — progress/stop/start reach the server in call order (fire-and-forget over separate connections otherwise races) |
| `isUnwatchedQuit` | boolean | Set by OSC `unwatched-quit`: suppress mark-watched and any resume save; item is reset to unwatched |
| `isSettingSubtitleFromJellyfin` | boolean | Echo prevention: true when subtitle change came from Jellyfin (5s timeout) |
| `pendingQueries` | Map | Tracks outstanding IPC queries (must resolve all before cleanup) |
| `markedWatched` | Set | Prevents duplicate "mark as watched" API calls (cleared on new file) |
| `skippedSegmentIds` | Set | Tracks skipped intro/outro segments (cleared on new file) |

### DisplayMessage state

| Variable | Type | Purpose |
|----------|------|---------|
| `displayMessageTimeout` | Timer | Active OSD timeout (10s) |
| `displayMessageOriginalPause` | boolean | Pause state before message (restored after) |
| `displayMessageOriginalFontSize` | number | Font size before message (restored after) |
| `displayMessageOriginalAlignX` | string | Alignment X before message (restored after) |
| `displayMessageOriginalAlignY` | string | Alignment Y before message (restored after) |

### Auto-skip & next-up state

| Variable | Type | Purpose |
|----------|------|---------|
| `introSegments` | array | Cached intro/outro segments from MediaSegments API |
| `skipIntroTimeout` | Timer | Auto-skip delay timeout (3s) |
| `isInIntroSegment` | boolean | Currently inside an intro/outro segment |
| `lastErrorOsdTime` | number | Timestamp of last error OSD (30s rate limiting) |
| `nextUpShown` | boolean | Prevents duplicate next-up notifications per episode |

### Auth / connection state

| Variable | Type | Purpose |
|----------|------|---------|
| `accessToken` | string | Jellyfin JWT token |
| `userId` | string | Jellyfin user ID |
| `wsSockets` | object | `{primary, presence}` socket records (ws, timers, per-socket backoff/diagnostic state) |
| `seenMessageIds` | Set | MessageId LRU (cap 200) — dedupe guard for any cross-socket fan-out |
| `reauthInFlight` | boolean | Prevents concurrent reauth when both sockets' probes hit 401 |

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `NOISY_WS_TYPES` | `['KeepAlive', 'RefreshProgress', 'Sessions']` | Filtered from info-level logs to reduce noise. Used in both message handler and debug handler for unhandled messages. |

### Pending playback state (between command and MPV ready)

| Variable | Type | Purpose |
|----------|------|---------|
| `pendingStreamUrl` | string | URL to load when IPC connects |
| `pendingStartSeconds` | number | Start position for pending stream |
| `pendingAudioStreamIndex` | number | Audio stream to set after load |
| `pendingSubtitleStreamIndex` | number | Subtitle stream to set after load |
| `requestedAudioStreamIndex` | number | Sticky last server-requested audio track (re-applied after external adds) |
| `requestedSubtitleStreamIndex` | number | Sticky last server-requested subtitle track (same) |

## Modification patterns

### Adding a new config option

1. Add the option to `config.example.js` with a default value and comment
2. Add it to the `CONFIG` object in `shim.js` (line 12-29): `optionName: userConfig.optionName || defaultValue`
3. Use `CONFIG.optionName` throughout the code
4. Add it to the macOS Settings panel (`macapp/Sources/PreferencesWindowController.swift`): field declaration, `setupUI` row, `loadConfig`, and `saveConfig` (`managedKeys` + a line appended only when non-empty for optional keys). Without this the option is invisible to Mac users. `tests/config.test.mjs` guards `apiKey` specifically.
5. Update AGENTS.md config table, README.md, CONTRIBUTING.md if relevant

### Adding a new PlaystateCommand

1. Add the `case` to `handleMessage()` under the `"Playstate"` switch (search for `command === 'Stop'`)
2. Implement the actual MPV command via `sendMpvCommand()`
3. If it requires new state, add a module-level variable with a clear name
4. Update `reportCapabilities()` to include the new command in `SupportedCommands`
5. Update AGENTS.md "Jellyfin API compliance" section

### Adding a new GeneralCommand

1. Add the `case` to `handleMessage()` under the `"GeneralCommand"` switch (search for `command === 'SetAudioStreamIndex'`)
2. Use the exact `GeneralCommandType` enum name from Jellyfin source — wrong names cause 400 errors
3. If it requires new MPV IPC, use `sendMpvCommand()` or `queryProperty()`
4. Update `reportCapabilities()` to include the new command
5. Update AGENTS.md "Jellyfin API compliance" section

### Adding a new log line (macapp interaction)

**⚠️ CRITICAL**: The macOS app parses stdout line-by-line. Every log line pattern must be:
1. Added to this document's "Log line contracts" table
2. Checked against `NodeProcessManager.swift:processLogLine` to ensure Swift code handles it
3. Never changed after release (would silently break the macOS app)

Use patterns like:
- `console.log('▶️ Starting next episode: <title>')` — parsed by Swift
- `console.log('ℹ️ ...')` — informational, not parsed
- `console.error('⚠️ ...')` — error, parsed as error notification

### Adding a new IPC property observer

1. Add `observe_property` command in `connectToMpvIpc()` (search for `observe_property`)
2. Add a `case` in `handleMpvEvent()` under `property-change`
3. Update the corresponding state variable
4. If the change should be reported to Jellyfin, include it in `reportPlaybackProgress()` fields

### Modifying the queue system

- `playQueue` is the source of truth for item order
- `queuePosition` tracks where we are
- MPV's native playlist must stay in sync with `playQueue`
- `loadNewQueue()` clears and rebuilds both
- `playNextEpisode()` / `playPreviousEpisode()` modify both
- `playlist-pos` property observer detects all playlist navigation and updates state
- Playlist entries must be created via `buildQueueM3u()` + `loadlist` (or `loadfile` for a single-entry replace) so entries carry display names — never raw URLs, which leak `ApiKey` into the stock OSC playlist view

## Platform-specific behavior

### macOS (`macapp/`)

- `build.sh` compiles Swift, bundles Node.js 24 LTS (arm64 or x64, not universal), deploys to `/Applications`
- `setupApplicationSupport()` always overwrites `shim.js` from the bundle on launch
- `NodeProcessManager.swift` spawns the shim, parses stdout via `processLogLine` on main thread
- `StatusBarController.swift` manages the menu bar icon (template images for light/dark mode)
- All windows use standard layering (no `.floating`)
- Config file location: `~/Library/Application Support/JellyfinMpvPlay/config.js`
- Log file location: `~/Library/Application Support/JellyfinMpvPlay/data/jellyfin-mpv-play-*.log` (timestamped)

### Linux (`linux/`)

- `launch.sh` detects headless config via node (`require(config).headless`), re-opens terminal if needed
- `--install-service` / `--uninstall-service` manages systemd user service
- `jellyfin-mpv-play.desktop` has Terminal=false (launch.sh handles terminal detection)
- `jellyfin-mpv-play.service` runs shim as systemd user service (Type=simple, Restart=on-failure)
- MPV args are minimal — user's `~/.config/mpv/mpv.conf` handles vo, hwdec, ao, cache, etc.

### Windows (`windows/`)

- `launch.bat` supports `--headless` flag and auto-detection from config.js via node (`require(config).headless`) — never text matching, comments in the config can't false-positive
- IPC socket path defaults to named pipe `\\.\pipe\mpv-ipc`
- Line endings should be CRLF
- Path quoting matters for special characters

## Error handling patterns

### IPC connection failure

`connectToMpvIpc()` retries up to 10 times with 500ms delay (via `attemptConnection()`). If all retries fail, `pendingStreamUrl` is set and `playMedia()` will spawn a fresh MPV when the next command arrives.

### WebSocket disconnect

`scheduleReconnect(sock)` starts a per-socket 1s probe loop (`GET /System/Info`, 800ms timeout) that connects the moment the server answers; WS connect attempts within it are paced 1s × 1.5 (30s cap). Logs "Server unavailable" only on the down-transition (no 1Hz spam). 401 from the probe triggers reauth (guarded by `reauthInFlight`) then `ensureSocketsConnected()`. OSDs only announce a lost connection when NO socket is open — single-socket swaps are silent.

### MPV process crash

`killMpv()` cleans up IPC client, resolves all `pendingQueries` with null, clears intervals. If `autoClose` is enabled, `shutdown()` is called.

### Pending queries timeout

`queryProperty()` has a default 5s timeout. If a query times out, it resolves with null and is removed from `pendingQueries`. `killMpv()` also resolves all pending queries on cleanup.

### Episode transition guard

`isPlayingNext` flag prevents double-triggering. Has a 30s timeout fallback: if `isPlayingNextTimestamp` is older than 30s, the flag is cleared and the transition proceeds.

### Duplicate API calls

- `markedWatched` Set prevents duplicate "mark as watched" calls (cleared on each new file load)
- `isReportingStop` flag prevents duplicate stop reports
- `isSettingSubtitleFromJellyfin` flag with 5s timeout prevents subtitle echo

### Stop report vs. progress report ordering

mpv emits a phantom `pause=false` ("Playback resumed") **while exiting** — the pause observer turns every pause change into a `POST /Sessions/Playing/Progress`, which can land AFTER `POST /Sessions/Playing/Stopped` (fire-and-forget over separate connections). Jellyfin's progress handler then re-stamps the session as playing and the server "disagrees" that playback stopped — intermittent, purely request-ordering. Defenses (all three needed):
- `isStoppingPlayback` set at quit-initiation (`shim-close`, `unwatched-quit`, `shutdown`, auto-close quits, mpv close handler) suppresses further progress reports
- `isReportingStop` stays set until the next `reportPlaybackStart()`/`file-loaded` — never clear it when the stop POST lands
- all playback reports serialize through `chainReport` (`reportChain`) so the server always processes progress before stop — and so a transition's `start(new)` can never overtake `stop(old)`
- **manual transitions must report start explicitly**: any path that pre-updates `queuePosition`/`currentItemId` before sending `playlist-next`/`playlist-prev`/`playlist-play-index` (playNextEpisode queue-advance / in-season / NextUp, playPreviousEpisode queue path) bypasses the `playlist-pos` handler's transition block — its guard is `newPos !== queuePosition`, already false by the time the event lands. Those paths call `beginPlaybackReporting()`; without it the server hears STOP for the old item and only PROGRESS for the new one (scrobblers miss the start, `playSessionId` goes stale). The `playlist-pos` `.catch` must call it too — reporting must never depend on the info fetch succeeding.

### Stale-async guards (generation tokens)

Any async continuation that outlives the file or command it was started for must be generation-guarded, or it mutates state for the wrong item:

- `fileLoadGeneration` (bumped on `file-loaded` AND at navigation via `invalidateFileGeneration()`) guards `loadExternalStreams` and the track-setup IIFE — without it a skip during the item-info fetch `sub-add`s the OLD item's external subs into the NEW file and rebuilds `streamIndexMap` from mismatched streams/tracks (wrong `aid`/`sid` thereafter). Check after **every** await, including inside the deferred post-add callback. Bumping at navigation time matters: the replacement stream takes seconds to load over HTTP, so a stale callback can fire long before the next `file-loaded` (verified live — a skip in the post-add window applied the old item's requested subtitle to the new file).
- `queueLoadGeneration` (bumped per `loadNewQueue`) stops two rapid Play commands from interleaving playlist sends — the older run's `insert-at` chunks would land AFTER the newer run's `replace`.
- `playbackGeneration` (bumped in `playMedia`) guards the same way for the spawn path.

Pattern: `const gen = ++XGeneration;` at entry, `if (gen !== XGeneration) return;` after each await and before each side effect. Same class of bug: fire-and-forget writes whose order matters (unwatched-quit's DELETE vs the stop report's UserData write) must be sequenced on `chainReport`, not left to chance.

### Uncaught exceptions

Both `uncaughtException` and `unhandledRejection` handlers call `shutdown()` to ensure clean exit.

## Testing approach

**WS resilience tests**: test 33 proves the server mechanism with raw sockets (two sockets = one session; session survives one close, dies with the last); test 34 is the user-visible acceptance test — the shim runs behind a TCP proxy in the suite and one connection is killed mid-flight while `/Sessions` is polled continuously (it must never blip). The proxy (`startWsProxy`) is also the pattern to reuse for any future network-glitch simulation — its `{ stallUpgrades: true }` mode keeps client sockets CONNECTING forever (test 37's shutdown regression: closeAllWs must not crash on them). Test 35 covers the apiKey URL/redaction contract; test 36 revokes the shim's token via a same-device re-login and asserts reauth recovery.

**Test-run hygiene**: every shim the suite spawns gets `JELLYFIN_MPV_NO_DIALOGS=1` — a test with a broken config must never raise the native error dialog on the user's desktop (it once did: a misconfigured proxy test popped "Authentication Failed"). Ad-hoc test shims must set it too. Identity checks in the suite must use mpv's `path` (never `filename` — for stream URLs that is just `stream?static=true&ApiKey=…` and cannot contain the item id).

**Never run the live suite (or probes) while the owner is using the server.** The suite plays NextUp items and rewrites UserData (played/position/favorite) around every test — run concurrently with real viewing it reverts the viewer's watched marks ("had to mark them again"), floods their sessions with UserDataChanged, and destabilizes the web UI (observed live 2026-10-23). The suite now refuses to start when another session has `NowPlayingItem` set (`--force` overrides). Ad-hoc probe scripts must use their own throwaway `DeviceId` — authenticating with the real device's id (e.g. the shim's `Matteo-Mac`) invalidates that device's live token and kicks its sockets ("System Shutdown" + reauth storms mid-playback).

**Automated tests** (`npm test`):

- `tests/log-contracts.test.mjs` — verifies macOS app contract patterns exist in shim.js, error patterns present, log function signature, no conflicts between new and existing log lines
- `tests/config.test.mjs` — verifies config.example.js is valid JavaScript, all required options present, CONFIG object has all expected properties, all options documented
- `tests/quality.test.mjs` — verifies no duplicate keyboard shortcuts, all PlaystateCommand/GeneralCommand types handled, no hardcoded secrets, version consistency, SupportedCommands enum names

**Manual testing** with a real Jellyfin server:

1. Starting the shim (`npm start`) and connecting from Jellyfin web UI
2. Testing Play/PlayNext/PlayLast queue behavior
3. Testing Playstate commands (Pause, Seek, Next/Prev track)
4. Testing DisplayMessage from Jellyfin dashboard
5. Testing subtitle switching from both sides
6. Testing headless mode (`headless: true` in config, check `data/shim-<configname>.log`)
7. Testing auto-close (`autoClose: true` in config)
8. Testing fullscreen (`fullscreen: true` in config)
9. On macOS: building the app and testing from the menubar
10. On Linux: testing `launch.sh --install-service` and systemd service
11. On Windows: testing `launch.bat --headless`

## Security considerations

- `config.js` is gitignored — contains server credentials
- `data/jellyfin_token_{deviceId}.json` contains JWT tokens — never commit
- `data/.device-id` is machine-specific — never commit
- API tokens are logged in `getAuthHeaders()` debug output — be careful with logging
- `shim.js` reads `package.json` at runtime for version — never hardcode version strings
- The shim connects to Jellyfin over HTTP by default — HTTPS requires correct `serverUrl`
- `mpvFlags` user config is passed directly to MPV as command-line arguments — no sanitization (intentional, user controls their own machine)
- **Secrets redaction**: `redact()` function masks `api_key` and `X-Emby-Token` in log output
- **Token file permissions**: Data directory created with `chmod 0o700`, token files with `chmod 0o600`
- **Stale IPC socket cleanup**: `fs.unlinkSync()` called before spawning mpv to clean up stale sockets from previous crashes

## Log line contracts

`NodeProcessManager.swift:processLogLine` parses stdout from shim.js. It runs on the **main thread** (dispatched from background readability handler). Changing these patterns breaks the macOS app silently:

| Pattern in stdout | What Swift code does |
|---|---|
| `WebSocket connection established` | Status → connected, notification |
| `Episode detected: <title>` | Sets now-playing title, status → playing |
| `Starting next episode: <title>` | Updates now-playing title |
| `Starting previous episode: <title>` | Updates now-playing title |
| `Starting episode: <title>` | Updates now-playing title (emitted for movies/music — non-episode items) |
| `File loaded by MPV` | Status → playing (fallback) |
| `Playback paused` | Pause state on |
| `Playback resumed` | Pause state off |
| `No more episodes` | Clears now-playing, status → connected |
| `Closing application` / `MPV closed` / `Process terminated` | Clears now-playing, status → connected (`Process terminated` is logged by the macapp itself, not the shim) |
| Lines containing `error` (case-insensitive) / `fatal` / `❌` / `⚠️` | Error notification (throttled to one per 30s) |

stderr is also routed through `processLogLine` (prefixed with `STDERR:`), so error markers in stderr trigger error notifications.

Only the **primary** socket emits `WebSocket connection established` (contract line) and `Connected to Jellyfin`; the presence socket logs `Presence WebSocket established` / `Presence socket disconnected` — deliberately NOT containing any contract pattern so the macapp state is driven by the primary alone.

Title format for `Episode detected`: `SeriesName - SxEp - EpisodeName` (assembled at the call site in `getEpisodeInfo()`). Next/prev episode logs use the same format. `Starting episode:` carries the bare item title (movies/music).

## Gotchas

- `config.js` is gitignored. Missing file → `MODULE_NOT_FOUND` on start.
- `deviceId` must differ from `deviceName` per Jellyfin's device registration.
- `setupApplicationSupport()` always overwrites `shim.js` from the bundle on launch. This ensures rebuilds take effect.
- The bundled Node.js is arm64 or x64 depending on build machine — not universal.
- `processLogLine` mutates `isPlaying`, `isPaused`, `nowPlaying` — always runs on main thread (dispatched from GCD background thread in readability handler).
- `isStoppingPlayback` flag prevents stale log lines from corrupting state after user clicks Stop. Cleared when MPV closes.
- `pendingQueries` Map must resolve all promises before clearing — otherwise poll timer hangs forever.
- `isPlayingNext` flag prevents double-triggering of episode transitions. Has a 30s timeout fallback in case `loadfile` silently fails.
- `markedWatched` Set prevents duplicate "mark as watched" API calls. Cleared on each new file load.
- MPV args are minimal. User's `~/.config/mpv/mpv.conf` handles vo, hwdec, ao, cache, etc.
- **Stays in the fork network deliberately** — GitHub's "Leave fork network" drops issues, PRs and "other metadata" (that means the 350+ PR record and likely the release assets), which outweighs the cosmetic "forked from" tag.
- `gh` CLI defaults to upstream repo (JohnGlaus), not the fork. Run `gh repo set-default MrGameVlogger/jellyfin-mpv-play` or use `-R MrGameVlogger/jellyfin-mpv-play` with release commands.
- All windows use standard layering (no `.floating`). Status bar icons are template images — they adapt to light/dark mode automatically.
- `ConfigParser.swift` is the shared utility for config file parsing and Application Support paths. Used by AppDelegate, NodeProcessManager, and PreferencesWindowController.
- `Info.plist` has TWO version keys: `CFBundleVersion` (build number) and `CFBundleShortVersionString` (display version). Both must be updated when testing locally.
- `Info.plist` version is auto-synced by CI — don't edit manually for release builds. For local builds, use `sed -i '' 's/old/new/g' macapp/Info.plist`.
- Config file location: `~/Library/Application Support/JellyfinMpvPlay/config.js`
- Log file location: `~/Library/Application Support/JellyfinMpvPlay/data/jellyfin-mpv-play-*.log` (timestamped)

## Jellyfin API compliance

The shim handles three WebSocket message types: `Play`, `Playstate`, `GeneralCommand`.

**PlaystateCommand** — all 9 handled: Stop, Pause, Unpause, PlayPause, NextTrack, PreviousTrack, Seek, Rewind, FastForward.

**GeneralCommand** — SetAudioStreamIndex, SetSubtitleStreamIndex, SetVolume, VolumeUp/Down, Mute/Unmute/ToggleMute, SetRepeatMode, SetPlaybackOrder, DisplayMessage, PlayNext, ToggleFullscreen, SetShuffleQueue. (SkipIntro, SetSubtitleDelay and SetAudioDelay are ALSO handled, but they are NOT part of Jellyfin's `GeneralCommandType` enum as of Jellyfin 12.2 — the server can never send them; the handlers are kept only for forward compatibility and are reachable via the S key / jf-mpv-osc.)

**SyncPlay** — Full support:
- SyncPlayCommand: Unpause, Pause, Stop, Seek, SetPlaylistOrder, SetRepeatMode, SetShuffleMode
- SyncPlayGroupUpdate: GroupJoined, GroupLeft, GroupDoesNotExist, NotInGroup, LibraryAccessDenied, PlayQueue, StateUpdate (waiting/ready states)
- GetUTCTime: responds with UTC time for clock synchronization
- Group tracking: currentSyncPlayGroupId, currentSyncPlayGroupName

**PlayRequest fields used**: ItemIds, StartPositionTicks, PlayCommand (PlayNow/PlayShuffle), StartIndex, AudioStreamIndex, SubtitleStreamIndex.

**Progress reports include**: ItemId, PositionTicks, IsPaused, IsMuted, VolumeLevel, PlayMethod, PlaySessionId, CanSeek, RepeatMode, PlaybackOrder, MediaSourceId.

**SupportedCommands** must use exact `GeneralCommandType` enum names from Jellyfin source (`MediaBrowser.Model/Session/GeneralCommandType.cs`). Wrong names cause 400 errors. `tests/quality.test.mjs` validates every advertised name against the Jellyfin 12.2 enum. Note: `ClientCapabilitiesDto` has no `SupportsSync`/`SupportsRemoteControl`/`SupportsContentUploading` fields (Jellyfin discards them) — SyncPlay works purely via WebSocket messages.

**Shutdown**: Sends `SessionsStop` message before closing WebSocket to prevent zombie sessions.

**Jellyfin 12 notes** (verified against a live 12.x server): stream URLs use `ApiKey=` casing (thumbfast parses both); `GET /Users` returns ALL users to any authenticated caller (use `/Users/Me` when you want the caller's own user — an old `users[1]` pick would grab the wrong one); Trickplay metadata is nested `{itemId: {width: info}}` (≤10.9 sent `{width: [info]}`) — thumbfast-jellyfin v1.1.3+ parses both; a session disappears from `/Sessions` only when ALL of its WebSockets are down and reappears with the same id once any reconnects (the e2e suite's findSession waits for exactly that; tests 33-34 pin the dual-socket behavior).

**External (sidecar) stream delivery** (verified live): text subs at `/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}` (srt/ass/vtt convert fine; bitmap formats like sup/pgs return 400 — no text conversion path, skip those); audio at `/Audio/{itemId}/stream?audioStreamIndex={index}&mediaSourceId={...}` — there is NO `/Videos/{id}/{ms}/Audio/{index}/stream` path (404).

## Historical context

This project started as a simple MPV shim for Jellyfin and grew significantly:

- **v1.0-v1.7**: Basic shim with manual episode navigation, no queue, no OSD, no headless mode
- **v1.8.0**: Major feature release — queue system, DisplayMessage OSD, subtitle sync, headless mode (Linux systemd), custom MPV flags, fullscreen, auto-close. All features built from scratch in `shim.js`.
- **v1.8.1**: Pre-release (no assets — CI failed due to missing sync-output directory)
- **v1.8.2**: Bug sweep — CI fix, Info.plist version stuck at 1.7.6, security audit, documentation overhaul
- **v1.8.3**: Documentation polish — README troubleshooting expanded, CONTRIBUTING architecture docs, AGENTS.md audit checklist, .editorconfig, signed commits
- **v1.9.0**: Feature release — auto-skip intros/outros, error OSD messages, next-up notification, better logging with structured format, automated tests, comprehensive bug audit (24+ fixes)
- **v1.9.1**: Bug fixes — audio loss on resume, seek race condition, error propagation, disableSkipIntro config option
- **v1.9.2**: Bug fixes — ConfigParser URL parsing, Preferences UI, queue load counter, headless detection, MPV stderr
- **v1.10.0**: Feature release — full season queue, NextUp for specials, playlist-pos observer, jf-mpv-osc integration (Tier 0-3), audit fixes (12 bug fixes, 8 audit fixes, 7 new tests)
- **v1.11.0**: Feature release — full SyncPlay support (commands, group updates, waiting/ready states, UTC time sync, OSC integration), SetShuffleQueue, SetSubtitleDelay, SetAudioDelay, ActivityLogEntry

Key architectural decisions:
- **No classes, no modules** — entire app is one procedural file with module-level state. This was intentional for simplicity and easy deployment (single file).
- **MPV native playlist** — leveraging MPV's built-in playlist rather than manual loadfile calls for each transition.
- **Log line contracts** — stdout parsing by macOS app created a hard API surface that must never change.
- **`package.json` as version source** — CI syncs versions to Info.plist and SECURITY.md automatically.

## Release workflow

1. Increment version in `package.json` (use `npm version X.Y.Z`)
   - **Important:** `npm version` automatically updates both `package.json` and `package-lock.json`. Always use this command instead of manually editing version numbers.
2. Update `macapp/Info.plist` version to match:
   - Use `sed -i '' 's/old-version/new-version/g' macapp/Info.plist` (preserves formatting)
   - **Do NOT use PlistBuddy** — it reorders keys and changes indentation
   - Update both `CFBundleVersion` and `CFBundleShortVersionString`
3. Update `CHANGELOG.md` with release notes
4. Update `README.md` "Recent Releases" section:
   - Add the new version at the top of the list
   - Keep only the latest 4 releases in "Recent Releases"
   - **Move** the 5th release into the `<details><summary><b>Older releases</b></summary>` collapsible section
   - **NEVER delete a release entry** — always move it to the collapsible section
   - Place it at the top of the older releases list (before the previous older release)
5. Commit, push to a branch, and merge via PR
6. Create and push a version tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
7. The CI workflow (`.github/workflows/build.yml`) automatically:
   - Reads version from `package.json`
   - Generates release notes from CHANGELOG.md entries
   - Builds macOS `.app` bundle (runs on `macos-latest`)
   - Builds Linux bundle with bundled Node.js (runs on `ubuntu-latest`)
   - Builds Windows bundle with bundled Node.js (runs on `windows-latest`)
   - Creates a GitHub Release with auto-generated notes and all 3 platform artifacts

### Release command gotchas

- `gh release create` needs explicit notes: `--notes-file` (or `-m`/`-F`).
  In non-interactive terminals it fails with "Terminal is dumb, but EDITOR
  unset / Please supply the message using either -m or -F option". Extract
  the CHANGELOG section into a file and pass it with `--notes-file`.
- Tag with `git tag -a vX.Y.Z -m "vX.Y.Z"` (step 6). A bare `git tag vX.Y.Z`
  fails in dumb terminals. If a tag is missing, `gh release create` will
  create it at the target commit.
- After the release lands, rebuild and deploy locally (`cd macapp && ./build.sh`)
  so /Applications matches the released revision. The running menubar app
  copies `shim.js` from the bundle at launch — a restart picks up the new
  code; the running mpv session can be left alone.

### PR description gotchas

When using `gh pr create --body`, the shell will interpret backticks, `$()`, and other special characters. Use one of these approaches:

- **Single quotes** around the entire body: `--body 'description with \`backticks\` and $(stuff)'`
- **Heredoc**: `--body "$(cat <<'EOF' ... EOF)"`
- **No backticks in body** — use plain text instead of inline code formatting

Example of what **NOT** to do (zsh will try to execute backtick contents):
```
gh pr create --body "Fixed `loadfile` command"  # BROKEN — zsh runs "loadfile" as a command
```

Example of correct approach:
```
gh pr create --body 'Fixed loadfile command'    # OK — plain text
```

`package.json` is the single source of truth for version. `shim.js` reads it at runtime. CI auto-syncs `Info.plist` into release artifacts, but **local builds require manual Info.plist updates**. The test `package.json version matches Info.plist version` will catch mismatches if Info.plist is included in the PR.

**Important**: `gh` may default to the upstream repo (JohnGlaus). Always use `-R MrGameVlogger/jellyfin-mpv-play` with release commands, or run `gh repo set-default MrGameVlogger/jellyfin-mpv-play` once.

### When to build locally

After making changes to `shim.js` (or any code), **always build and test locally before pushing**:

```bash
cd macapp && ./build.sh    # builds AND deploys to /Applications
open "/Applications/Jellyfin MPV Play.app"
```

- **Do NOT use `CI=true` for local testing** — that's only for CI pipelines. Local builds should deploy to `/Applications` so you can actually run and test the app.
- **Test the built app** — Launch it, connect to Jellyfin, play an episode, verify the fix works.
- **`npm test` is not enough** — Tests check syntax and contracts, but don't verify runtime behavior. A local build + manual test catches what tests can't.
- **After merging, redeploy** — `./build.sh` keeps `/Applications` current with main; the deployed bundle can run ahead of the latest *release* (that is expected while fixes accumulate before tagging).

**⚠️ Never delete releases to reorder them** — GitHub release assets (zip files, etc.) are permanently deleted when a release is deleted. If you need to reorder releases, use the GitHub API to update `published_at` dates instead. Always download assets before deleting a release.

**⚠️ Don't be release-happy** — Batch related fixes into a single release. Do NOT release each individual fix as its own version. Investigate, test, and iterate BEFORE tagging. A release should be a coherent set of changes, not a trail of trial-and-error. If you make a fix that turns out to be wrong and needs reverting, that should happen in development — not as separate releases.

## GitHub workflow

- **Branch protection**: `main` requires PRs (force pushes and deletions blocked)
- **Merge strategy**: Squash merge (`--squash`) — one commit per PR
- **PR workflow**: Create branch → commit → push → `gh pr create` → `gh pr merge --squash` → delete branch
- **⚠️ NEVER push directly to `main`** — always create a branch and open a PR, even for docs or small fixes. The branch protection allows maintainer bypass but this should not be used.
- **Make PRs frequently during development** — Each logical change (bug fix, feature, docs update) should be its own PR. Don't batch everything into one giant PR at release time. Small, focused PRs are easier to review and merge. When you finish a fix or feature, commit it and make a PR immediately before moving on to the next task.
- **Dependabot**: Weekly npm dependency updates on Mondays
- **Node LTS bump** (`.github/workflows/node-lts-bump.yml`): Weekly check of the bundled Node.js pin (`NODE_VERSION` in `macapp/build.sh` AND `.github/workflows/build.yml` — kept in lockstep, `tests/quality.test.mjs` enforces the match). Same-major LTS patches open an auto-PR; a new LTS major opens an evaluation issue (major runtime moves are deliberate). PRs from this workflow use the default `GITHUB_TOKEN`, so labeler/CI do not run on them.
- **Auto-labeler**: PRs auto-labeled by file paths (macos, shim, documentation, ci, dependencies, images, linux, windows)
- **Signed commits and tags**: SSH signing configured in global git config — all commits and tags should be signed

## Running a comprehensive audit

When asked to audit the entire project, run ALL of the following checks. Fix everything through PRs, never push directly to main.

### 1. Code audit

Read EVERY file completely. Do not skip or summarize. Check for:

**shim.js:**
- Race conditions (state mutated across async boundaries)
- Error handling gaps (silent catches, missing error paths)
- Dead code, unused variables, unreachable branches
- Platform issues (Windows paths, IPC socket cleanup)
- Memory leaks (event listeners, intervals, sets never cleared)
- Log message consistency (these are parsed by the macOS app — see "Log line contracts" above)
- Security (API keys in logs, token file permissions)
- Version consistency (`clientVersion` vs `package.json`)

**macapp/Sources/*.swift (all 11 files):**
- NSObject inheritance for classes using @objc selectors
- Thread safety (properties mutated from multiple threads)
- Memory leaks (retain cycles in closures, missing [weak self])
- Missing error handling
- Deprecated APIs vs minimum macOS version
- Duplicate code across files (shared utilities)
- Logic bugs (state desync, unreachable code)

**macapp/build.sh:**
- curl flags (-f for fail on HTTP errors)
- Architecture handling
- Missing error messages

**linux/launch.sh:**
- Symlink resolution
- Error handling (set -e interactions)
- Exit codes on signals
- File existence checks

**windows/launch.bat:**
- Path quoting (special characters)
- Error handling
- Line endings (should be CRLF)

**linux/jellyfin-mpv-play.desktop:**
- Exec line correctness (test with $0 = _)
- Icon reference
- Spec compliance (Version field, Categories)

**config.example.js:**
- Platform-specific defaults
- Comment accuracy

### 2. Documentation audit

Read ALL docs completely. Check for:

**README structure:**
- "Recent Releases" section shows only the latest 4 releases
- All older releases are inside the `<details><summary><b>Older releases</b></summary>` collapsible section
- Broken/superseded releases have strikethrough (`~~text~~`)
- Never delete release entries — move them to the collapsible section
- Never create duplicate collapsible sections

**Version consistency:**
- package.json version matches Info.plist (auto-synced by CI)
- shim.js reads from package.json (no hardcoded version)
- CHANGELOG.md has entry for current version
- README.md "Recent Releases" lists current version
- SECURITY.md supported versions table is current
- CONTRIBUTING.md references are accurate

**Content accuracy:**
- Line counts match actual file sizes
- Release workflow matches actual CI behavior
- All links are valid (format-wise)
- No stale information from previous versions
- Platform-specific instructions are correct

**Files to check:**
- README.md
- AGENTS.md
- CHANGELOG.md
- SECURITY.md
- CONTRIBUTING.md
- CODE_OF_CONDUCT.md
- config.example.js
- .github/pull_request_template.md
- .github/ISSUE_TEMPLATE/*.md
- .github/copilot-instructions.md
- .github/skills/code-review/SKILL.md

### 3. CI/CD audit

Check all GitHub features:

**Workflows:**
- Build & Release: does it trigger on tags? Does it build all 3 platforms? Are release notes correct?
- Labeler: are all file patterns correct? Any overlaps? Any missing patterns?
- CodeQL: is it running? 0 alerts? Correct languages?
- Dependabot: correct ecosystems (npm + github-actions)?

**Run these commands:**
```
gh api repos/MrGameVlogger/jellyfin-mpv-play/actions/workflows -q '.workflows[] | "\(.name) [\(.state)]"'
gh run list -R MrGameVlogger/jellyfin-mpv-play --limit 10
gh api repos/MrGameVlogger/jellyfin-mpv-play/code-scanning/default-setup -q '{languages: .languages, state: .state}'
gh api repos/MrGameVlogger/jellyfin-mpv-play/code-scanning/alerts -q 'length'
gh api repos/MrGameVlogger/jellyfin-mpv-play -q '.security_and_analysis'
```

**Check for:**
- Stale branches (should only be `main`)
- Open PRs (should be none unless work is in progress)
- Failed workflow runs and their error logs
- Release assets (all 3 platforms present)
- Release notes quality (no CI noise, correct categorization)

### 4. Version release check

If a release was recently created, verify:
- Tag points to the correct commit
- Release notes match what's actually in the build
- All 3 platform bundles are present
- No code fixes listed that aren't in the build
- Downloads table has correct version-specific filenames

### 5. Post-audit

After fixing everything:
- All fixes go through PRs (never push to main)
- Update CHANGELOG.md if code changes were made
- If version was bumped, update Info.plist, CHANGELOG.md, README.md in the same PR
- Clean up any stale local branches
- Run `git status` to verify clean working directory
