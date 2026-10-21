# Changelog

All notable changes to Jellyfin MPV Play are documented here.

<!--
## vX.Y.Z — TEMPLATE (copy this for new releases)

### New Features
- **Feature name** — Description of what it does and how to use it

### Bug Fixes
- **Fixed bug name** — Description of what was broken and how it's fixed

### Internal
- **Change name** — Description of internal change (CI, docs, refactoring)

---

-->

## v1.14.2

### Security
- **Bundled Node.js 22.23.1 → 22.23.4** across all three platform bundles (macOS app, Linux, Windows). Picks up the October 21, 2026 security release:
  - **CVE-2026-106069 / CVE-2026-106072** (high / medium) — TLS certificate hostname verification bypasses; the shim validates TLS on every request when `serverUrl` is HTTPS.
  - **CVE-2026-111497** (high) — Brotli decoder out-of-bounds write permitting remote code execution; Node's HTTP client advertises `br` encoding.
  - **CVE-2026-105481** (medium) — keep-alive sockets could accept a response written before the request was sent.
  - **CVE-2026-106074** (medium) — `randomUUID()`/`randomInt()` entropy caches leaked into startup snapshots, repeating values across processes (used for device IDs and play session IDs).
  - **CVE-2026-105482** (high) — `dns.resolve` name truncation on NUL characters.
  - **CVE-2026-106073** (low) — permission model bypass via `fs.realpathSync`.
  - Dependency updates: c-ares, **eMudhra intermediate CA removal** (compromised CA), OpenSSL, SQLite, Undici.

---

## v1.14.1

### Security
- **Patched credential-header leak on cross-origin redirects** (follow-redirects 1.16.0 → 1.16.1, transitive via axios, which every Jellyfin API call uses). Two advisories, both fixed in 1.16.1:
  - **GHSA-q3jh-wrc6-jgq8** (high) — array-form request headers bypassed cross-origin sensitive-header stripping, so a malicious or compromised redirect target could silently harvest the `Authorization: MediaBrowser Token=...` header the shim sends on every request.
  - **GHSA-8r9p-f939-6h3c / CVE-2026-111755** — incomplete regex escaping let metacharacter-named headers silently bypass the `sensitiveHeaders` protection (the shim does not use that option; listed for completeness).

---

## v1.14.0

### Features
- **Stock OSC usability — named playlist entries, external stream loading, accurate track mapping.** Queue entries are now loaded through in-memory M3U playlists, so mpv's own OSC playlist shows episode/movie names instead of raw stream URLs (which also keeps the ApiKey token off screen), and the title bar is correct the instant an entry starts. External (sidecar) subtitle/audio streams — which the static container stream does not carry — are now added to mpv per file with their Jellyfin display names: a movie whose subs are all external previously had *zero* subtitle tracks in mpv. The Jellyfin<->mpv stream index mapping is now explicit (embedded zipped by order, externals matched by URL) because Jellyfin numbers external streams first and its Index is not the container ff-index — track reporting and selection were wrong for such files.

### Bug Fixes
- **Movies lost all audio/subtitle track options in the OSC.** The shared item payload omitted `mediaStreams` for non-episode items, so the jf-mpv-osc state blob dropped its `subtitles`/`audio` arrays (which the OSC reads as "remove this UI"). All item types now return the same payload.
- **Server kept showing the item as playing after a clean quit.** mpv emits a phantom `pause=false` while exiting; the resulting progress POST could land after the stop POST and Jellyfin re-stamped the session as playing. Progress is now suppressed from quit-initiation, the stopped state persists until the next playback starts, and all playback reports are serialized to the server in call order.
- **Manual transitions never reported playback start.** Queue next/prev, in-season advance and NextUp pre-update the queue position, bypassing the `playlist-pos` transition block — the server heard STOP for the old item and only PROGRESS for the new one (scrobblers missed the start, `playSessionId` went stale). All transition paths now report explicitly, including when the item-info fetch fails.
- **Stale async continuations mutated the wrong file and raced server writes.** Skipping during the external-stream load applied the old item's subtitle selection to the new file and rebuilt the track map from mismatched streams; "Quit and Mark Unwatched" deleted user data before the stop report rewrote it (the item came back with progress); two rapid Play commands interleaved their playlist sends. All three are now generation-guarded or sequenced on the shared report chain.

### Internal
- Live verification suites for each fix, each proven to fail on the unfixed code: transition-start (8), stop-race (5 rounds), stale-async (7), playback smoke (12). New regression guards in `tests/quality.test.mjs` pin the invariants; AGENTS.md records the mpv/Jellyfin semantics learned (report ordering, stale-async generation tokens, external stream delivery routes).

---
## v1.13.0

### Features
- **Redundant presence WebSocket keeps the web UI's cast alive.** The shim now maintains a second connection to the server. Jellyfin merges both into one session and only removes the session from `/Sessions` when *every* socket is down — and the Jellyfin web UI drops its cast selection and playback controls the moment the session disappears from that list (it never re-attaches on its own). A single-socket drop is now completely invisible: no cast loss, no controls loss, no OSD. Disable with `wsPresenceSocket: false` in config.js.

### Bug Fixes
- **Dead-connection watchdog.** A half-open TCP connection (the path died without a close frame) used to accept sends silently for many minutes while holding a zombie session. The shim now proves the link with protocol pings every 15s and force-closes the socket after 35s of silence, entering the reconnect path immediately. TCP keepalive (20s) is also enabled as NAT insurance.
- **Reconnect within ~1s of the server's return.** While disconnected, the shim probes the server every second and reconnects the moment it answers — previously it slept for the next backoff slot first (up to 30s late). On reconnect it immediately re-reports playback state so the web UI shows correct state the moment the session reappears.

### Internal
- Live e2e suite grown to 34 tests, including two WS-resilience tests: raw-socket proof of the session/socket mechanics (one session id survives one close, dies with the last) and the acceptance test — a real shim connection TCP-killed mid-flight behind a TLS-aware proxy while `/Sessions` is polled continuously and must never blip.

---
## v1.12.4

### Bug Fixes
- **WebSocket refresh watchdog removed** — it closed and reopened the connection every 25 minutes to preempt external cuts, but those cuts are not connection-age-based (a drop was observed 5 minutes after a refresh) while every refresh was a real disconnect for the client: the Jellyfin web UI drops its cast selection and playback controls on it. Users on perfectly healthy connections got a guaranteed cast-disconnect every 25 minutes, and locally-hosted users reported losing the cast and remote controls mid-session (queue, progress and watched marking kept working — those are HTTP). With the watchdog gone a healthy connection sees no WebSocket events at all; reconnect-on-real-drops is unchanged.

### Internal
- E2E test 19 identifies episodes via `path` — mpv's `filename` is only the URL basename and can never contain the item id (the suite's own rule); it now polls instead of trusting a fixed sleep.

---

## v1.12.3

### Bug Fixes
- **Orphaned mpv processes are reaped** — a crashed test run or a force-quit left `mpv --idle --keep-open` alive forever (found in the wild: a 3.5-day-old orphan holding a stray window). The shim now quits any leftover mpv still holding its IPC socket at startup, and the e2e suite sweeps test mpvs whose owning run is dead before it starts. Also fixes the suite's `stopShim` kill pattern, which matched nothing.

---

## v1.12.2

