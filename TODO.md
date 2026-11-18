# TODO

Features, bugs, and improvements planned for Jellyfin MPV Play.

---

## Completed

| Feature | Version | Details |
|---------|---------|---------|
| Fullscreen mode | v1.8.0 | Config option: `fullscreen: true` |
| Queue system | v1.8.0 | Native MPV playlist, PlayNext/PlayLast, cross-season via NextUp |
| Auto-close | v1.8.0 | Config option: `autoClose: true` |
| Headless mode | v1.8.0 | Linux systemd service, Windows `--headless` flag |
| Custom MPV flags | v1.8.0 | Config option: `mpvFlags: [...]` |
| DisplayMessage OSD | v1.8.0 | Center-screen overlay, 10s pause, concurrent message handling |
| Subtitle sync | v1.8.0 | Bidirectional sync between MPV and Jellyfin server |
| Windows support | v1.8.3 | `launch.bat` with headless support |
| CI version sync | v1.8.3 | Info.plist auto-synced from package.json in CI |
| Seek progress reports | v1.9.0 | Report progress immediately on user-initiated seeks |
| Auto-skip intros/outros | v1.9.0 | MediaSegments API, auto-skip or S key, config option `autoSkipIntros` |
| Error OSD messages | v1.9.0 | Connection/auth errors shown in MPV OSD with rate limiting |
| Better logging | v1.9.0 | Log levels, timestamps, component names, `verbose` config option |
| Next-up notification | v1.9.0 | Show next episode title 10s before current episode ends |
| Full season queue | v1.10.0 | Playing a single episode loads all episodes from that season |
| NextUp for specials | v1.10.0 | Uses NextUp API when Jellyfin sends season 0 |
| Playlist navigation observer | v1.10.0 | `playlist-pos` property observer for reliable MPV navigation detection |
| jf-mpv-osc integration | v1.10.0 | Tier 0-3: track naming, skip button, queue navigation, favorites |
| Crash reporting | v1.10.3 | Crash dialog (macOS NSAlert, Windows PowerShell, Linux zenity), crash.log |
| Graceful shutdown | v1.10.3 | Shim stays running after MPV closes; only exits on SIGINT/SIGTERM |
| EOF detection | v1.10.10 | `eof-reached` observer for reliable end-of-file detection |
| SyncPlay support | v1.11.0 | Full SyncPlay: commands, group updates, waiting/ready states, UTC time sync |
| SetShuffleQueue | v1.11.0 | Server can shuffle the queue |
| SetSubtitleDelay | v1.11.0 | Server can adjust subtitle timing |
| SetAudioDelay | v1.11.0 | Server can adjust audio timing |
| Multi-config support | v1.11.2 | `node shim.js config.work.js`, config file selector in macOS Preferences |
| Secrets redaction | v1.11.1 | API keys/tokens masked in log output |
| XDG_RUNTIME_DIR | v1.11.1 | IPC socket defaults to `$XDG_RUNTIME_DIR` on Linux |
| Stale IPC socket cleanup | v1.11.1 | Cleans up stale sockets before spawning mpv |
| `--cache=yes` | v1.11.1 | Better buffering for network streams |
| Queue semantics overhaul | v1.12.0 | playlist-clear fix, track-index mapping, shuffle preservation, series-start-on-special fix, watched-mark timing |
| Apple HIG compliance (macOS) | v1.12.0 | Main menu, Settings naming, dialog button order, setup wizard escapes |
| Movies/music Now Playing | v1.12.0 | Title and controls now populate for non-episode items |
| Config save safety (macOS) | v1.12.0 | Settings panel merges instead of overwriting; preserves comments and unrecognized keys |
| Live E2E test suite | v1.12.0 | 25 automated tests against real Jellyfin + real mpv (`npm run test:e2e`) |
| Orphaned mpv reaper | v1.12.3 | Quits leftover mpv processes on startup from crashed runs |
| Presence WebSocket | v1.13.0 | Second WS connection keeps web UI cast alive across single-socket drops |
| Dead-connection watchdog | v1.13.0 | Protocol pings every 15s, force-close after 35s of silence |
| Fast reconnect | v1.13.0 | 1s server-probe loop, reconnects the moment the server answers |
| Named playlist entries | v1.14.0 | M3U-based loading so OSC shows titles, not raw stream URLs |
| External stream loading | v1.14.0 | Sidecar subtitle/audio streams added per file with Jellyfin display names |
| Explicit track-index mapping | v1.14.0 | Jellyfin Index ↔ mpv aid/sid via `track-list` ff-index (fixes wrong-track selection) |
| Report ordering fix | v1.14.0 | Playback reports serialized so stop/progress/start reach server in order |
| Stale-async guards | v1.14.0 | Generation tokens prevent wrong-file mutations and race conditions |
| Stable API key for media URLs | v1.16.0 | `apiKey` config option survives token reauth mid-session |
| Revoked-token recovery | v1.16.0 | 401 triggers reauthenticate-and-retry instead of silent death |
| Completed-episode resume fix | v1.16.0 | Finished episodes end `Played=true` with no resume position anywhere |
| Scrobbler sync (playedToCompletion) | v1.16.1 | Completed items report `playedToCompletion=true` for jellyfin-ani-sync etc. |
| Bundled Node.js 24 LTS | v1.15.0 | 24.22.1 across all bundles; automated LTS tracking workflow |
| Bundled Node.js 26 LTS | v1.17.0 | 26.13.0 ("Lithium", supported to Apr 2029) |
| Linux self-contained bundle | v1.17.1 | Bundled `libatomic.so.1` (no system packages beyond MPV needed) |
| macOS minimum-version honesty | v1.17.2 | Declares real floor (13.5), probes bundled Node with `--version` fallback |
| Linux tray application | v1.18.0 | GTK3 + AyatanaAppIndicator3 system tray app (setup wizard, settings, logs, notifications) |
| OSD reset to mpv defaults | v1.18.0 | Font size/alignment restore to 30/left/top after DisplayMessage |
| AudioBook/Trailer playback | v1.18.0 | Both added to playable types |
| arm64 Linux bundle | v1.18.0 | Pre-built tray bundles for x86_64 and arm64 |
| arm64 libatomic bundling | v1.18.1 | arm64 tray bundle ships `libatomic.so.1` (was x86_64-only) |

