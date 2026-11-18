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