### Bug Fixes
- **OSC state fidelity** — jf-mpv-osc now gets a state push whenever tracks or sub-style values change (including mpv's own r/R/F/G/L keys), queue changes push immediately (PlayNext, PlayLast, server shuffle, playlist resync), and RepeatMode/PlaybackOrder in progress reports reflect real state instead of hardcoded values.
- **Correct sub_style defaults in the OSC** — mpv reports colors as `#AARRGGBB`, so the OSC showed the raw `#FFFFFFFF` with nothing selected. Colors are normalized and position reporting is truthful.
- **ASS subtitle edits no longer destructive** — a forced style override moved "Top" to mid-screen and clobbered fansub layouts. Position is handled by `sub-pos` alone (verified by frame rendering), ASS colour reads "Style" until explicitly forced, and colour edits preserve any `sub-ass-style-overrides` from mpv.conf.
- **"Quit and Mark Unwatched" keeps its promise** — no resume position is saved locally or on the server (stop report at position 0) and the item is reset to unwatched in Jellyfin. A stale intent from a lost quit command clears when the next file loads.
- **Truthful repeat reporting** — numeric `loop-playlist`/`loop-file` counts (mpv allows them) were reported as RepeatNone; any active loop now maps to RepeatOne/RepeatAll.
- **Trailing sub-style push** — holding r/R and releasing left the OSC showing a stale value; the final change now lands.

### Internal
- **Live E2E suite: 32 tests, zero residue** — new pins for sub_style defaults and ASS behaviour, the "no automatic subtitle changes" rule, and unwatched-quit semantics. Teardown restores all Jellyfin UserData (verified) and removes every local artifact the run creates.
- **CodeQL clean** — completed the string escaping in the e2e config generator (js/incomplete-sanitization).
- Repository renamed to `jellyfin-mpv-play`; all references updated. Upstream SHAs registered so GitHub reports 0 commits behind (content unchanged).

---

## v1.12.1

### Bug Fixes
- **Fixed macOS menu shortcuts missing** — The HIG pass removed the status menu key equivalents (⌘P Pause, ⌘. Stop, ⌘C Copy Now Playing, ⇧⌘C Copy Log, ⌘L Logs, ⌘, Settings, ⌘I About, ⌘R Restart, ⌘/ Help, ⌘Q Quit). All restored; the Help window's shortcut table is back too (and now also documents the previously missing Copy shortcuts and the S skip-intro key).
- **Fixed wrong copyright year** — The About window claimed "© 2024-2026"; the project started in 2026. Now "Copyright © 2026 MrGameVlogger. MIT License." read from Info.plist.
- **Fixed stale pause state on track change** — Pausing and then moving to the next item kept showing "Paused" on the fresh episode.
- **DisplayMessage no longer pauses playback** — jellyfin-web shows the message as a toast/alert without touching playback; the shim paused for 10s. The message now appears on the OSD while playback continues, and the TimeoutMs argument is honored for its duration.
- **Faster WebSocket reconnection** — Reconnect backoff now matches jellyfin-web's SDK (1s × 1.5, 30s cap; was 5s doubling). The recurring connection drops (root-caused to short server-side outages of the hosting path — 5-30s windows in which both HTTP and WS are unreachable) are now recovered within seconds of the outage ending.
- **Planned connection refresh** — A watchdog cleanly refreshes the WebSocket before long-lived connections can be cut by connection-age limits in some network paths (verified: clean code-1000 close and ~0.4s reconnect vs the abrupt 1006 + backoff gap).

### macOS App
- **HIG pass C** — Intro skipping is now a 3-state radio group (Auto-skip / Show prompt / Off) instead of two mutually exclusive checkboxes; window-scoped error alerts are sheets instead of app-modal dialogs; the About window icon adapts when the system appearance changes (was stale after a dark-mode toggle); decorative images are hidden from VoiceOver; tool windows are not restorable.

### Internal
- **Live E2E suite expanded to 26 tests and hardened** — new test covers jellyfin-web's exact episode-click request shape (startItemId resolution + StartIndex); flakes traced to root causes and made deterministic (transitions must complete before the next command; session lookups wait out WebSocket blips; suite HTTP retries network failures). All fixes verified against jellyfin-web source and the live server.
- **Design principle deviations documented** — AGENTS.md now records the two intentional deviations from jellyfin-web (full-season queue back-navigation; PreviousTrack 30s restart rule).

---

## v1.12.0

### Bug Fixes (playback — all verified live against mpv 0.41 and Jellyfin 12.2)
- **Fixed wrong episode playing when starting a new show** — `playlist-clear` keeps the currently played file, which shifted every playlist index by one, so the queue could restart the old episode or play the neighbour. The queue now rebuilds with `loadfile replace` + `insert-at` and starts at exactly the requested item.
- **Fixed subtitle/audio track selection picking the wrong track** — Jellyfin stream indices are global container indices while mpv's `aid`/`sid` take per-type track ids; selections landed on the wrong track or disabled subtitles entirely. Now mapped via mpv's `track-list` `ff-index`, and the session reports Jellyfin indices back correctly.
- **Fixed Shuffle being silently undone** — jellyfin-web's Shuffle is transformed server-side into `PlayNow` with a shuffled id list, and the full-season expansion re-sorted it to season order. The requested order is now preserved (verified: 3/3 shuffled orders survive to the playlist).
- **Fixed playlist reorders misread as navigation** — `SetShuffleQueue`/`playlist-shuffle` shift indexes without changing the playing file; the shim treated that as an episode transition (bogus "next episode" logs, stop reports, and an end-of-queue NextUp round-trip that could clear the queue mid-playback). The playing item is now resolved from the playlist entry itself.
- **Fixed stopping near the end never marking items watched** — the 90% mark ran behind an in-flight stop report and only at mpv process exit (seconds later on network streams). It now runs at the Stop command, with the process-exit check kept as backstop.
- **Fixed series plays starting on a special** — the server expands a series id by SortName ("0x1 ..." first), so playback began on a random special while jellyfin-web starts at season 1. Series/season-level requests now start at the NextUp episode (first regular episode for unwatched shows); explicit specials selections play the special, matching jellyfin-web's own resolution.
- **Fixed transient API errors aborting playback** — item lookup failures looked identical to "not playable", so a network blip silently stopped playback ("Skipping non-playable item: undefined"). Lookups now distinguish the two, retry once, and show an OSD error.
- **Fixed the intro/outro segment filter being ignored** — the request used PHP-style array params that ASP.NET does not bind, so every segment type came back and auto-skip could eat previews/recaps (observed live: a Preview segment was being offered for skip).
- **Fixed SetPlaybackOrder/SetShuffleMode being no-ops** — `set_property shuffle` does not exist as a runtime property in mpv; now uses the `playlist-shuffle`/`playlist-unshuffle` commands.
- **Fixed SetShuffleQueue never reaching the shim** — implemented but missing from `SupportedCommands`, so the server never sent it (also fixed the capabilities payload to match Jellyfin's ClientCapabilitiesDto exactly — three fields it sent do not exist in Jellyfin).
- **Fixed track switches invisible in session state** — progress reports omitted audio/subtitle stream indices; dashboards never reflected track changes.
- **Fixed crash-dialog storms (EPIPE)** — a closed output pipe (parent teardown, `| head`, app restart) raised an uncaughtException per log line, each spawning a dialog and crash-log entry. Broken-pipe errors are now recognized by code or message, never reach the crash path, and playback keeps running when the log consumer disappears.
- **Windows: fixed `--headless` being treated as a config filename** (it literally created a file named `--headless`) and headless auto-detection matching commented-out `// headless: true` lines in the default config.

### macOS App
- **Apple HIG compliance pass** — installed the missing main menu (Cmd+W/Q/H/?, Settings…, window management), renamed Preferences to Settings (macOS 13+ naming), fixed dialog button order (default rightmost, Escape = Cancel), unified the Setup escape paths (close == Skip, neither starts the shim with empty credentials), and updated Help's keybind table to match reality.
- **Movies and music now show Now Playing** — only episodes populated the title, leaving Pause/Stop disabled and the menu saying "Not playing" during movie playback (the documented `Starting episode` contract is now implemented end-to-end).
- **Reliable error notifications** — most shim errors were invisible (case-sensitive matching missed "Error"/"⚠️"; "MPV closed with error" was swallowed by the state-reset branch). Now case-insensitive, checked before state transitions, and throttled to one per 30s.
- **Config safety on save** — the Settings panel deleted `mpvFlags` on every save (it could not even parse arrays, and the writer rebuilt the whole file), along with comments and unrecognized keys. Saving now merges: the UI owns its 14 keys, everything else passes through verbatim. The setup wizard writes the *selected* config and preserves other keys as raw lines (it used to re-serialize `mpvFlags` into a string the shim ignores).
- **Device identity** — the shared `mac-mpv` default device id (duplicate Jellyfin sessions across machines) is gone; empty means auto-generate per config.
- **Process lifecycle** — Restart/Quit no longer leaves phantom "playing" state (stop() raced its own pipes and never reset state), the crash auto-restart can no longer spawn an orphan after quit (cancellable work item), quit is asynchronous instead of blocking the main thread, and the 3-second stop-guard window is closed.
- **Robustness & accessibility** — invalid UTF-8 can no longer stall the log pipeline; log-file and bundle-copy failures degrade gracefully instead of silently breaking installs (failed copies used to delete the working shim.js first); over-long IPC socket paths fail loudly instead of silently truncating; VoiceOver labels and announcements on all form fields; SMAppService .requiresApproval surfaced; notifications degrade gracefully outside a bundle; paused state visible in menu/tooltip/icon.

### New Features
- **Startup token preflight** — expired Jellyfin tokens now refresh immediately at startup instead of a blind ~7s WebSocket-reject/reconnect gap.
- **Live E2E suite** (`npm run test:e2e`) — 25 automated tests against a real Jellyfin server and real mpv: play flows, all Playstate/GeneralCommands, track mapping, queue semantics, shuffle, transitions, skip-intro, OSC wire path, SyncPlay, watched state, autoClose, token hygiene, shutdown. Isolated per-run session; runs headless. This suite found six of the bugs fixed above.

### Internal
- **Design principle documented** — emulate jellyfin-web: its `playbackManager` is the behavioral reference (it resolves queues client-side and sends explicit ItemIds + StartIndex); the only intentional deviation is the full-season queue's earlier-episode back-navigation.
- Regression tests now validate every advertised command against Jellyfin's `GeneralCommandType` enum and every log contract against both sides (shim + macapp); mpv command-semantics guards (`playlist-play-index`, `playlist-shuffle`, segment param binding, track mapping) are pinned in tests.
- Multi-config device ids, IPC socket defaults and config parsing aligned with shim.js on all three platforms.

---

## v1.11.7

### Bug Fixes
- **Fixed wrong episode playing on queue load** — When clicking an episode mid-season (e.g. episode 10), episode 1 would play instead due to a race condition between `loadfile ... replace` (which starts playing immediately) and `set_property playlist-pos`. Changed to `loadfile ... append` + `playlist-play-index` to load the playlist silently and explicitly start playback at the correct index.
- **Fixed PlayNext/PlayLast insert-at-index** — The `loadfile` flag `insert-at-index` was invalid (mpv ignored it and fell back to `replace`). Fixed to `insert-at` per mpv documentation.
- **Fixed VolumeUp/VolumeDown from Jellyfin dashboard** — The `add_property` command was invalid (mpv ignored it). Fixed to `add` per mpv documentation. Volume controls from the Jellyfin web UI now work.
- **Fixed shuffle not restarting playback at position 0** — When shuffling and the current item was at index 0, playback would stop because the `set_property playlist-pos` call was guarded by `queuePosition > 0`. Now uses `playlist-play-index` unconditionally.

---

## v1.11.6

### Bug Fixes
- **Fixed reportPlaybackStop missing timeout** — Added 10-second timeout to prevent indefinite hangs when server is unreachable, which could permanently block stop reports
- **Fixed isReportingStop immediate reset** — Removed premature `isReportingStop = false` in `loadNewQueue()` and `playMedia()` that defeated the deduplication guard
- **Fixed eof-reached handler during queue loads** — Added `isNewQueueLoad` guard to prevent premature episode transitions when loading a new queue
- **Fixed IPC connection failure recovery** — Kill MPV when maximum IPC connection attempts are reached, instead of leaving it running without control

---

## v1.11.5

### New Features
- **Jellyfin 12 authentication compatibility** — Migrated from deprecated `X-Emby-Token` and `X-Emby-Authorization` headers to `Authorization: MediaBrowser Token=...` header. Works on Jellyfin 10/11/12.
- **Jellyfin 12 API compatibility** — Replaced deprecated `api_key` query parameter with `ApiKey` for stream URLs and WebSocket connection
- **Per-instance log files** — Log files now named by config: `shim-config.log`, `shim-config.work.log`
- **Duplicate instance detection** — Lock file tracks running instances per config, warns if another instance is using the same config
- **Duplicate instance dialog** — Native pop-up dialog when duplicate instance detected (macOS/Linux/Windows)
- **`--allow-duplicates` flag** — Bypasses duplicate dialog for intentional multi-instance. With flag, logs use PID suffix: `shim-config-12345.log`
- **Headless error dialogs** — Native dialog shown on authentication failure, uncaught exceptions, and fatal errors in headless mode

### Bug Fixes
- **Fixed Linux launcher syntax error** — Removed stray `fi` that broke the script when running without a terminal
- **Fixed argument parsing** — Flags before config file now work (e.g., `node shim.js --allow-duplicates`)
- **Fixed Linux foreground branch** — Now forwards flags via `"$@"` to shim
- **Fixed macOS Test Connection** — Uses `Authorization` header instead of deprecated `X-Emby-Authorization`
- **Randomized log names for duplicates** — When duplicate detected without `--allow-duplicates`, new instance gets random hex suffix to avoid overwriting existing log

### Internal
- **Consolidated error dialogs** — Single `showErrorDialog()` function used for crashes and headless errors
- **Updated documentation** — README, config.example.js, CHANGELOG examples corrected

---

## v1.11.4

### Bug Fixes
- **Fixed NextUp returning same episode** — Added retry logic with 1s delay when Jellyfin NextUp API returns the episode that was just watched (server-side caching issue). Queries up to 3 total attempts before giving up.

---

## v1.11.3

### Bug Fixes
- **Fixed NextUp race condition** — `markItemAsWatched()` is now awaited before querying NextUp API, preventing the same episode from being loaded twice at end of season
- **Added retry logic for markItemAsWatched** — Returns boolean indicating success, clears `markedWatched` flag on failure to allow retry, retries once in NextUp path
- **Redacted API keys in MPV stdout/stderr** — Applied `redact()` to all MPV output to prevent API key exposure in logs (MPV logs stream URLs to stdout)
- **Fixed Swift weak-self capture warnings** — Added `[weak self]` to outer closure in `NodeProcessManager.sendMpvCommand()` to properly propagate weak reference

---

## v1.11.2

### New Features
- **Multi-config support** — Run multiple instances with different configs: `node shim.js config.work.js`, `./launch.sh config.work.js`, `launch.bat config.work.js`. On macOS, config file selector in Preferences UI. Each config gets its own deviceId, token, positions, and IPC socket.

### Bug Fixes
- **Fixed SyncPlay ListGroups endpoint** — Changed `/SyncPlay/ListGroups` to `/SyncPlay/List` (correct Jellyfin API endpoint)
- **Redacted API keys in MPV loadfile logs** — Applied `redact()` function to URLs passed to `sendMpvCommand` to prevent API key exposure in logs
- **Suppressed MPV cache status log lines** — Filtered out `(Paused) AV:`, `(...) AV:`, and `Cache:` lines from MPV stdout/stderr to reduce log noise (even in verbose mode)
- **Improved message type logging** — Changed "Unhandled message type" to "Received message type" for less alarming debug output

### Internal
- **Verified all API endpoints** — Confirmed all endpoints against official Jellyfin OpenAPI spec (System/Info, Sessions/Capabilities, Shows/*, MediaSegments, SyncPlay/*)

---

## v1.11.1

### New Features
- **XDG_RUNTIME_DIR for IPC socket** — On Linux, IPC socket defaults to `$XDG_RUNTIME_DIR/mpv-ipc.sock` (user-private directory) instead of `/tmp/mpv-ipc.sock`

### Bug Fixes
- **Fixed stale IPC socket cleanup** — Added `fs.unlinkSync()` before spawning mpv to clean up stale sockets from previous crashes
- **Added `--cache=yes` to mpv arguments** — Better buffering for network streams

### Security
- **Secrets redaction** — Added `redact()` function to mask API keys and tokens in log output
- **Token file permissions** — Data directory created with `chmod 0o700`, token files with `chmod 0o600`

---

## v1.11.0

### New Features
- **Full SyncPlay support** — Complete SyncPlay implementation allowing the MPV client to participate in synchronized playback sessions:
  - **SyncPlayCommand handling** — Unpause, Pause, Stop, Seek, SetPlaylistOrder, SetRepeatMode, SetShuffleMode
  - **SyncPlayGroupUpdate handling** — GroupJoined, GroupLeft, GroupDoesNotExist, NotInGroup, LibraryAccessDenied, PlayQueue, StateUpdate
  - **Waiting states** — Pauses and shows "Syncing..." OSD when another client pauses/seeks
  - **Ready states** — Seeks to specified position and resumes when sync is ready
  - **GetUTCTime** — Responds with UTC time for clock synchronization
  - **Group tracking** — Tracks current SyncPlay group membership
  - **OSC integration** — syncplay-refresh, syncplay-join, syncplay-new, syncplay-disable actions
- **SetShuffleQueue** — Server can now shuffle the current queue
- **SetSubtitleDelay** — Server can adjust subtitle timing
- **SetAudioDelay** — Server can adjust audio timing
- **ActivityLogEntry** — Server activity logged at debug level

### Bug Fixes
- **Fixed PlayShuffle for series** — PlayShuffle now skips full season expansion entirely, using the user's selected (shuffled) order directly.

---

## v1.10.10

### Bug Fixes
- **Fixed `isNewQueueLoad` stuck true on error** — If `getEpisodeInfo` or `getIntroSegments` threw during `loadNewQueue()`, the `isNewQueueLoad` flag stayed true forever, breaking all subsequent playlist navigation.
- **Fixed stale `playQueue` after cross-season transitions** — When `playNextEpisode()` or `playPreviousEpisode()` called `playMedia()` for cross-season episodes, the old queue was loaded into the new MPV. Now clears queue before calling `playMedia()`.
- **Fixed OSD state corruption** — `showSkipOsd()` and `showErrorOsd()` destroyed saved OSD settings (font size, alignment) before reading them, causing OSD to always revert to hardcoded defaults after DisplayMessage overlaps.
- **Fixed PlayShuffle for series episodes** — PlayShuffle now preserves shuffled order when expanding to full season queue. Previously, the shuffled order was discarded and replaced with sequential season order.
- **Fixed Windows headless detection** — `launch.bat` `findstr` matched commented-out `// headless: true,` lines, causing false headless mode activation.
- **Added HTTP timeouts to playback reporting** — `reportPlaybackStart`, `reportPlaybackProgress`, and `reportPlaybackStop` now have 10-second timeouts to prevent zombie sessions if the server hangs.
- **Fixed indentation** — Corrected indentation in shutdown stop report code.

### New Features
- **EOF detection via MPV property** — Added `eof-reached` observer (ID 8) to detect end-of-file events. Logs item ID, position, duration, queue index, and whether it's the last item. This is more reliable than the progress poll's position-based check for triggering auto-close.

---

## v1.10.9

### Bug Fixes
- **Only show disconnect OSD after first retry fails** — Don't flash "Connection lost" on brief network blips. Only show the OSD after the first reconnection attempt fails (~5 seconds). Also show "Reconnected" OSD when successfully reconnecting.
- **Consolidated noisyTypes into single constant** — Two separate `noisyTypes` arrays were inconsistent. Now uses a single `NOISY_WS_TYPES` constant shared by both the message handler and the debug handler for unhandled messages.

### New Features
- **Detailed WebSocket disconnect logging** — Log close code, reason, time since last message, and time since last KeepAlive when the connection closes. Also log error codes on WebSocket errors.

### Internal
- **AGENTS.md improvements** — Added WebSocket behavior rules, disconnect diagnosis checklist, OSD behavior rules, known issues, investigation history, proactiveness guidelines, and filled knowledge gaps.

---

## v1.10.8

### Bug Fixes
- **Fixed ForceKeepAlive data parsing** — `msg.Data` can be a number, string, or object (`{Timeout: N}`). NaN from bad parsing would cause a 0ms tight loop flooding the socket. Now parses all formats safely with fallback to 30.
- **Restored KeepAlive in noisyTypes** — Removing it caused info-level "Message received: KeepAlive" log spam every 30s in headless mode. Echo is still logged at debug level in handleMessage.

### Notes on v1.10.5–v1.10.8
These four releases were the result of a single investigation into WebSocket disconnects. The investigation revealed:
- The `ws` library v8.x already auto-responds to protocol-level `ping`/`pong` frames (v1.10.5's manual handler was redundant)
- The `127.0.0.1` disconnects in server logs were the Jellyfin web UI, not our client
- The client's actual disconnects are network-level drops between the Mac and server
- The `ForceKeepAlive` handler was resetting our own interval timer, preventing independent KeepAlive sends

These should have been a single release. Future investigations should complete before tagging.

---

## v1.10.7

### Changes (superseded by v1.10.8)
- **Restored 30-second KeepAlive interval** — Correct. The 60s default from v1.10.6 was too slow.
- **Restored ForceKeepAlive interval reset** — Correct. Resets to half the server's requested value (capped at 30s).
- **Added debug logging for server echo** — Logs when server echoes our KeepAlive back.
- **Filtered noisy types in debug log** — `RefreshProgress`, `Sessions` no longer logged as "Unhandled".

### Superseded by v1.10.8
This version was functionally correct but lacked safe parsing of ForceKeepAlive data (`msg.Data` could be an object, causing a 0ms tight loop).

---

## v1.10.6

### Changes (superseded by v1.10.8)
- **Changed default KeepAlive from 120s to 60s** — Still wrong. The server sends ForceKeepAlive every ~48s which resets our timer, so the 60s default never fired independently.
- **Capped ForceKeepAlive handler at server's requested value** — Correct approach, but the default interval was still too slow.
- **Added debug logging for unknown message types** — Good addition, carried forward.

---

## v1.10.5

### Changes (superseded by v1.10.8)
- **Added manual WebSocket `ping`/`pong` handler** — Redundant. The `ws` library v8.x already auto-responds to protocol-level pings. The handler was later changed to debug-only logging.
- **Changed KeepAlive from 30s to 120s** — Wrong. Too slow, reverted in v1.10.7.

### What we learned
- The `ws` library v8.x automatically responds to WebSocket protocol-level `ping` frames — no manual handler needed.
- The 30-minute disconnects are network-level drops between the client and server, not server-side timeouts.

---

## v1.10.4

### Bug Fixes
- **Fixed auto-advance at end of playlist** — Removed `!isMpvPaused` check from progress poll so the next episode triggers even when MPV is paused at end of file (with `--keep-open=yes`)
- **Fixed NextUp episode insertion** — Cross-season and NextUp episode additions now use `set_property playlist-pos` instead of `playlist-next` to reliably jump to the appended item
- **Fixed stale documentation** — Removed dead `isManualSkip` references from CONTRIBUTING.md

---

## v1.10.3

### Bug Fixes
- **Fixed auto-close killing process** — Auto-close now sends `quit` to MPV instead of calling `shutdown()`, so the shim stays running
- **Fixed shutdown double-call** — Added re-entrancy guard and `doExit` guard to prevent shutdown sequence from running twice
- **Fixed shutdown timeout** — Stop report now has a 3-second timeout so shutdown doesn't hang when Jellyfin is unreachable
- **Fixed unwatched-quit marking as watched** — OSC unwatched-quit now correctly skips the watched threshold check
- **Fixed shell injection on Linux** — Crash dialog now uses `execFile` instead of `exec` to prevent shell injection via error messages
- **Fixed test connection timeout** — Preferences test connection now times out in 10 seconds instead of 60

### New Features
- **Shim stays running after MPV closes** — Shim only exits on SIGINT/SIGTERM or crashes; all other scenarios (OSC close, auto-close, unwatched-quit) just close MPV
- **Crash dialog on Windows/Linux** — Shows a dialog with error details on crash (PowerShell MessageBox on Windows, zenity on Linux), falls back to opening crash log in text editor
- **Crash log file** — Writes error details to `data/crash.log` on uncaught errors for all platforms
- **Crash alert on macOS** — Shows NSAlert with exit code and log file path when shim crashes

---

## v1.10.2

### Bug Fixes
- **Fixed reconnection loop** — WebSocket reconnection now survives failed connection attempts (was permanently dead after one failure)
- **Fixed OSD pause leak** — `showSkipOsd`/`showErrorOsd` now restore pause state when clearing a DisplayMessage timeout (video stayed paused forever)
- **Fixed watched marking on manual advance** — Episodes are now marked as watched when manually advancing past queue end into next season/NextUp (only if >=90% watched)
- **Fixed stderr noise** — Removed `STDERR:` prefix from error notification condition (stderr lines are already logged, no need to notify)
- **Fixed skip intro options validation** — `autoSkipIntros` and `disableSkipIntro` are now mutually exclusive at both UI and config layers
- **Fixed Preferences UI** — Added IPC Socket Path and MPV Flags fields; shows default values when not set

---

## v1.10.1

### Bug Fixes
- **Fixed OSC close button** — `shim-close` is now handled as a direct script-message (was only handled as an action)
- **Fixed OSC close behavior** — Now sends `quit` to MPV instead of killing the entire process (shim stays running)
- **Fixed playlist title flash** — Skip `playlist-pos` handler during new queue loads to prevent wrong title flash
- **Fixed OSC state not pushed on load** — `pushOscState()` now called in `file-loaded` handler so subtitle styling options appear immediately
- **Fixed subtitle styling state** — Queries MPV's actual `sub-scale`/`sub-pos`/`sub-color` instead of hardcoding defaults
- **Fixed subtitle/audio track selection** — Queries MPV's `sid`/`aid` to show correct selected tracks in OSC
- **Fixed segment state leak** — `skippedSegmentIds` and `isInIntroSegment` now reset on new file load

### New Features
- **jf-mpv-osc Tier 1-3 integration** — Track naming, skip button, favorites, screenshot, fullscreen, unwatched quit
- **Subtitle styling controls** — `sub_style` state pushed to OSC with size/position/color options
- **OSC action logging** — All OSC actions now logged for debugging

### Internal
- **Updated AGENTS.md** — Added OSC integration details, removed dead variables
- **Updated README.md** — Added jf-mpv-osc tier support table, thumbfast-jellyfin reference

---

## v1.10.0

### New Features
- **Full season queue** — Playing a single episode now loads all episodes from that season into the playlist, allowing back-and-forth navigation
- **NextUp for specials** — When Jellyfin sends specials (season 0) from the show page, the shim uses the NextUp API to find the next unwatched episode from the regular season
- **Playlist navigation observer** — Added `playlist-pos` property observer to detect all MPV navigation (auto-advance, native keys, keybinds) reliably

### Bug Fixes
- **Fixed episode name on queue skip** — Episode title now updates correctly when navigating via Jellyfin commands or keybinds
- **Fixed log window scrolling** — Log window no longer flickers when logs are rapidly written (batched text storage edits)
- **Fixed duplicate keyboard shortcut** — "Copy Log to Clipboard" now uses Shift+Cmd+C to avoid conflicting with "Copy Now Playing"
- **Fixed config options dropped on save** — Preferences now preserves `ipcSocketPath` and `mpvFlags` when saving
- **Fixed Linux service file path** — `--install-service` now checks both `linux/` subdir and bundle root for the service file
- **Fixed reportPlaybackStart IsPaused** — Now reports actual pause state instead of hardcoded `false`
- **Fixed isSeeking race condition** — Seek flag now uses timeout instead of synchronous clear
- **Fixed getIntroSegments error handling** — Added missing `.catch()` in playlist-pos handler
- **Fixed extractTitleFromEpisode empty string** — Now returns `nil` for empty titles instead of setting `nowPlaying` to empty string
- **Fixed toggleOpenAtLogin state** — Menu item state now reverts on error
- **Fixed socket path buffer overflow** — Truncates path to fit `sun_path` with null terminator
- **Fixed setup wizard config overwrite** — Now preserves existing config options (ipcSocketPath, mpvFlags, fullscreen, etc.)
- **Fixed ForceKeepAlive response** — Immediately responds to server's ForceKeepAlive message to prevent disconnection
- **Fixed MPV exit behavior** — MPV now stays open at end of playlist when `autoClose` is false

### Internal
- **Simplified file-loaded handler** — Removed redundant navigation detection logic (now handled by playlist-pos observer)
- **Added syntax check test** — `node --check shim.js` catches syntax errors before they reach production
- **Added quality tests** — 6 new tests for duplicate shortcuts, command coverage, hardcoded secrets, version consistency, and SupportedCommands enum names
- **Removed dead code** — Cleaned up `isManualSkip` and `previousItemId` variables
- **Updated documentation** — Fixed stale line counts, test suite claims, and Node.js version requirements
- **Removed dead test files** — Deleted `.js` duplicates of `.mjs` test files
- **Keep-alive logging** — Added debug logging for keep-alive messages to help diagnose disconnects
- **Dependency update** — Bumped axios from 1.19.0 to 1.20.0

---

## v1.9.2

### Bug Fixes
- **Fixed ConfigParser URL parsing** — Comment stripping no longer corrupts URLs containing `//` (e.g., `https://...`)
- **Fixed Preferences auto-focus** — Server URL field no longer auto-highlights when opening Preferences
- **Fixed Preferences layout** — Improved spacing, error label truncation, separator widths
- **Fixed Info.plist version** — Updated from 1.8.3 to 1.9.1 to match package.json
- **Fixed queue load counter** — Multi-item queues now auto-advance correctly
- **Fixed Windows headless detection** — `findstr` now uses regex matching for config parsing
- **Fixed Linux exit code capture** — Shim exit code is now properly reported
- **Fixed MPV stderr false alarms** — MPV informational output no longer triggers error notifications

### Internal
- **Pre-push hook** — Blocks direct pushes to main branch
- **Test coverage** — Added `disableSkipIntro` to config test assertions
- **Documentation** — Updated AGENTS.md with branch-before-commit workflow

---

## v1.9.1

### New Features
- **Disable skip intro option** — New config option `disableSkipIntro: true` completely disables the intro/outro skip feature (hides prompts, does not bind S key, does not fetch segments)

### Bug Fixes
- **Fixed audio loss on resume** — Added 500ms delay before seeking to saved position to allow MPV to initialize audio decoder
- **Fixed seek delay race condition** — Capture seek position in local variable before setTimeout to prevent stale reads
- **Fixed error propagation** — `playMedia()` now re-throws errors so callers' catch blocks execute properly
- **Fixed intro state reset** — Reset intro segments and flags when `disableSkipIntro` is enabled
- **Fixed error pattern matching** — Added STDERR: prefix check and emoji patterns for Swift error detection
- **Fixed bare mpvPath search** — Bare command names like `mpv` now correctly search PATH instead of treating as literal filename

### Internal
- **Code audit** — Fixed 5 additional bugs found in comprehensive audit (seek race, state reset, error propagation)
- **Documentation** — Updated AGENTS.md with new config option

---

## v1.9.0

### New Features
- **Auto-skip intros/outros** — Uses Jellyfin's MediaSegments API to detect intro/outro segments. Config option `autoSkipIntros: true` auto-skips after 3s; when false, shows "Press S to skip" OSD. Supports the S key and SkipIntro GeneralCommand from Jellyfin web UI.
- **Next-up notification** — Shows "Next up: SeriesName - SxEp - EpisodeName" at bottom-right 10 seconds before episode ends
- **Error OSD messages** — Connection/auth errors shown in MPV OSD with 30s rate limiting (top-right)
- **Better logging** — Structured `[timestamp] [component]` format with `verbose: true` config option for debug output
- **ForceKeepAlive handling** — Server can now specify required keep-alive interval via WebSocket

### Bug Fixes
- **Fixed session keep-alive** — Progress reports now sent every 10s to server, preventing 5-minute idle timeout disconnect
- **Fixed intro skip repeating** — Clear all segments after skipping to prevent re-triggering when keyframe lands inside segment
- **Fixed IPC socket connection** — Wait for socket file to exist before connecting, reducing noisy ENOENT errors
- **Fixed token file permissions** — Use chmodSync to fix permissions on existing token files
- **Fixed queue desync** — Sync queue position when using MPV native playlist navigation
- **Fixed OSD corruption** — Save/restore OSD settings when showing skip/error messages
- **Fixed status bar icon** — Use SymbolConfiguration for colored icons, fix log pattern matching with emojis
- **Fixed headless mode** — Write to both stdout and log file so macOS app receives status updates
- **Fixed file picker** — Remove empty allowedContentTypes that prevented browsing for MPV binary

### Internal
- **Automated tests** — Added test suite using Node.js built-in test module (`npm test`)
- **Structured logging** — All logs use `[component]` prefix (ws, mpv, queue, episode, auth, ipc, main, handler, report, position, segments)
- **macOS app parsing** — Updated NodeProcessManager to match new log format
- **Code audit** — Fixed 24+ bugs across shim.js, Swift files, and launch scripts
- **Documentation** — Updated AGENTS.md line numbers, config table, state variables, and log contracts

---

## v1.8.3

### New Features
- **Windows headless mode** — `launch.bat` now supports `--headless` flag and auto-detection from config.js (matches Linux behavior)

### Internal
- **Expanded troubleshooting** — 12 new entries in README covering common failure modes (MODULE_NOT_FOUND, ENOENT, ECONNREFUSED, 401, IPC failures)
- **macOS app architecture docs** — CONTRIBUTING.md now documents all 11 Swift source files, spawn flow, and processLogLine
- **.editorconfig** — Consistent formatting across contributors (4-space JS/Swift, 2-space YAML, CRLF for .bat)
- **AGENTS.md cleanup** — Removed stale audit section, fixed Info.plist description

---

## v1.8.2

### Bug Fixes
- **Fixed CI release workflow** — `sync-output/` directory now created before writing files; release notes, Info.plist, and SECURITY.md sync correctly
- **Fixed CI release deletion** — workflow no longer deletes existing releases before recreating; assets are no longer permanently lost on re-runs
- **Fixed Info.plist version** — was stuck at 1.7.6; now matches package.json version
- **Fixed SECURITY.md version table** — now shows 1.8.x as supported, 1.7.x as no longer supported
- **Fixed pendingStartSeconds not reset** — stale seek position no longer persists when playing from beginning via loadNewQueue
- **Fixed .desktop Exec line** — now searches common bundle locations (`~/JellyfinMPVPlay-Linux-*`, `/opt/jellyfin-mpv-play`) when copied separately
- **Fixed AGENTS.md** — release workflow description now correctly says CHANGELOG.md (not PRs)
- **Fixed CONTRIBUTING.md** — line count updated from ~1250 to ~1620

---

## v1.8.1

### Bug Fixes
- **Fixed Linux headless mode** — `.desktop` file no longer opens a terminal window; `launch.sh` auto-detects headless config and either runs silently or opens a terminal as needed
- **Fixed release notes format** — CI now uses CHANGELOG.md directly instead of auto-generating from PRs

---

## v1.8.0

### New Features
- **Full queue system** — Native MPV playlist; Play Next / Play Last from Jellyfin UI; next/prev navigation through queued items
- **Cross-season auto-play** — Automatically queries Jellyfin's NextUp API when a season ends, seamlessly continuing to the next season
- **Display messages** — Jellyfin notifications appear as OSD overlays in MPV with pause support; "Message from Jellyfin Server" title identifies the source
- **Subtitle sync** — Subtitle changes in MPV (via `j` key or menu) are reported back to Jellyfin's session tracking
- **Fullscreen mode** — `fullscreen: true` in config.js starts MPV in fullscreen
- **Auto-close** — `autoClose: true` in config.js shuts down the app when playback queue is exhausted
- **Custom MPV flags** — `mpvFlags: ['--hwdec=auto', ...]` in config.js passes extra arguments to MPV
- **Headless mode** — `headless: true` in config.js suppresses console output, logs to `data/shim.log`; no terminal window required
- **Linux systemd service** — `./launch.sh --install-service` installs a user service for background operation with auto-restart; `--uninstall-service` to remove
- **PlayNow reuses MPV** — New play commands reuse the existing MPV instance via `playlist-clear` instead of killing and restarting; faster transitions, no window flicker
- **Diagnostic logging** — Queue position and item ID logged on every episode transition for easier debugging

### Bug Fixes
- **Fixed episode selection** — Plays exactly the episode clicked in Jellyfin, not the first unwatched; removed the NextUp/first-unwatched search
- **Fixed DisplayMessage OSD** — Uses `osd-align-y: center` instead of invalid `middle`; OSD positioned center-screen
- **Fixed progress report 400 errors** — Removed invalid `SubtitleStreamIndex` from progress reports; start reports still include the correct value
- **Fixed stop reports not sent** — Removed `isReportingStop` flag from `killMpv()`; added stop report in `playMedia()` before killing
- **Fixed `playPreviousEpisode` desync** — Uses `insert-at-index` + `playlist-prev` instead of `replace` to keep queue and MPV playlist in sync
- **Fixed PlayNext/PlayLast position** — Uses `insert-at-index` instead of `append` so items land at the correct position in MPV's playlist
- **Fixed `isPlayingNext` stuck** — 10-second timeout fallback in poll timer; IPC liveness checks before sending commands
- **Fixed DisplayMessage concurrent messages** — Original OSD properties captured once and reused; previous timeout cancelled before setting new one
- **Fixed `loadNewQueue` false auto-advance** — Sets `isNewQueueLoad` flag to prevent `file-loaded` handler from treating it as auto-advance
- **Fixed subtitle flag stuck** — 5-second timeout on `isSettingSubtitleFromJellyfin` flag; reset on MPV close
- **Fixed `queryProperty` hang** — 5-second timeout on all property queries; timers properly cleared on resolution
- **Fixed timer leak** — All `pendingQueries` bulk-clear paths now clear individual timers before resolving
- **Fixed stale position saves** — Skip functions update `currentItemId` and `queuePosition` immediately before sending MPV commands
- **Fixed `handleMessage` crash** — Added `.catch()` to async handler; unhandled rejections no longer kill the process
- **Fixed `.desktop` Exec lines** — Fixed broken `$0` reference in `bash -c` using `%k` (desktop file path)
- **Fixed headless terminal survival** — Uses `nohup` and `disown` so the process survives terminal closure
- **Fixed NextUp tight retry loop** — `isPlayingNext` no longer reset on NextUp failure; 10-second timeout handles recovery

---

## v1.7.6

### Bug Fixes
- Fixed playback stop not reported to Jellyfin when Stop command comes from web UI
- Fixed playback stop not reported when MPV IPC connection fails

---

## v1.7.5

> **Important:** This release fixes a critical bug where **playback controls did not appear in the Jellyfin web UI**. This bug was introduced in v1.7.0 during API format changes — the playback reports were incorrectly wrapped in a `playbackStartInfo`/`playbackProgressInfo` key, causing the server to reject session registration. If controls stopped working after updating from v1.6.0 or earlier, this update fixes that.

### Bug Fixes
- **Fixed playback controls not appearing in Jellyfin web UI** — removed incorrect `playbackStartInfo`/`playbackProgressInfo` wrapper from API requests; added valid `PlaybackOrder: 'Default'` enum value
- Fixed duplicate progress reporting causing 400 errors from Jellyfin server
- Fixed help window content clipped by hardcoded container height
- Fixed help window opening scrolled to bottom
- Fixed preferences window label/field alignment
- Fixed About window link buttons showing focus ring
- Fixed About window icon not adapting to dark mode

### Improvements
- About window now uses dark/light icon variant based on system appearance
- Help window link buttons no longer show focus ring
- Logs saved to ~/Library/Application Support/JellyfinMpvPlay/data/ with timestamps
- Icon SVGs bundled in app resources

---

## v1.7.4

### Bug Fixes
- Fixed emoji encoding corruption in log output (was garbled after v1.7.3 encoding change)

---

## v1.7.3

### Bug Fixes
- Fixed shutdown exiting before HTTP stop report completes (now waits for response)
- Fixed WebSocket URL construction (regex prevents hostname corruption)
- Fixed startProgressReporting not reporting progress to server (was only saving locally)
- Fixed StatusBarController icon colors not rendering (isTemplate was blocking tint)
- Fixed login item menu state not refreshing from external changes
- Fixed LogWindowController lineCount drift (uses actual count instead of tracking variable)
- Fixed NodeProcessManager stop() re-entry scheduling multiple SIGKILL timers
- Fixed stdout/stderr encoding dropping partial byte sequences (UTF-8 → ISO Latin 1)
- Fixed launch.sh not forwarding signals to child process
- Fixed launch.bat path separator issues (strips trailing backslash)

### Improvements
- Extracted shared ConfigParser.testConnection() (eliminated ~80 lines of duplication)
- Extracted StatusBarController.showAndActivate() helper
- Extracted NodeProcessManager.resetPlaybackState() method
- build.sh now verifies SHA256 checksum for Node.js download

---

## v1.7.2

### Bug Fixes
- Fixed random `deviceId` not persisted to disk — was creating zombie sessions in Jellyfin on every restart
- Fixed `pendingQueries` not resolved when MPV closes — could hang the poll timer forever
- Fixed stderr handler in NodeProcessManager not buffering partial lines — corrupted log parsing
- Fixed `.desktop` file Exec line — `dirname "$0"` returned `.` instead of script directory

---

## v1.7.1

### Features
- CI auto-generates release notes from merged PR titles (categorized by feat/fix/docs/ci)
- `package.json` is now the single source of truth for version; `shim.js` reads it at runtime

### Documentation
- Fixed duplicate step numbering in macOS Quick Start
- Added v1.7.1 to recent releases
- Fixed CODE_OF_CONDUCT.md using security advisory for CoC reports
- Added `*.tar.gz` to .gitignore
- Updated Info.plist version to match package.json

---

## v1.7.0 — Security, Stability, Bug Fixes

### Downloads
| Platform | File |
|----------|------|
| macOS | `JellyfinMPVPlay-macOS-v1.7.0.zip` |
| Linux | `JellyfinMPVPlay-Linux-v1.7.0.tar.gz` |
| Windows | `JellyfinMPVPlay-Windows-v1.7.0.zip` |

### Security
- **API key redaction** — stream URL no longer logged with `api_key` parameter
- **Token file permissions** — auth token file created with 0o600 (owner-only read/write)
- **Crash handlers** — added `uncaughtException`/`unhandledRejection` handlers for graceful shutdown

### Bug Fixes
- **ConfigParser regex rewritten** — escaped quotes in config values (e.g. `it\'s`) no longer truncate or corrupt the parsed value
- **Audio/subtitle stream commands** — now sent after MPV IPC connects, not before (were silently failing)
- **Backward episode navigation** — no longer marks current episode as watched when going to previous episode
- **StatusBarController** — added NSObject inheritance (menu item actions were broken at runtime)
- **StatusBarController togglePause** — fixed double-toggle causing pause state desync with MPV
- **SF Symbol compatibility** — replaced `menubar.arrow.up.rectangle` (requires macOS 14) with `menubar.rectangle` (macOS 11+)
- **Setup wizard** — closing window without completing no longer starts shim with invalid config
- **Setup wizard** — device name/ID and mpvPath values preserved when navigating back
- **Setup wizard** — default mpvPath now detects Apple Silicon vs Intel architecture
- **NodeProcessManager title extraction** — handles quoted titles with spaces correctly
- **NodeProcessManager togglePause** — sends predicted next state, not stale local state
- **NodeProcessManager findNodePath** — returns empty string on failure instead of bare "node"
- **NodeProcessManager sendMpvCommand** — logs IPC connect/send failures instead of silently returning
- **NotificationManager** — logs when notification permission is denied
- **launch.sh** — error handling code now actually runs (was blocked by `set -e`)
- **launch.sh** — follows symlinks to resolve script directory
- **launch.bat** — paths with special characters handled correctly
- **clientVersion** — synced with package.json version (was hardcoded `2.0.0`)
- **reportPlaybackProgress** — errors now logged instead of silently swallowed
- **scheduleReconnect** — changed from `setInterval` to `setTimeout` to prevent double-fire

### Improvements
- **Shared config escaping** — `ConfigParser.escapeConfigValue()` replaces duplicate `escape()` functions
- **Redundant dispatch removed** — `nowPlayingHandler` no longer double-dispatches to main queue
- **Stale version fallback removed** — About window shows "unknown" instead of hardcoded "1.3.1"
- **Application termination** — `applicationWillTerminate` waits for cleanup before exiting

---

## v1.6.0 — Cross-Platform Bundles, CI Build Workflow

### Downloads
| Platform | File |
|----------|------|
| macOS | `JellyfinMPVPlay-macOS-v1.6.0.zip` |
| Linux | `JellyfinMPVPlay-Linux-v1.6.0.tar.gz` |
| Windows | `JellyfinMPVPlay-Windows-v1.6.0.zip` |

### New Features
- **Linux bundle** — self-contained `.tar.gz` with bundled Node.js 22 LTS; just install MPV and run `./launch.sh`
- **Windows bundle** — self-contained `.zip` with bundled Node.js 22 LTS; just install MPV and run `launch.bat`
- **Linux desktop integration** — `.desktop` file included for app launcher support
- **CI/CD workflow** — GitHub Actions automatically builds and releases all 3 platform bundles on version tags
- **First-run config creation** — launchers auto-copy `config.example.js` to `config.js` on first run

### Improvements
- Updated `config.example.js` with platform-specific `mpvPath` examples
- Updated `macapp/build.sh` to skip `/Applications` deploy in CI environments
- Added `.gitattributes` for consistent line endings (CRLF for `.bat`, LF for `.sh`)

---

## v1.5.0 — Apple HIG Compliance, Bug Fixes, New Features

### New Features
- **Playback control from Jellyfin** — full `GeneralCommand` handler for volume, mute, audio/subtitle tracks, repeat mode, shuffle, fullscreen
- **Playstate commands** — PlayPause, NextTrack, PreviousTrack, Rewind (−10s), FastForward (+10s)
- **Series page play** — queries Jellyfin's NextUp API to find the correct episode
- **Copy Now Playing** — copies current title to clipboard
- **Open at Login** — toggle directly from menu bar dropdown
- **Open Config File** — opens `config.js` in default editor
- **Open App Folder** — opens Application Support directory in Finder

### Auto-Play Overhaul
- Fixed auto-play next episode — now uses IPC poll timer (queries mpv every 1s) instead of unreliable `eof-reached` events
- Episode transitions reuse the running MPV process via `loadfile` IPC command (no more window flash)
- Double-trigger prevention with `isPlayingNext` flag and 10s timeout
- Duplicate watched marking prevented with `markedWatched` Set

### Bug Fixes
- Fixed poll timer hanging forever when IPC disconnects (pending promises now resolved)
- Fixed `connectToMpvIpc` retries racing with new playback (generation check added)
- Fixed `reportPlaybackStop` failure leaving `isReportingStop` stuck true
- Fixed `loadNextEpisode` not clearing progress interval (stale position saves)
- Fixed `shutdown()` not reporting playback stop to server
- Fixed stale `currentDuration` from previous episode after IPC query failure
- Fixed `isPlayingNext` never resetting if `loadfile` send silently fails (10s timeout)
- Preferences save now triggers node restart (was silently ignored)
- Setup "Skip" no longer writes empty config (was causing infinite setup loop)
- Stop playback state protected from stale log line callbacks
- Shake animation now works (added `field.wantsLayer = true`)
- IPC socket cleanup on shutdown and MPV exit
- Pending IPC queries resolved on cleanup (prevents poll timer hang)

### Apple HIG Compliance
- All windows now respect standard macOS window layering (removed `.floating`)
- Status bar icons use template images and adapt to light/dark menu bar
- Replaced deprecated `NSApp.activate(ignoringOtherApps:)` with version-checked API
- Log viewer respects system appearance instead of forcing dark theme
- Added `LSApplicationCategoryType` to Info.plist

### Code Quality
- Extracted shared `ConfigParser` utility (eliminates duplication across 3 files)
- Thread safety: `processLogLine` dispatched to main thread
- `shim.js`: Progress reports now include `RepeatMode`, `PlaybackOrder`, `MediaSourceId`
- `shim.js`: Shutdown sends `SessionsStop` message before closing WebSocket

---

## v1.4.0 — Bug Fixes, Logo, UI Overhaul

### New Features
- **Custom app icon** — replaces generic SF Symbol with purpose-built `AppIcon.icns`
- **Dark mode icon variant** — About window dynamically switches based on system appearance
- **SVG logo set** — `logo.svg`, `icon.svg`, `icon-light.svg`, `icon-dark.svg`, `logo-banner.svg`
- **Pause state reporting** — subscribes to MPV's `pause` property, accurate `IsPaused` in progress reports
- **Help window overhaul** — keyboard shortcuts with ⌘ equivalents, SF Symbols per section, resizable

### Bug Fixes
- Fixed shake animation (was using `frame.origin` instead of `layer.position`)
- Fixed version in auth header (was hardcoded `1.3.0`)
- Fixed memory leak in `AppDelegate.statusHandler` closure
- Fixed `isReportingStop` flag not resetting on fresh play
- Removed dead `getSavedPosition()` function
- Fixed log window text view sizing

### UI Improvements
- All windows float above other apps
- About window: taller, Jellyfin link, theme-aware icon
- Menu key equivalents for all items

---

## v1.3.0 — Setup Wizard, Help Window, Bundled Node.js

### New Features
- **First-run setup wizard** — 5-step guided setup with "Test Connection" button
- **Help window** — Getting Started, Controls, Keyboard Shortcuts, Smart Resume, Troubleshooting
- **Bundled Node.js 22 LTS** — fully self-contained app (~175MB), no system Node required

### Improvements
- About window redesigned with fork attribution and clickable links
- Preferences auto-fills default values for empty fields
- `findNodePath()` checks bundle first, falls back to system Node
- README rewritten with separate macOS/Windows/Linux sections

---

## v1.2.1 — Native macOS App, Play-from-Beginning Fix, 8 Bug Fixes

### New: Native macOS Menu Bar App
- Status bar icon with color-coded states (disconnected/connected/playing)
- Now Playing display, Pause/Resume and Stop controls
- Log viewer with syntax coloring, auto-scroll, export
- Preferences window with "Test Connection" button
- Launch at Login toggle, macOS notifications
- Automatic process management with exponential backoff restart
- Build script compiles Swift, bundles into `.app` for `/Applications`

### Fixed: Play-from-Beginning Bug
- Server's `StartPositionTicks: 0` now correctly starts from beginning
- Previously, saved local position could override "play from beginning" request

### Bug Fixes
1. Removed duplicate `connectToMpvIpc()` function
2. Race condition fix with `playbackGeneration` counter
3. Graceful shutdown now saves position and reports stop
4. `eof-reached` handler now reports stop to server
5. Episode list sort no longer mutates API response
6. Fixed `currentIndex` bounds check
7. Platform-aware IPC socket path (Unix/Windows)
8. Fixed MPV keybind names (`NEXT`/`PREV`)

### Improvements
- Log messages translated from Spanish to English (enables macOS app parsing)
- Simplified MPV arguments (delegated to user's `mpv.conf`)
- Added `--force-media-title` for descriptive window titles
- Better token validation and error handling