---

## Not Our Bug

### JP subtitle freeze

**Source:** Upstream Issue #2 — [MPV unresponsive when video includes JP subtitles](https://github.com/JohnGlaus/jellyfin-mpv-play/issues/2) (closed)

MPV freezes when playing videos with Japanese subtitles. This is an MPV issue, not a shim issue. The shim doesn't touch subtitle rendering — it only passes the subtitle track to MPV via `sid`. Possible causes include CJK font rendering, ASS/SSA format handling, or missing fonts on the user's system. Not reproducible as a shim bug.

---

## Not Adding (Duplicate or Low Value)

| Feature | Reason |
|---------|--------|
| Queue persistence | Complexity outweighs value — queue is ephemeral, playback position is already saved |
| Sync position from server | Moderate effort, could be annoying — Jellyfin already sends resume position in play commands |
| MPV config detection | Low value — user's mpv.conf is their responsibility, shim already overrides key settings |
| Chapter markers | MPV handles this natively — chapters shown on seekbar, navigation via PgUp/PgDn |
| Audio language preference | Jellyfin handles this natively — user settings in Jellyfin control default audio/subtitle languages |
| Subtitle language preference | Jellyfin handles this natively — same as above |
| Resume confirmation | Jellyfin handles this natively — web UI shows "Resume from X?" dialog before sending play command |
| Quality selection | Requires transcode API integration — not supported |
| Shader profiles | Requires shader management — not supported |

---

## Ideas (Low Priority)

- **Multi-server support** — Connect to multiple Jellyfin servers simultaneously (partially addressed by multi-config support)
- **Trakt integration** — Scrobble to Trakt.tv
