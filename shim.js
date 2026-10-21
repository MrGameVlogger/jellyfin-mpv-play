const { WebSocket } = require('ws');
const axios = require('axios');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');

// A child process must tolerate its output pipes being closed (parent exiting,
// macapp restarting the shim, pkill, ...). Writes to a dead stdout/stderr raise
// EPIPE — without these handlers every log line became an uncaughtException.
const isBrokenPipe = (err) => {
    if (!err) return false;
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return true;
    const msg = String(err.message || '');
    return msg.includes('EPIPE') || msg.includes('ERR_STREAM_DESTROYED');
};
process.stdout.on('error', (err) => { if (!isBrokenPipe(err)) console.error('stdout error:', err.message); });
process.stderr.on('error', () => { /* stderr is dead too — nothing to log to */ });

// Which config to load. Lets you run one instance per Jellyfin account:
//   node shim.js config.work.js
//   node shim.js config.work.js --allow-duplicates
//   JELLYFIN_MPV_CONFIG=config.work.js node shim.js
// Defaults to config.js for the single-account case.
const args = process.argv.slice(2);
const configFile = process.env.JELLYFIN_MPV_CONFIG || args.find(a => !a.startsWith('--')) || 'config.js';
const configPath = path.isAbsolute(configFile) ? configFile : path.join(__dirname, configFile);
if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.error('   Create one from the template, e.g.:  cp config.example.js config.js');
    process.exit(1);
}
const userConfig = require(configPath);
console.log(`🗂️  Using config: ${path.basename(configPath)}`);

const pkg = require('./package.json');

const CONFIG = {
    serverUrl: userConfig.serverUrl,
    username: userConfig.username,
    password: userConfig.password,
    mpvPath: userConfig.mpvPath,
    deviceName: userConfig.deviceName,
    deviceId: userConfig.deviceId || generateOrLoadDeviceId(),
    
    clientVersion: pkg.version,
    ipcSocketPath: userConfig.ipcSocketPath || (process.platform === 'win32' ? '\\\\.\\pipe\\mpv-ipc' : (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'mpv-ipc.sock') : '/tmp/mpv-ipc.sock')),
    mpvLoadDelayMs: 100,
    fullscreen: userConfig.fullscreen || false,
    autoClose: userConfig.autoClose || false,
    mpvFlags: userConfig.mpvFlags || [],
    headless: userConfig.headless || false,
    autoSkipIntros: userConfig.autoSkipIntros || false,
    disableSkipIntro: userConfig.disableSkipIntro || false,
    verbose: userConfig.verbose || false,
    wsPresenceSocket: userConfig.wsPresenceSocket !== false
};

if (CONFIG.autoSkipIntros && CONFIG.disableSkipIntro) {
    console.error('⚠️ autoSkipIntros and disableSkipIntro are mutually exclusive — disabling autoSkipIntros');
    CONFIG.autoSkipIntros = false;
}

// --headless on the command line (used by launch.sh / launch.bat to run detached)
// forces the same log-to-file behavior as headless: true in the config.
if (args.includes('--headless')) {
    CONFIG.headless = true;
}

if (CONFIG.headless) {
    const logDir = path.join(__dirname, 'data');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const configBase = path.basename(configFile, path.extname(configFile));
    const allowDuplicates = args.includes('--allow-duplicates');
    
    // Determine log file name
    let logFile;
    if (allowDuplicates) {
        // With --allow-duplicates, use PID to distinguish instances
        logFile = path.join(logDir, `shim-${configBase}-${process.pid}.log`);
    } else {
        // Single-instance mode: always the documented name. The stream is opened in
        // append mode, and real duplicate detection is the lock file in main().
        logFile = path.join(logDir, `shim-${configBase}.log`);
    }
    
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const timestamp = () => new Date().toISOString();
    const fmtArgs = (args) => args.map(a => (typeof a === 'object' && a !== null) ? JSON.stringify(a) : String(a)).join(' ');
    console.log = (...args) => {
        const msg = `[${timestamp()}] ${fmtArgs(args)}\n`;
        logStream.write(msg);
        process.stdout.write(msg);
    };
    console.error = (...args) => {
        const msg = `[${timestamp()}] ERROR: ${fmtArgs(args)}\n`;
        logStream.write(msg);
        process.stderr.write(msg);
    };
    console.log(`🔇 Headless mode — logging to ${logFile}`);
}

function ts() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(level, component, ...args) {
    if (level === 'debug' && !CONFIG.verbose) return;
    const prefix = `[${ts()}] [${component}]`;
    // Output pipes can fail synchronously once dead — logging must never throw
    // (an exception here used to cascade into a crash-dialog storm).
    try {
        if (level === 'error') {
            console.error(prefix, ...args);
        } else {
            console.log(prefix, ...args);
        }
    } catch (e) {
        if (!isBrokenPipe(e)) { /* nothing left to log to */ }
    }
}

// Hide secrets (ApiKey / token) before logging URLs or headers
function redact(value) {
    if (!value) return value;
    return String(value)
        .replace(/(api_key=)[^&\s]+/gi, '$1***')
        .replace(/(ApiKey=)[^&\s]+/gi, '$1***')
        .replace(/(Token=")[^"]+/gi, '$1***')
        .replace(/(X-Emby-Token[":=\s]+)[^",\s]+/gi, '$1***');
}

// Jellyfin stream indices (MediaStream.Index) and mpv track ids live in different
// numbering spaces. mpv's aid/sid take per-type track IDs (1-based ordinals within
// video/audio/sub in track-list order); Jellyfin's Index is the stream's position in
// the source's stream list — and when external (sidecar) streams exist, Jellyfin
// numbers those FIRST, so Index is not the container ff-index either (verified on a
// live library item: container V0/A1 while Jellyfin reports external subs at 0/1
// and V2/A3). These helpers translate between the two spaces via an explicit map
// built from Jellyfin's MediaStreams and mpv's track-list: embedded streams zip by
// order within type (both sides follow container order), external streams match by
// the exact URL they were added with (mpv's external-filename). The window before
// the file has finished loading falls back to the old ff-index/ordinal heuristics.
const MPV_TYPE_OF = { Audio: 'audio', Subtitle: 'sub', Video: 'video' };

let streamIndexMap = { toMpv: new Map(), toJf: new Map() };

function streamMapKey(type, id) {
    return `${type}:${id}`;
}

function buildStreamIndexMap(mediaStreams, mpvTracks, itemId = currentItemId) {
    const toMpv = new Map();
    const toJf = new Map();
    for (const type of ['Audio', 'Subtitle']) {
        const mpvType = MPV_TYPE_OF[type] || type;
        const jfSame = (mediaStreams || []).filter(s => s.Type === type);
        const mpvSame = (mpvTracks || []).filter(t => t.type === mpvType);
        const jfEmb = jfSame.filter(s => !s.IsExternal);
        const jfExt = jfSame.filter(s => s.IsExternal);
        const mpvEmb = mpvSame.filter(t => !t.external);
        const mpvExt = mpvSame.filter(t => t.external);
        // Embedded: both sides list tracks in container order — zip positionally.
        for (let i = 0; i < Math.min(jfEmb.length, mpvEmb.length); i++) {
            toMpv.set(streamMapKey(type, jfEmb[i].Index), mpvEmb[i].id);
            toJf.set(streamMapKey(type, mpvEmb[i].id), jfEmb[i].Index);
        }
        // External: match by the URL they were added with (exact identity), else
        // fall back to add order (we add them in MediaStreams order).
        const unmatched = [...mpvExt];
        for (const s of jfExt) {
            const url = externalStreamUrl(s, itemId);
            let t = url ? unmatched.find(x => x['external-filename'] === url) : undefined;
            if (t) unmatched.splice(unmatched.indexOf(t), 1);
            else t = unmatched.shift();
            if (t) {
                toMpv.set(streamMapKey(type, s.Index), t.id);
                toJf.set(streamMapKey(type, t.id), s.Index);
            }
        }
    }
    streamIndexMap = { toMpv, toJf };
}

function refreshStreamIndexMap(itemId) {
    const streams = (itemId && itemInfoCache.has(itemId))
        ? (itemInfoCache.get(itemId).mediaStreams || [])
        : (currentEpisodeInfo && currentEpisodeInfo.mediaStreams);
    buildStreamIndexMap(streams, mpvTrackList);
}

function jellyfinStreamIndexToMpvId(streamIndex, type) {
    if (typeof streamIndex !== 'number') return streamIndex;
    const mapped = streamIndexMap.toMpv.get(streamMapKey(type, streamIndex));
    if (mapped !== undefined) return mapped;
    const mpvType = MPV_TYPE_OF[type] || type;
    const byList = mpvTrackList.find(t => t.type === mpvType && t['ff-index'] === streamIndex);
    if (byList) return byList.id;
    const streams = currentEpisodeInfo && currentEpisodeInfo.mediaStreams;
    if (Array.isArray(streams)) {
        const sameType = streams.filter(s => s.Type === type);
        const ordinal = sameType.findIndex(s => s.Index === streamIndex);
        if (ordinal >= 0) return ordinal + 1;
    }
    log('warn', 'mpv', `⚠️ Cannot map Jellyfin stream index ${streamIndex} (${type}) to an mpv track — passing value through`);
    return streamIndex;
}

function mpvTrackIdToJellyfinIndex(mpvId, type) {
    if (typeof mpvId !== 'number') return undefined;
    const mapped = streamIndexMap.toJf.get(streamMapKey(type, mpvId));
    if (mapped !== undefined) return mapped;
    const mpvType = MPV_TYPE_OF[type] || type;
    const byList = mpvTrackList.find(t => t.type === mpvType && t.id === mpvId);
    if (byList && typeof byList['ff-index'] === 'number') return byList['ff-index'];
    const streams = currentEpisodeInfo && currentEpisodeInfo.mediaStreams;
    if (Array.isArray(streams)) {
        const sameType = streams.filter(s => s.Type === type);
        if (mpvId >= 1 && mpvId <= sameType.length) return sameType[mpvId - 1].Index;
    }
    return undefined;
}

// Extract the Jellyfin item id from an mpv playlist entry (stream URLs contain
// /Videos/<itemId>/stream). Returns null when the entry does not look like one.
function itemIdFromPlaylistEntry(entry) {
    const m = /\/Videos\/([a-f0-9]+)\//i.exec(String(entry || ''));
    return m ? m[1] : null;
}

// Rebuild playQueue from the mpv playlist so both lists agree on order after a
// shuffle/reorder that the shim did not initiate itself.
async function resyncQueueFromPlaylist() {
    const count = await queryProperty('playlist-count');
    if (typeof count !== 'number' || count <= 0) return;
    const ids = [];
    for (let i = 0; i < count; i++) {
        const id = itemIdFromPlaylistEntry(await queryProperty(`playlist/${i}/filename`));
        if (!id) return; // unknown entry — keep the existing queue
        ids.push(id);
    }
    playQueue = ids;
    pushOscState();
}

// ---------------------------------------------------------------------------
// Item info cache (titles + media streams for every queued item) and queue
// construction. Playlist entries are loaded through in-memory M3U playlists
// because that is the ONLY way mpv will show a name instead of the raw stream
// URL in its own OSC playlist view — a URL that also carries the ApiKey token.
// (Verified on mpv 0.41: playlist/N/title is read-only, and per-file
// force-media-title via loadfile's options argument only lands after the entry
// has been opened. #EXTINF titles via loadlist populate titles immediately and
// survive replace/insert-at/append alike — loadfile on an M3U URL does NOT
// preserve them for insert-at/append.)
const itemInfoCache = new Map(); // itemId -> { title, mediaStreams, mediaSourceId }

function queueItemUrl(id) {
    return `${CONFIG.serverUrl}/Videos/${id}/stream?static=true&ApiKey=${accessToken}`;
}

function buildItemTitle(item) {
    if (item.Type === 'Episode') {
        return [item.SeriesName, `${item.ParentIndexNumber}x${item.IndexNumber}`, item.Name]
            .filter(Boolean).join(' - ');
    }
    return item.Name || 'Movie/Music';
}

function cacheItemInfo(item) {
    if (!item || !item.Id) return;
    const prev = itemInfoCache.get(item.Id) || {};
    itemInfoCache.set(item.Id, {
        title: buildItemTitle(item),
        // Only trust MediaStreams/MediaSources when the caller actually fetched
        // them (season episode lists don't) — a cached empty array would block
        // the fetch that loads external streams.
        mediaStreams: item.MediaStreams !== undefined ? (item.MediaStreams || []) : prev.mediaStreams,
        mediaSourceId: (item.MediaSources && item.MediaSources[0] && item.MediaSources[0].Id) || prev.mediaSourceId || item.Id
    });
}

// One batch request fills titles + streams for a whole queue (Ids= is a
// comma-separated filter on /Users/{userId}/Items).
async function fetchItemInfoBatch(ids) {
    const missing = [...new Set(ids)].filter(id => {
        if (!id) return false;
        const cached = itemInfoCache.get(id);
        return !cached || !cached.mediaStreams; // title-only entries still need streams
    });
    if (!missing.length) return;
    try {
        const response = await axios.get(`${CONFIG.serverUrl}/Users/${userId}/Items`, {
            headers: getAuthHeaders(),
            params: {
                Ids: missing.join(','),
                Fields: 'MediaStreams,MediaSources,SeriesName,IndexNumber,ParentIndexNumber'
            }
        });
        for (const item of (response.data.Items || [])) cacheItemInfo(item);
    } catch (error) {
        log('warn', 'queue', `⚠️ Could not fetch item titles (${missing.length} items): ${error.message}`);
    }
}

function itemTitle(itemId) {
    return (itemInfoCache.get(itemId) || {}).title || String(itemId);
}

function buildQueueM3u(ids) {
    let m3u = '#EXTM3U';
    for (const id of ids) {
        // Title format matches force-media-title so the window/OSD title is
        // correct the instant an entry starts, with no network round trip.
        const title = `Jellyfin - ${itemTitle(id)}`.replace(/[\r\n]+/g, ' ');
        m3u += `\n#EXTINF:-1,${title}`;
        m3u += `\n${queueItemUrl(id)}`;
    }
    return `memory://${m3u}`;
}

// Delivery URL for an external (sidecar) stream — these are separate files the
// static container stream does not carry, so mpv only sees them if we add them
// ourselves (sub-add/audio-add). Format mirrors jellyfin-web's getSubtitleUrl:
// /Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}
const SUB_FORMAT_OF = { subrip: 'srt', srt: 'srt', ass: 'ass', ssa: 'ssa', webvtt: 'vtt', vtt: 'vtt', mov_text: 'srt' };

function externalStreamUrl(stream, itemId = currentItemId) {
    const info = itemInfoCache.get(itemId) || {};
    const mediaSourceId = info.mediaSourceId || itemId;
    if (!mediaSourceId) return null;
    const token = `ApiKey=${accessToken}`;
    if (stream.Type === 'Subtitle') {
        if (!stream.IsTextSubtitleStream) {
            // The conversion endpoint only outputs text formats (verified: srt/
            // ass/vtt 200, sup/pgs 400). Bitmap sidecars have no delivery path.
            log('info', 'mpv', `ℹ️ Skipping external bitmap subtitle ${stream.Index} (${stream.Codec}) — no text conversion available`);
            return null;
        }
        const format = SUB_FORMAT_OF[String(stream.Codec || '').toLowerCase()] || 'srt';
        return `${CONFIG.serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}/Stream.${format}?${token}`;
    }
    if (stream.Type === 'Audio') {
        // Audio is selected via the audioStreamIndex query parameter on the
        // /Audio/{itemId}/stream route (verified live — the path-segment form
        // /Videos/{id}/{ms}/Audio/{index}/stream does not exist).
        return `${CONFIG.serverUrl}/Audio/${itemId}/stream?audioStreamIndex=${stream.Index}&mediaSourceId=${mediaSourceId}&${token}`;
    }
    return null;
}

// Add external (sidecar) subtitle/audio streams to the file mpv just loaded.
// The static container stream does not carry them, so without this a movie with
// only external subs has NO subtitle tracks in mpv at all (the stock OSC menu
// comes straight from mpv's track-list). Tracks are added with their Jellyfin
// display name and language so the stock OSC shows "English (Full) (External)"
// rather than a bare URL. Selection is never forced here ("auto"): the Play
// request's track choice is applied afterwards by applyRequestedStreamSelection.
const externalStreamsAdded = new Set(); // per file load; cleared in handleMpvEvent
// Bumped on every file-loaded AND at every navigation. Async continuations
// started for an earlier file (item-info fetch before sub-add, the post-add map
// rebuild) must check it — without that, skipping during the fetch adds the OLD
// item's sidecar subs to the NEW file and rebuilds the index map from mismatched
// streams/tracks. Bumping at navigation matters because the replacement stream
// takes seconds to load: the stale callback can fire long before the next
// file-loaded (caught live: a skip during the post-add window applied the old
// item's requested subtitle to the new file).
let fileLoadGeneration = 0;

// In-flight continuations for the current file are obsolete the moment we start
// navigating away — call this from every path that sends a navigation command.
function invalidateFileGeneration() {
    fileLoadGeneration++;
}

async function loadExternalStreams(itemId, generation) {
    if (!ipcClient || ipcClient.destroyed) return;
    let info = itemInfoCache.get(itemId);
    if (!info || !info.mediaStreams) {
        await fetchItemInfoBatch([itemId]);
        info = itemInfoCache.get(itemId);
    }
    if (generation !== fileLoadGeneration) return; // superseded by a newer file
    const externals = (info && info.mediaStreams || [])
        .filter(s => s.IsExternal && (s.Type === 'Subtitle' || s.Type === 'Audio'));
    if (!externals.length) return;

    let added = 0;
    for (const s of externals) {
        const url = externalStreamUrl(s, itemId);
        if (!url || externalStreamsAdded.has(url)) continue;
        externalStreamsAdded.add(url);
        added++;
        const title = s.DisplayTitle || s.Title || s.Language || `Track ${s.Index}`;
        const lang = s.Language || 'und';
        if (s.Type === 'Subtitle') {
            sendMpvCommand('sub-add', [url, 'auto', title, lang]);
        } else {
            sendMpvCommand('audio-add', [url, 'auto', title, lang]);
        }
    }
    if (!added) return;
    log('info', 'mpv', `➕ Added ${added} external stream(s) to MPV`);

    // sub-add is async inside mpv — give it a moment, then rebuild the index
    // map so Jellyfin<->mpv track ids resolve for the new tracks too, and honor
    // the selection the server asked for (it may be one of these externals).
    setTimeout(async () => {
        if (!ipcClient || ipcClient.destroyed) return;
        if (generation !== fileLoadGeneration) return; // superseded by a newer file
        const tl = await queryProperty('track-list').catch(() => null);
        if (!Array.isArray(tl)) return;
        if (generation !== fileLoadGeneration) return; // superseded during the await
        mpvTrackList = tl;
        refreshStreamIndexMap(itemId);
        applyRequestedStreamSelection(itemId);
        pushOscState();
    }, 400);
}

// Re-apply the track selection the server requested, but only for the item the
// request was issued for — auto-advance to another file must not drag a stale
// request across, and mpv already keeps the user's choice between entries.
// Safe to call repeatedly: setting aid/sid to the value they already have is a
// no-op.
function applyRequestedStreamSelection(itemId = currentItemId) {
    if (requestedTrackItemId !== itemId) return;
    if (requestedAudioStreamIndex !== undefined) {
        const aid = requestedAudioStreamIndex === -1
            ? 'no'
            : jellyfinStreamIndexToMpvId(requestedAudioStreamIndex, 'Audio');
        sendMpvCommand('set_property', ['aid', aid]);
    }
    if (requestedSubtitleStreamIndex !== undefined) {
        isSettingSubtitleFromJellyfin = true;
        if (subtitleFlagTimeout) clearTimeout(subtitleFlagTimeout);
        subtitleFlagTimeout = setTimeout(() => { isSettingSubtitleFromJellyfin = false; subtitleFlagTimeout = null; }, 5000);
        const sid = requestedSubtitleStreamIndex === 'no' || requestedSubtitleStreamIndex === -1
            ? 'no'
            : jellyfinStreamIndexToMpvId(requestedSubtitleStreamIndex, 'Subtitle');
        sendMpvCommand('set_property', ['sid', sid]);
    }
}

const TOKEN_FILE = path.join(__dirname, 'data', `jellyfin_token_${CONFIG.deviceId}.json`);
const POSITIONS_FILE = path.join(__dirname, 'data', `playback_positions_${CONFIG.deviceId}.json`);

let mpvProcess = null;
let currentItemId = null;
let progressInterval = null;
let ipcClient = null;
let currentEpisodeInfo = null;
let ipcCommandId = 1;
let playSessionId = null;
let currentPositionSeconds = 0;
let isReportingStop = false;
// Quit is initiated (or a stop reported): suppress progress reports until the
// next playback starts. mpv emits a phantom pause=false ("Playback resumed")
// while exiting, and the resulting POST /Sessions/Playing/Progress can land
// AFTER POST /Sessions/Playing/Stopped (fire-and-forget over separate
// connections) — Jellyfin then re-stamps the session as playing and the server
// "disagrees" that playback stopped. Verified in a live session log.
let isStoppingPlayback = false;
// Serializes playback reports (progress/stop/start) so they reach the server in
// CALL ORDER — they travel as fire-and-forget POSTs over separate connections,
// which otherwise race: a progress report landing after the stop re-stamps the
// session as playing (mpv emits a phantom pause=false while exiting), and a
// start landing before the previous item's stop would kill the new playback.
let reportChain = Promise.resolve();

function chainReport(fn) {
    reportChain = reportChain.catch(() => {}).then(fn);
    return reportChain;
}
let accessToken = null;
let userId = null;
function createWsSocket(role) {
    return {
        role,
        ws: null,
        keepAliveInterval: null,
        heartbeatInterval: null,
        reconnectInterval: null,
        isReconnecting: false,
        reconnectAttempts: 0,
        lastMessageReceivedAt: 0,
        lastKeepAliveSentAt: 0
    };
}

// Jellyfin merges every WebSocket that authenticates with the same token+deviceId
// into one session's socket list (WebSocketController._sockets) and only closes
// the session when NO socket is left open (SessionManager.CloseIfNeededAsync).
// A redundant "presence" socket therefore keeps the session in /Sessions through
// a single-socket drop — which is exactly what stops jellyfin-web's sessionPlayer
// plugin from dropping the cast: processUpdatedSessions() switches the web UI
// back to the local player the moment the session is missing from a Sessions
// broadcast, and it never re-attaches on its own.
const wsSockets = {
    primary: createWsSocket('primary'),
    presence: createWsSocket('presence')
};
const seenMessageIds = new Set();
let reauthInFlight = false;

function anyWsOpen() {
    return Object.values(wsSockets).some(s => s.ws && s.ws.readyState === WebSocket.OPEN);
}

function sendOnSocket(sock, obj) {
    if (sock.ws && sock.ws.readyState === WebSocket.OPEN) {
        try {
            sock.ws.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            log('error', 'ws', 'Error sending message:', e.message);
        }
    }
    return false;
}

// Outbound traffic may ride either socket — the server itself routes commands to
// whichever socket was active most recently (WebSocketController.SendMessage).
function sendWsMessage(obj) {
    return sendOnSocket(wsSockets.primary, obj) || sendOnSocket(wsSockets.presence, obj);
}

function ensureSocketsConnected() {
    for (const sock of Object.values(wsSockets)) {
        const live = sock.ws && (sock.ws.readyState === WebSocket.OPEN || sock.ws.readyState === WebSocket.CONNECTING);
        if (!live && !sock.isReconnecting) connectSocket(sock);
    }
}

function closeAllWs() {
    for (const sock of Object.values(wsSockets)) {
        if (sock.keepAliveInterval) { clearInterval(sock.keepAliveInterval); sock.keepAliveInterval = null; }
        if (sock.heartbeatInterval) { clearInterval(sock.heartbeatInterval); sock.heartbeatInterval = null; }
        if (sock.reconnectInterval) { clearInterval(sock.reconnectInterval); sock.reconnectInterval = null; }
        if (sock.ws) {
            try {
                sock.ws.removeAllListeners();
                sock.ws.close();
            } catch (e) {}
            sock.ws = null;
        }
    }
}
// Note: an earlier "planned connection refresh" watchdog closed and reopened
// this WebSocket on a timer. It is removed: the external cuts it aimed to
// preempt are not connection-age-based (a drop was observed 5 minutes after a
// refresh), while every refresh was a real disconnect for the client — the
// Jellyfin web UI drops its cast selection and playback controls on each one,
// which hit users with perfectly healthy connections hardest.

const NOISY_WS_TYPES = ['KeepAlive', 'RefreshProgress', 'Sessions'];

// SyncPlay state
let currentSyncPlayGroupId = null;
let currentSyncPlayGroupName = null;

let pendingStreamUrl = null;
let pendingStartSeconds = 0;
let pendingAudioStreamIndex = undefined;
let pendingSubtitleStreamIndex = undefined;
// Sticky "the server asked for this track" selections. Unlike pending*, these
// survive until the next Play/SetXStreamIndex so they can be re-applied once
// external streams (which only exist after we sub-add them) are available.
let requestedAudioStreamIndex = undefined;
let requestedSubtitleStreamIndex = undefined;
// The item the request was issued for. Auto-advance to another file must not
// re-apply it (mpv keeps the user's track choice across playlist entries).
let requestedTrackItemId = null;
let isSettingSubtitleFromJellyfin = false;
let subtitleFlagTimeout = null;
let currentSubtitleTrack = undefined;
let currentAudioTrack = undefined;
let mpvTrackList = [];
// Jellyfin report fields derived from actual playback state (jellyfin-web
// reports the real values — pbm.js:2203). Repeat mode mirrors mpv's loop
// properties via observers; playback order has no mpv equivalent, so it is
// tracked from the commands that change it.
let currentRepeatMode = 'RepeatNone';
let currentPlaybackOrder = 'Default';
let currentLoopPlaylist = 'no';
let currentLoopFile = 'no';
let lastSubStylePushAt = 0;
let subStylePushTimer = null;
// ASS/SSA subtitles carry their own styling. sub-pos DOES move them (mpv
// default sub-ass-override=scale; the manual's "affects ASS as well" warning
// is literal — verified by frame rendering), but sub-color does not: the
// visible colour is the style's PrimaryColour. Recolour styled subs through
// sub-ass-style-overrides, which applies under the default mode. Do NOT touch
// Alignment here: forced alignment renders fansub styles destructively and
// unpredictably (Alignment=8 rendered mid-screen in testing), while sub-pos
// positions ASS exactly like plain text. The option is a string list whose set
// replaces the whole value, so preserve any entries from the user's mpv.conf
// and manage only our own PrimaryColour entry.
function setAssPrimaryColourOverride(colorOrNull) {
    return queryProperty('sub-ass-style-overrides')
        .then(cur => (Array.isArray(cur) ? cur : []))
        .catch(() => [])
        .then(kept => {
            const ours = kept.filter(e => !/^(?:[^.=]+\.)?PrimaryColour=/i.test(String(e)));
            if (colorOrNull) {
                // ASS colours are &HAABBGGRR with inverted alpha (00 = opaque)
                const hex = normalizeSubColor(String(colorOrNull)).slice(1);
                const bb = hex.slice(4, 6), gg = hex.slice(2, 4), rr = hex.slice(0, 2);
                ours.push(`PrimaryColour=&H00${bb}${gg}${rr}`);
            }
            sendMpvCommand('set_property', ['sub-ass-style-overrides', ours.join(',')]);
        });
}

// mpv returns sub-color as #AARRGGBB (and accepts r/g/b/a float forms) — the
// OSC's vocabulary is #RRGGBB with friendly names. Normalize so the reported
// "current" value and the selected flags actually match the options.
function normalizeSubColor(raw) {
    if (typeof raw !== 'string') return '#FFFFFF';
    let hex = raw.trim();
    const m = /^#([0-9a-f]+)$/i.exec(hex);
    if (m) {
        const digits = m[1];
        // 8 hex digits = #AARRGGBB -> drop alpha; 6 = #RRGGBB as-is
        return '#' + (digits.length === 8 ? digits.slice(2) : digits).toUpperCase();
    }
    const floats = raw.split('/').map(Number);
    if (floats.length >= 3 && floats.every(n => !Number.isNaN(n))) {
        const toHex = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
        return ('#' + toHex(floats[0]) + toHex(floats[1]) + toHex(floats[2])).toUpperCase();
    }
    return '#FFFFFF';
}
let playbackGeneration = 0;
// Supersession token for loadNewQueue: bumped per call so a slow info fetch in
// an older run cannot interleave playlist sends with a newer one.
let queueLoadGeneration = 0;
let isMpvPaused = false;
let isMuted = false;
let volumeLevel = 100;
let isPlayingNext = false;
let currentDuration = 0;
let progressPollTimer = null;
const pendingQueries = new Map();
const markedWatched = new Set();

let playQueue = [];
let queuePosition = -1;
let displayMessageTimeout = null;
let displayMessageOriginalFontSize = null;
let displayMessageOriginalAlignX = null;
let displayMessageOriginalAlignY = null;
let isNewQueueLoad = false;
let queueLoadCounter = 0;
let isPlayingNextTimestamp = 0;
let isShuttingDown = false;
let isUnwatchedQuit = false;

let introSegments = [];
let skipIntroTimeout = null;
let isInIntroSegment = false;
let lastErrorOsdTime = 0;
let nextUpShown = false;
let skippedSegmentIds = new Set();
let oscSeekTimeout = null;

function generateOrLoadDeviceId() {
    // Per-config id file so multiple configs don't share one device id (which would
    // make them share tokens and playback positions).
    const configBase = path.basename(configFile, path.extname(configFile));
    const idFile = path.join(__dirname, 'data', `.device-id-${configBase}`);
    const legacyIdFile = path.join(__dirname, 'data', '.device-id');
    try {
        if (fs.existsSync(idFile)) {
            return fs.readFileSync(idFile, 'utf8').trim();
        }
        if (fs.existsSync(legacyIdFile)) {
            // Adopt the old shared id ONCE (first config to run keeps its tokens
            // valid), then remove it so other configs generate their own.
            const id = fs.readFileSync(legacyIdFile, 'utf8').trim();
            if (id) {
                fs.writeFileSync(idFile, id, { mode: 0o600 });
                try { fs.unlinkSync(legacyIdFile); } catch {}
                return id;
            }
        }
    } catch {}
    const id = `mpv-${crypto.randomBytes(8).toString('hex')}`;
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { mode: 0o700 });
        fs.writeFileSync(idFile, id, { mode: 0o600 });
    } catch {}
    return id;
}

function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const stats = fs.statSync(TOKEN_FILE);
            const mode = stats.mode & 0o777;
            if (mode !== 0o600) {
                log('warn', 'auth', '⚠️ Token file has insecure permissions, re-authenticating');
                return false;
            }
            const data = fs.readFileSync(TOKEN_FILE, 'utf8');
            const tokenData = JSON.parse(data);
            if (tokenData.AccessToken && tokenData.User?.Id) {
                accessToken = tokenData.AccessToken;
                userId = tokenData.User.Id;
                log('info', 'auth', '✅ Saved token loaded successfully');
                return true;
            }
            log('warn', 'auth', '⚠️ Token file missing required fields, re-authenticating');
        }
    } catch (error) {
        log('error', 'auth', '⚠️ Error loading saved token:', error.message);
    }
    return false;
}

function saveToken(authResponse) {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(authResponse, null, 2));
        fs.chmodSync(TOKEN_FILE, 0o600);
        accessToken = authResponse.AccessToken;
        userId = authResponse.User?.Id;
        log('info', 'auth', '💾 Token saved successfully');
    } catch (error) {
        log('error', 'auth', '⚠️ Error saving token:', error.message);
    }
}

async function authenticateUser() {
    try {
        log('info', 'auth', '🔐 Authenticating user...');
        
        const authHeader = `MediaBrowser Client="${CONFIG.deviceName}", Device="${CONFIG.deviceName}", DeviceId="${CONFIG.deviceId}", Version="${CONFIG.clientVersion}"`;
        
        const response = await axios.post(
            `${CONFIG.serverUrl}/Users/AuthenticateByName`,
            {
                Username: CONFIG.username,
                Pw: CONFIG.password
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authHeader
                }
            }
        );

        saveToken(response.data);
        log('info', 'auth', `✅ Authentication successful for user: ${CONFIG.username}`);
        log('info', 'auth', `🆔 User ID: ${userId}`);
        return true;
    } catch (error) {
        log('error', 'auth', '❌ Authentication error:', error.message);
        if (error.response) {
            log('error', 'auth', '📄 HTTP status:', error.response.status);
        }
        return false;
    }
}

function loadPlaybackPositions() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            const data = fs.readFileSync(POSITIONS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        log('error', 'position', '⚠️ Error loading saved positions:', error.message);
    }
    return {};
}

function savePlaybackPosition(itemId, positionTicks) {
    try {
        const positions = loadPlaybackPositions();
        positions[itemId] = {
            positionTicks: positionTicks,
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
        log('info', 'position', `💾 Position saved locally: ${(positionTicks / 10000000).toFixed(2)}s for ${itemId}`);
    } catch (error) {
        log('error', 'position', '⚠️ Error saving position:', error.message);
    }
}

function getAuthHeaders() {
    return {
        'Authorization': `MediaBrowser Token="${accessToken}", Client="${CONFIG.deviceName}", Device="${CONFIG.deviceName}", DeviceId="${CONFIG.deviceId}", Version="${CONFIG.clientVersion}"`
    };
}

function connectSocket(sock) {
    if (isShuttingDown || sock.isReconnecting) {
        return;
    }

    sock.isReconnecting = true;

    if (sock.keepAliveInterval) {
        clearInterval(sock.keepAliveInterval);
        sock.keepAliveInterval = null;
    }
    if (sock.heartbeatInterval) {
        clearInterval(sock.heartbeatInterval);
        sock.heartbeatInterval = null;
    }

    if (sock.ws) {
        try {
            sock.ws.removeAllListeners();
            sock.ws.close();
        } catch (e) {
        }
        sock.ws = null;
    }

    const wsUrl = CONFIG.serverUrl.replace(/^http/, 'ws') + `/socket?ApiKey=${accessToken}&deviceId=${CONFIG.deviceId}`;
    const label = sock.role === 'presence' ? 'presence socket' : 'primary socket';

    log('info', 'ws', sock.role === 'presence' ? '🔌 Connecting presence socket...' : '🔌 Connecting to Jellyfin...');

    try {
        sock.ws = new WebSocket(wsUrl);

        sock.ws.on('open', () => {
            // "WebSocket connection established" is a macapp log-line contract —
            // emit it for the primary only; the presence socket logs its own line.
            log('info', 'ws', sock.role === 'presence' ? '✅ Presence WebSocket established.' : '✅ WebSocket connection established.');
            const wasReconnecting = sock.reconnectAttempts > 0;
            sock.isReconnecting = false;
            sock.reconnectAttempts = 0;
            sock.lastMessageReceivedAt = Date.now();
            sock.lastKeepAliveSentAt = 0;

            if (sock.role === 'primary') {
                lastErrorOsdTime = 0;
                log('info', 'ws', 'Connected to Jellyfin');
            }

            // NAT insurance: OS-level TCP keepalives on the raw socket.
            if (sock.ws._socket && typeof sock.ws._socket.setKeepAlive === 'function') {
                sock.ws._socket.setKeepAlive(true, 20000);
            }

            // Dead-connection watchdog (ws docs: "How to detect and close broken
            // connections"). A half-open TCP connection accepts our sends silently
            // and can take many minutes to surface an error. Protocol pings
            // generate pongs (verified: Kestrel auto-pongs) and the app-level
            // KeepAlive echo counts too — any inbound frame proves the link. Two
            // missed probes => terminate() (not close()) to force reconnect now.
            if (sock.heartbeatInterval) clearInterval(sock.heartbeatInterval);
            sock.heartbeatInterval = setInterval(() => {
                if (!sock.ws || sock.ws.readyState !== WebSocket.OPEN) return;
                if (Date.now() - sock.lastMessageReceivedAt > 35000) {
                    log('info', 'ws', `💀 No inbound traffic for 35s — terminating dead ${label}`);
                    try { sock.ws.terminate(); } catch (e) {}
                    return;
                }
                try { sock.ws.ping(); } catch (e) {}
            }, 15000);

            // Only announce recovery (and rehydrate) when this socket restored the
            // last surviving link — a single-socket swap is invisible to the user
            // and to the web UI, which never saw the session leave.
            const other = sock.role === 'primary' ? wsSockets.presence : wsSockets.primary;
            const otherOpen = other.ws && other.ws.readyState === WebSocket.OPEN;
            if (wasReconnecting && !otherOpen) {
                showErrorOsd('Reconnected');
                // Rehydrate immediately so the web UI's cast menu and remote
                // controls show correct state the moment the session reappears.
                if (currentItemId && mpvProcess) {
                    try {
                        const posTicks = Math.round((currentPositionSeconds || 0) * 10000000);
                        reportPlaybackProgress(currentItemId, posTicks);
                    } catch (e) {}
                }
            }

            // SessionsStart is per-connection (BasePeriodicWebSocketListener only
            // pushes to subscribed sockets) — subscribe on the primary so Sessions
            // broadcasts arrive as a single copy.
            if (sock.role === 'primary') {
                sendOnSocket(sock, { MessageType: 'SessionsStart', Data: '0,1500' });
                log('info', 'ws', '📤 SessionsStart message sent');
                reportCapabilities();
            }

            // The server stamps LastKeepAliveDate ONLY on inbound KeepAlive
            // messages (WebSocketConnection.SendKeepAliveResponse) — each socket
            // must feed itself or the server disposes it after 60s of silence.
            sock.keepAliveInterval = setInterval(() => {
                if (sock.ws && sock.ws.readyState === WebSocket.OPEN) {
                    try {
                        sock.ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                        sock.lastKeepAliveSentAt = Date.now();
                        log('debug', 'ws', '💓 Keep-alive sent');
                    } catch (e) {
                        log('error', 'ws', 'Error sending keep-alive:', e.message);
                    }
                }
            }, 30000);

            if (sock.reconnectInterval) {
                clearInterval(sock.reconnectInterval);
                sock.reconnectInterval = null;
            }
        });

        sock.ws.on('message', (data) => {
            sock.lastMessageReceivedAt = Date.now();
            try {
                const msg = JSON.parse(data);
                // Both sockets share one session; guard against any fan-out
                // delivering the same envelope twice (MessageId is the Guid on
                // every OutboundWebSocketMessage).
                if (msg.MessageId) {
                    if (seenMessageIds.has(msg.MessageId)) return;
                    seenMessageIds.add(msg.MessageId);
                    if (seenMessageIds.size > 200) {
                        seenMessageIds.delete(seenMessageIds.values().next().value);
                    }
                }
                if (!NOISY_WS_TYPES.includes(msg.MessageType)) {
                    log('info', 'ws', 'Message received:', msg.MessageType);
                }
                handleMessage(sock, msg).catch(e => log('error', 'ws', 'Error handling message:', e.message));
            } catch (e) {
                log('error', 'ws', 'Error parsing message:', e.message);
            }
        });

        sock.ws.on('ping', (data) => {
            sock.lastMessageReceivedAt = Date.now();
            log('debug', 'ws', '🏓 Server ping received (ws auto-responds with pong)');
        });

        sock.ws.on('pong', () => {
            sock.lastMessageReceivedAt = Date.now();
        });

        sock.ws.on('error', (error) => {
            log('error', 'ws', `WebSocket error: ${error.message} (code: ${error.code || 'none'})`);
            sock.isReconnecting = false;
        });

        sock.ws.on('close', (code, reason) => {
            const now = Date.now();
            const sinceLastMessage = sock.lastMessageReceivedAt ? Math.round((now - sock.lastMessageReceivedAt) / 1000) : 'unknown';
            const sinceLastKeepAlive = sock.lastKeepAliveSentAt ? Math.round((now - sock.lastKeepAliveSentAt) / 1000) : 'unknown';
            log('info', 'ws', `${sock.role === 'presence' ? 'Presence socket disconnected' : 'Disconnected from server'} — code: ${code}, reason: "${reason || 'none'}", since last message: ${sinceLastMessage}s, since last keepalive: ${sinceLastKeepAlive}s`);
            sock.isReconnecting = false;

            if (sock.keepAliveInterval) {
                clearInterval(sock.keepAliveInterval);
                sock.keepAliveInterval = null;
            }
            if (sock.heartbeatInterval) {
                clearInterval(sock.heartbeatInterval);
                sock.heartbeatInterval = null;
            }

            scheduleReconnect(sock);
        });

    } catch (error) {
        log('error', 'ws', '❌ Error creating WebSocket:', error.message);
        sock.isReconnecting = false;
        scheduleReconnect(sock);
    }
}

function scheduleReconnect(sock) {
    if (isShuttingDown) {
        return;
    }
    if (sock.reconnectInterval) {
        return;
    }

    sock.reconnectAttempts++;

    // Only announce a lost connection when the session itself is gone (no socket
    // left open) — a single-socket drop is invisible to the user and the web UI.
    if (sock.reconnectAttempts > 1 && !anyWsOpen()) {
        showErrorOsd('Connection lost — reconnecting...');
    }

    log('info', 'ws', `🔄 Reconnecting ${sock.role} socket — probing server every 1s (Attempt ${sock.reconnectAttempts})...`);

    // Hot recovery: the drops we see are short server-side outages (5-30s).
    // Probing every 1s means we escape within ~1s of the server coming back,
    // instead of after the next backoff slot (up to 30s late). WS connect
    // attempts themselves are still paced exponentially (jellyfin-web SDK
    // shape: 1s x 1.5, 30s cap) so a broken WS endpoint is not hammered.
    let probeBusy = false;
    let serverSeenDown = false;
    let connectFailures = 0;
    let connectNotBefore = 0;

    sock.reconnectInterval = setInterval(async () => {
        if (isShuttingDown) {
            clearInterval(sock.reconnectInterval);
            sock.reconnectInterval = null;
            return;
        }
        if (sock.ws && sock.ws.readyState === WebSocket.OPEN) {
            clearInterval(sock.reconnectInterval);
            sock.reconnectInterval = null;
            return;
        }
        if (probeBusy) return;
        probeBusy = true;
        try {
            const headers = getAuthHeaders();
            await axios.get(`${CONFIG.serverUrl}/System/Info`, {
                headers,
                timeout: 800
            });

            if (serverSeenDown) {
                serverSeenDown = false;
                log('info', 'ws', '✅ Server is reachable again');
            }

            if (Date.now() >= connectNotBefore) {
                connectFailures++;
                const paceSeconds = Math.min(30, Math.pow(1.5, connectFailures - 1));
                connectNotBefore = Date.now() + paceSeconds * 1000;
                log('info', 'ws', '✅ Network connection active. Attempting WebSocket reconnection...');
                connectSocket(sock);
            }
        } catch (error) {
            if (error.response && error.response.status === 401) {
                clearInterval(sock.reconnectInterval);
                sock.reconnectInterval = null;
                if (reauthInFlight) return;
                reauthInFlight = true;
                log('info', 'auth', '🔐 Token expired, reauthenticating...');
                showErrorOsd('Authentication expired — reconnecting...');
                const authenticated = await authenticateUser();
                reauthInFlight = false;
                if (authenticated) {
                    ensureSocketsConnected();
                } else {
                    log('error', 'auth', '❌ Reauthentication failed. Waiting for next attempt.');
                    showErrorOsd('Authentication failed');
                    scheduleReconnect(sock);
                }
                return;
            }
            if (!serverSeenDown) {
                serverSeenDown = true;
                log('warn', 'ws', '⚠️ Server unavailable or network down. Probing every 1s...');
                if (!anyWsOpen()) showErrorOsd('Server unreachable — retrying...');
            }
        } finally {
            probeBusy = false;
        }
    }, 1000);
}

function reportCapabilities() {
    // Only fields that exist on Jellyfin's ClientCapabilitiesDto
    // (MediaBrowser.Model/Dto/ClientCapabilitiesDto.cs). Extra fields such as
    // SupportsSync / SupportsContentUploading / SupportsRemoteControl do not exist
    // on Jellyfin's model and are silently discarded on deserialization.
    // SupportedCommands values must be exact GeneralCommandType enum names —
    // any other name makes the server reject the whole request with 400.
    const payload = {
        PlayableMediaTypes: ["Audio", "Video"],
        SupportedCommands: [
            "Play",
            "PlayState",
            "PlayNext",
            "SetShuffleQueue",
            "SetAudioStreamIndex",
            "SetSubtitleStreamIndex",
            "SetRepeatMode",
            "SetPlaybackOrder",
            "Mute",
            "Unmute",
            "ToggleMute",
            "VolumeUp",
            "VolumeDown",
            "SetVolume",
            "DisplayMessage",
            "ToggleFullscreen"
        ],
        SupportsMediaControl: true,
        SupportsPersistentIdentifier: true
    };

    axios.post(`${CONFIG.serverUrl}/Sessions/Capabilities/Full`, payload, { 
        headers: getAuthHeaders()
    })
        .catch(err => {
            if (err.response && err.response.status !== 401) {
                log('error', 'ws', '❌ Error registering capabilities:', err.message);
            }
        });
}

async function handleMessage(sock, msg) {
    if (msg.MessageType === "KeepAlive") {
        log('debug', 'ws', '💓 Server echoed our KeepAlive back');
        return;
    }
    if (msg.MessageType === "ForceKeepAlive") {
        const rawInterval = msg.Data ?? 30;
        const interval = typeof rawInterval === 'number' ? rawInterval
            : typeof rawInterval === 'string' ? parseInt(rawInterval, 10)
            : typeof rawInterval === 'object' && rawInterval !== null ? (rawInterval.Timeout ?? rawInterval.timeout ?? 30)
            : 30;
        const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : 30;
        log('info', 'ws', `Server requested keep-alive every ${safeInterval}s`);
        
        // Immediately respond to ForceKeepAlive on the socket that received it
        if (sock.ws && sock.ws.readyState === WebSocket.OPEN) {
            try {
                sock.ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                sock.lastKeepAliveSentAt = Date.now();
                log('debug', 'ws', '💓 Keep-alive sent (immediate response)');
            } catch (e) {
                log('error', 'ws', 'Error sending keep-alive:', e.message);
            }
        }
        
        // Set up periodic keep-alive at half the server's requested interval
        // to avoid race conditions with server timeout checks
        if (sock.keepAliveInterval) clearInterval(sock.keepAliveInterval);
        const keepAliveMs = Math.min(safeInterval * 500, 30000); // Half the server's interval, cap at 30s
        sock.keepAliveInterval = setInterval(() => {
            if (sock.ws && sock.ws.readyState === WebSocket.OPEN) {
                try {
                    sock.ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                    sock.lastKeepAliveSentAt = Date.now();
                    log('debug', 'ws', '💓 Keep-alive sent');
                } catch (e) {
                    log('error', 'ws', 'Error sending keep-alive:', e.message);
                }
            }
        }, keepAliveMs);
        return;
    }
    if (msg.MessageType === "Play") {
        log('info', 'handler', '▶️ PLAY command received from web!');
        const data = msg.Data || {};
        const itemIds = data.ItemIds || [];
        const hasStartPosition = 'StartPositionTicks' in data;
        const startPosition = hasStartPosition ? data.StartPositionTicks : null;
        const playCommand = data.PlayCommand || 'PlayNow';
        
        log('info', 'handler', '📋 Play command data:', { itemIds, startPositionTicks: startPosition, hasStartPosition, playCommand });
        
        if (itemIds.length > 0) {
            let finalStartPosition = 0;
            if (hasStartPosition) {
                finalStartPosition = startPosition || 0;
                if (startPosition === 0) {
                    log('info', 'handler', '🎯 Playing from beginning');
                } else {
                    log('info', 'handler', `🎯 Resume position from server: ${(startPosition / 10000000).toFixed(2)}s`);
                }
            } else {
                log('info', 'handler', '🎯 No start position in message, playing from beginning');
            }
            
            let orderedItems = [...itemIds];
            if (playCommand === 'PlayShuffle') {
                for (let i = orderedItems.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [orderedItems[i], orderedItems[j]] = [orderedItems[j], orderedItems[i]];
                }
                log('info', 'queue', '🔀 Shuffled playlist');
            } else if (playCommand === 'PlayInstantMix') {
                log('info', 'queue', 'ℹ️ PlayInstantMix not supported, playing first item');
            }
            
            const startIndex = data.StartIndex || 0;
            let targetId = orderedItems[startIndex] || orderedItems[0];
            
            if (startIndex > 0) {
                log('info', 'queue', `🎯 Starting from index ${startIndex}`);
            }
            
            await fetchItemInfoBatch(orderedItems);
            if (playCommand === 'PlayNext') {
                const insertAt = queuePosition + 1;
                playQueue.splice(insertAt, 0, ...orderedItems);
                sendMpvCommand('loadlist', [buildQueueM3u(orderedItems), 'insert-at', insertAt]);
                log('info', 'queue', `➕ Added ${orderedItems.length} item(s) to queue after position ${queuePosition}`);
                pushOscState();
                return;
            } else if (playCommand === 'PlayLast') {
                playQueue.push(...orderedItems);
                sendMpvCommand('loadlist', [buildQueueM3u(orderedItems), 'append']);
                log('info', 'queue', `➕ Appended ${orderedItems.length} item(s) to queue (total: ${playQueue.length})`);
                pushOscState();
                return;
            } else {
                // Expand to full season queue if items are episodes from the same season
                // Skip expansion for PlayShuffle — user selected specific episodes to shuffle
                if (orderedItems.length >= 1 && playCommand !== 'PlayShuffle') {
                    try {
                        // Expand around the STARTED item (StartIndex), not the first
                        // id in the list — jellyfin-web sends the resolved queue with
                        // StartIndex pointing at what the user clicked.
                        const startItemId = orderedItems[Math.min(Math.max(startIndex, 0), orderedItems.length - 1)];
                        const info = await getEpisodeInfo(startItemId, true);
                        if (info && info.isSeries && info.seasonNumber === 0 && (info.episodes?.length || 0) > 0
                            && orderedItems.some(id => !info.episodes.some(ep => ep.Id === id))) {
                            // Series/season-level request whose expansion put a special
                            // first: the server expands folder children by SortName
                            // (SessionManager.TranslateItemForPlayback), so a series id
                            // can arrive as [special, ...regulars]. jellyfin-web resolves
                            // such series plays client-side and starts at the next
                            // unwatched REGULAR episode (season 1 for a new series) —
                            // mirror that instead of starting on a special. A request
                            // that is entirely within the specials season is an explicit
                            // specials selection and is played as-is below.
                            playQueue = [...orderedItems];
                            const specialsIds = new Set(info.episodes.map(ep => ep.Id));
                            const nextUpId = await queryNextUp(info.seriesId);
                            let idx = nextUpId ? orderedItems.indexOf(nextUpId) : -1;
                            if (idx < 0) idx = orderedItems.findIndex(id => !specialsIds.has(id));
                            queuePosition = idx >= 0 ? idx : 0;
                            targetId = playQueue[queuePosition];
                            log('info', 'queue', `\u{1F4CB} Queue set: ${playQueue.length} items, starting at index ${queuePosition} (series play — starting past specials)`);
                        } else if (info && info.isSeries && info.episodes && info.episodes.length >= orderedItems.length) {
                            // If the request already lists the whole season in a specific
                            // order, keep that order. jellyfin-web's Shuffle is transformed
                            // by the server into PlayNow with a shuffled id list — re-sorting
                            // to season order here would silently undo the shuffle.
                            const seasonIds = new Set(info.episodes.map(ep => ep.Id));
                            const isPermutation = orderedItems.length === info.episodes.length
                                && new Set(orderedItems).size === orderedItems.length
                                && orderedItems.every(id => seasonIds.has(id));
                            if (isPermutation) {
                                playQueue = [...orderedItems];
                                queuePosition = Math.min(Math.max(startIndex, 0), playQueue.length - 1);
                            } else {
                                // Specials (season 0) expand to the specials season like any
                                // other season — the web client plays what was requested.
                                // End-of-queue NextUp already continues into the regular
                                // season afterwards, so no redirect is needed or wanted.
                                playQueue = info.episodes.map(ep => ep.Id);
                                queuePosition = info.currentIndex >= 0 ? info.currentIndex : 0;
                            }
                            targetId = playQueue[queuePosition];
                            log('info', 'queue', `\u{1F4CB} Full season queue: ${playQueue.length} episodes, starting at ${queuePosition + 1} (${info.seriesName} S${info.seasonNumber})${isPermutation ? ' [requested order kept]' : ''}`);
                        } else {
                            playQueue = [...orderedItems];
                            queuePosition = Math.min(Math.max(startIndex, 0), playQueue.length - 1);
                            log('info', 'queue', `\u{1F4CB} Queue set: ${playQueue.length} items, starting at index ${queuePosition}`);
                        }
                    } catch (e) {
                        playQueue = [...orderedItems];
                        queuePosition = startIndex;
                        log('info', 'queue', `📋 Queue set: ${playQueue.length} items, starting at index ${queuePosition}`);
                    }
                } else {
                    playQueue = [...orderedItems];
                    queuePosition = startIndex;
                    log('info', 'queue', `📋 Queue set: ${playQueue.length} items, starting at index ${queuePosition}`);
                }
            }
            
            if (data.AudioStreamIndex !== undefined) {
                pendingAudioStreamIndex = data.AudioStreamIndex;
            }
            if (data.SubtitleStreamIndex !== undefined) {
                pendingSubtitleStreamIndex = data.SubtitleStreamIndex === -1 ? 'no' : data.SubtitleStreamIndex;
            }
            // Sticky request: overwritten every Play (a Play without track
            // fields means "no preference", not "keep the old one").
            requestedAudioStreamIndex = data.AudioStreamIndex;
            requestedSubtitleStreamIndex = pendingSubtitleStreamIndex;
            requestedTrackItemId = targetId;

            if (ipcClient && !ipcClient.destroyed && mpvProcess) {
                loadNewQueue(targetId, finalStartPosition).catch(err => {
                    log('error', 'queue', '⚠️ Error loading new queue:', err.message);
                });
            } else {
                playMedia(targetId, finalStartPosition).catch(err => {
                    log('error', 'mpv', '⚠️ Error playing media:', err.message);
                });
            }
        } else {
            log('error', 'handler', '⚠️ No ItemIds received in Play command');
        }
    } 
    else if (msg.MessageType === "Playstate") {
        const data = msg.Data || {};
        const command = data.Command;
        log('info', 'handler', `⏯️ State command received: ${command}`);
        
        if (command === 'Stop') {
            if (currentItemId && !isReportingStop) {
                // Mark watched HERE, not at mpv-process exit: killing mpv is a
                // graceful shutdown that can take seconds, and the user expects
                // the watched state immediately. The close handler keeps its own
                // check as backstop (the markedWatched set prevents double posts).
                const runtime = currentEpisodeInfo?.itemRuntime || 0;
                if (!isUnwatchedQuit && runtime > 0 && currentPositionSeconds >= runtime * 0.9) {
                    markItemAsWatched(currentItemId);
                }
                reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
            }
            killMpv();
        } else if (command === 'Pause') {
            sendMpvCommand('set_property', ['pause', true]);
        } else if (command === 'Unpause') {
            sendMpvCommand('set_property', ['pause', false]);
        } else if (command === 'PlayPause') {
            sendMpvCommand('set_property', ['pause', !isMpvPaused]);
        } else if (command === 'NextTrack') {
            playNextEpisode();
        } else if (command === 'PreviousTrack') {
            playPreviousEpisode();
        } else if (command === 'Seek') {
            if (data.SeekPositionTicks !== undefined) {
                const seekSeconds = data.SeekPositionTicks / 10000000;
                sendMpvCommand('seek', [seekSeconds, 'absolute+keyframes']);
                log('info', 'handler', `⏩ Seek requested to ${seekSeconds.toFixed(2)}s`);
                currentPositionSeconds = seekSeconds;
                if (currentItemId) reportPlaybackProgress(currentItemId, data.SeekPositionTicks);
            }
        } else if (command === 'Rewind') {
            sendMpvCommand('seek', [-10, 'relative']);
            log('info', 'handler', '⏪ Rewind 10s');
        } else if (command === 'FastForward') {
            sendMpvCommand('seek', [10, 'relative']);
            log('info', 'handler', '⏩ Fast forward 10s');
        }
    }
    else if (msg.MessageType === "GeneralCommand") {
        const data = msg.Data || {};
        const command = data.Name;
        const args = data.Arguments || {};
        log('info', 'handler', `🎛️ General command received: ${command}`);
        
        if (command === 'SetAudioStreamIndex') {
            const index = parseInt(args.Index, 10);
            if (!isNaN(index)) {
                requestedAudioStreamIndex = index;
                requestedTrackItemId = currentItemId;
                sendMpvCommand('set_property', ['aid', jellyfinStreamIndexToMpvId(index, 'Audio')]);
            }
        } else if (command === 'SetSubtitleStreamIndex') {
            const index = parseInt(args.Index, 10);
            if (!isNaN(index)) {
                requestedSubtitleStreamIndex = index === -1 ? 'no' : index;
                requestedTrackItemId = currentItemId;
            }
            isSettingSubtitleFromJellyfin = true;
            if (subtitleFlagTimeout) clearTimeout(subtitleFlagTimeout);
            subtitleFlagTimeout = setTimeout(() => { isSettingSubtitleFromJellyfin = false; subtitleFlagTimeout = null; }, 5000);
            sendMpvCommand('set_property', ['sid', isNaN(index) || index === -1 ? 'no' : jellyfinStreamIndexToMpvId(index, 'Subtitle')]);
        } else if (command === 'SetVolume') {
            const vol = parseInt(args.Volume, 10);
            if (!isNaN(vol)) sendMpvCommand('set_property', ['volume', vol]);
        } else if (command === 'VolumeUp') {
            sendMpvCommand('add', ['volume', 5]);
        } else if (command === 'VolumeDown') {
            sendMpvCommand('add', ['volume', -5]);
        } else if (command === 'Mute') {
            sendMpvCommand('set_property', ['mute', true]);
        } else if (command === 'Unmute') {
            sendMpvCommand('set_property', ['mute', false]);
        } else if (command === 'ToggleMute') {
            sendMpvCommand('set_property', ['mute', !isMuted]);
        } else if (command === 'SetRepeatMode') {
            const mode = args.RepeatMode;
            if (mode === 'RepeatAll') sendMpvCommand('set_property', ['loop-playlist', 'inf']);
            else if (mode === 'RepeatOne') sendMpvCommand('set_property', ['loop-file', 'inf']);
            else { sendMpvCommand('set_property', ['loop-playlist', 'no']); sendMpvCommand('set_property', ['loop-file', 'no']); }
        } else if (command === 'SetPlaybackOrder') {
            const order = args.PlaybackOrder;
            // mpv has no runtime "shuffle" property — --shuffle only shuffles at load
            // time. playlist-shuffle / playlist-unshuffle are the commands that reorder
            // the current playlist (verified on mpv 0.41).
            currentPlaybackOrder = order === 'Shuffle' ? 'Shuffle' : 'Default';
            if (order === 'Shuffle') sendMpvCommand('playlist-shuffle');
            else sendMpvCommand('playlist-unshuffle');
            // playlist order just changed — keep playQueue in sync with it
            resyncQueueFromPlaylist();
        } else if (command === 'DisplayMessage') {
            const header = args.Header || '';
            const text = args.Text || '';
            log('info', 'handler', `💬 Jellyfin message: ${header} - ${text}`);
            const osdText = header ? `Message from Jellyfin Server\n${header}\n${text}` : `Message from Jellyfin Server\n${text}`;
            // jellyfin-web displays the message as a toast/alert and does NOT touch
            // playback (serverNotifications.js displayMessage) — match that. The
            // TimeoutMs argument (when sent) controls how long the message shows.
            const timeoutMs = parseInt(args.TimeoutMs, 10);
            const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
            if (displayMessageTimeout) {
                clearTimeout(displayMessageTimeout);
                displayMessageTimeout = null;
            } else {
                displayMessageOriginalFontSize = await queryProperty('osd-font-size');
                displayMessageOriginalAlignX = await queryProperty('osd-align-x');
                displayMessageOriginalAlignY = await queryProperty('osd-align-y');
            }
            sendMpvCommand('set_property', ['osd-font-size', 60]);
            sendMpvCommand('set_property', ['osd-align-x', 'center']);
            sendMpvCommand('set_property', ['osd-align-y', 'center']);
            await new Promise(r => setTimeout(r, 50));
            sendMpvCommand('show-text', [osdText, duration]);
            displayMessageTimeout = setTimeout(() => {
                displayMessageTimeout = null;
                sendMpvCommand('set_property', ['osd-font-size', displayMessageOriginalFontSize || 55]);
                sendMpvCommand('set_property', ['osd-align-x', displayMessageOriginalAlignX || 'center']);
                sendMpvCommand('set_property', ['osd-align-y', displayMessageOriginalAlignY || 'bottom']);
                displayMessageOriginalFontSize = null;
                displayMessageOriginalAlignX = null;
                displayMessageOriginalAlignY = null;
            }, duration);
        } else if (command === 'PlayNext') {
            playNextEpisode();
        } else if (command === 'ToggleFullscreen') {
            sendMpvCommand('cycle', ['fullscreen']);
        } else if (command === 'SkipIntro') {
            // Not a Jellyfin GeneralCommandType (verified against Jellyfin 12.2) —
            // kept for forward compatibility. The S key and jf-mpv-osc paths work.
            skipIntro();
        } else if (command === 'SetShuffleQueue') {
            // Shuffle the current queue and rebuild MPV playlist
            if (playQueue.length > 1) {
                for (let i = playQueue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [playQueue[i], playQueue[j]] = [playQueue[j], playQueue[i]];
                }
                queuePosition = playQueue.indexOf(currentItemId);
                if (queuePosition < 0) queuePosition = 0;

                // Rebuild MPV playlist to match new order WITHOUT restarting playback:
                // playlist-clear keeps the currently played file (now at index 0), and
                // the M3U chunks are inserted at their exact shuffled indices around it.
                await fetchItemInfoBatch(playQueue);
                const before = playQueue.slice(0, queuePosition);
                const after = playQueue.slice(queuePosition + 1);
                sendMpvCommand('playlist-clear');
                if (before.length) sendMpvCommand('loadlist', [buildQueueM3u(before), 'insert-at', 0]);
                if (after.length) sendMpvCommand('loadlist', [buildQueueM3u(after), 'insert-at', queuePosition + 1]);
                
                log('info', 'queue', `🔀 Queue shuffled by server (${playQueue.length} items)`);
                pushOscState();
            }
        } else if (command === 'SetSubtitleDelay') {
            const delay = args.Delay || 0;
            sendMpvCommand('set_property', ['sub-delay', delay]);
            log('info', 'mpv', `🔤 Subtitle delay set to ${delay}s`);
        } else if (command === 'SetAudioDelay') {
            const delay = args.Delay || 0;
            sendMpvCommand('set_property', ['audio-delay', delay]);
            log('info', 'mpv', `🔊 Audio delay set to ${delay}s`);
        }
    }
    else if (msg.MessageType === "SyncPlayCommand") {
        const data = msg.Data || {};
        const command = data.Command || 'unknown';
        log('info', 'syncplay', `SyncPlay command: ${command}`);
        switch (command) {
            case 'Unpause':
                sendMpvCommand('set_property', ['pause', false]);
                break;
            case 'Pause':
                sendMpvCommand('set_property', ['pause', true]);
                break;
            case 'Stop':
                killMpv();
                break;
            case 'Seek':
                if (data.StartPositionTicks !== undefined) {
                    const seekSeconds = data.StartPositionTicks / 10000000;
                    sendMpvCommand('seek', [seekSeconds, 'absolute']);
                }
                break;
            case 'SetPlaylistOrder':
                currentPlaybackOrder = data.PlaybackOrder === 'Shuffle' ? 'Shuffle' : 'Default';
                if (data.PlaybackOrder === 'Shuffle') sendMpvCommand('playlist-shuffle');
                else sendMpvCommand('playlist-unshuffle');
                resyncQueueFromPlaylist();
                break;
            case 'SetRepeatMode':
                if (data.RepeatMode === 'RepeatAll') sendMpvCommand('set_property', ['loop-playlist', 'inf']);
                else if (data.RepeatMode === 'RepeatOne') sendMpvCommand('set_property', ['loop-file', 'inf']);
                else { sendMpvCommand('set_property', ['loop-playlist', 'no']); sendMpvCommand('set_property', ['loop-file', 'no']); }
                break;
            case 'SetShuffleMode':
                if (data.ShuffleMode) sendMpvCommand('playlist-shuffle');
                else sendMpvCommand('playlist-unshuffle');
                resyncQueueFromPlaylist();
                break;
            default:
                log('info', 'syncplay', `Unknown SyncPlay command: ${command}`);
        }
    }
    else if (msg.MessageType === "SyncPlayGroupUpdate") {
        const data = msg.Data || {};
        const updateType = data.Type || 'unknown';
        log('info', 'syncplay', `SyncPlay group update: ${updateType}`);
        switch (updateType) {
            case 'GroupJoined':
                currentSyncPlayGroupId = data.GroupId || null;
                currentSyncPlayGroupName = data.GroupName || 'Unknown Group';
                log('info', 'syncplay', `Joined SyncPlay group: ${currentSyncPlayGroupName}`);
                pushOscState();
                break;
            case 'GroupLeft':
            case 'NotInGroup':
                currentSyncPlayGroupId = null;
                currentSyncPlayGroupName = null;
                log('info', 'syncplay', 'Left SyncPlay group');
                pushOscState();
                break;
            case 'GroupDoesNotExist':
                currentSyncPlayGroupId = null;
                currentSyncPlayGroupName = null;
                log('info', 'syncplay', 'SyncPlay group no longer exists');
                pushOscState();
                break;
            case 'LibraryAccessDenied':
                log('warn', 'syncplay', 'SyncPlay: library access denied for this group');
                break;
            case 'PlayQueue':
                log('debug', 'syncplay', 'SyncPlay playlist update');
                break;
            case 'StateUpdate':
                const stateData = data.State || {};
                const stateType = stateData.Type || 'unknown';
                if (stateType === 'WaitForPlay') {
                    // Another client paused/seeked — we should wait
                    const waitReason = stateData.Reason || 'unknown';
                    log('info', 'syncplay', `SyncPlay waiting: ${waitReason}`);
                    sendMpvCommand('set_property', ['pause', true]);
                    showSkipOsd('Syncing...');
                } else if (stateType === 'ReadyToPlay') {
                    // Ready to resume — seek to the specified position
                    const positionTicks = stateData.PositionTicks || 0;
                    const positionSeconds = positionTicks / 10000000;
                    log('info', 'syncplay', `SyncPlay ready, seeking to ${positionSeconds.toFixed(1)}s`);
                    sendMpvCommand('seek', [positionSeconds, 'absolute']);
                    sendMpvCommand('set_property', ['pause', false]);
                } else if (stateType === 'Playing') {
                    log('debug', 'syncplay', 'SyncPlay playing');
                } else if (stateType === 'Paused') {
                    log('debug', 'syncplay', 'SyncPlay paused');
                } else {
                    log('debug', 'syncplay', `SyncPlay state: ${stateType}`);
                }
                break;
        }
    }
    else if (msg.MessageType === "RestartRequired") {
        log('info', 'ws', '🔄 Server requires restart');
    }
    else if (msg.MessageType === "ServerShuttingDown") {
        log('info', 'ws', '🔴 Server is shutting down');
    }
    else if (msg.MessageType === "ServerRestarting") {
        log('info', 'ws', '🔄 Server is restarting, will reconnect...');
    }
    else if (msg.MessageType === "GetUTCTime") {
        // Respond with current UTC time for SyncPlay clock synchronization
        const utcTime = new Date().toISOString();
        log('debug', 'syncplay', `GetUTCTime request, responding: ${utcTime}`);
        sendWsMessage({ MessageType: 'GetUTCTimeResponse', Data: utcTime });
    }
    else if (msg.MessageType === "ActivityLogEntry") {
        const entry = msg.Data || {};
        log('debug', 'ws', `Activity: ${entry.Name || 'unknown'} — ${entry.Overview || ''}`);
    }
    else {
        if (!NOISY_WS_TYPES.includes(msg.MessageType)) {
            log('debug', 'ws', `Received message type: ${msg.MessageType}`);
        }
    }
}

async function getEpisodeInfo(itemId, silent = false) {
    try {
        return await fetchEpisodeInfo(itemId, silent);
    } catch (error) {
        log('warn', 'episode', `⚠️ Error getting item info for ${itemId}:`, error.message, '— retrying once');
        await new Promise(r => setTimeout(r, 500));
        try {
            return await fetchEpisodeInfo(itemId, silent);
        } catch (error2) {
            log('error', 'episode', `⚠️ Error getting item info for ${itemId}:`, error2.message);
            // null means the lookup FAILED (e.g. network/server error) — callers must
            // not confuse this with an item that is legitimately not playable.
            return null;
        }
    }
}

async function fetchEpisodeInfo(itemId, silent = false) {
    const headers = getAuthHeaders();

    const response = await axios.get(`${CONFIG.serverUrl}/Users/${userId}/Items/${itemId}`, {
        headers,
        params: { fields: 'MediaStreams,MediaSources' }
    });
    const item = response.data;
    cacheItemInfo(item);

    // Shared payload for EVERY item type — series-only fields are layered on
    // below. Keep both branches returning this shape so no type is lopsided
    // (e.g. mediaStreams missing for movies broke the OSC track lists and the
    // stream index <-> mpv id mapping fallbacks).
    const playableTypes = ['Episode', 'Movie', 'Video', 'MusicVideo', 'Audio'];
    const info = {
        isSeries: false,
        playable: playableTypes.includes(item.Type),
        type: item.Type,
        title: item.Name || 'Movie/Music',
        itemRuntime: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
        userData: item.UserData || {},
        mediaStreams: item.MediaStreams || []
    };

    if (item.Type === 'Episode') {
        const seasonResponse = await axios.get(`${CONFIG.serverUrl}/Shows/${item.SeriesId}/Episodes`, {
            headers,
            params: {
                seasonId: item.SeasonId,
                userId: userId,
                fields: 'Path,IndexNumber,ParentIndexNumber,SeriesName,Name,UserData'
            }
        });

        const episodes = [...seasonResponse.data.Items].sort((a, b) => a.IndexNumber - b.IndexNumber);
        const currentIndex = episodes.findIndex(ep => ep.Id === itemId);
        const epName = currentIndex >= 0 ? (episodes[currentIndex].Name || '') : (item.Name || '');
        const epLogTitle = [item.SeriesName, `${item.ParentIndexNumber}x${item.IndexNumber}`, epName].filter(Boolean).join(' - ');
        if (!silent) log('info', 'episode', `📺 Episode detected: ${epLogTitle}`);

        return {
            ...info,
            isSeries: true,
            playable: true,
            seriesId: item.SeriesId,
            currentIndex,
            episodes,
            nextEpisode: currentIndex >= 0 && currentIndex < episodes.length - 1 ? episodes[currentIndex + 1] : null,
            previousEpisode: currentIndex > 0 ? episodes[currentIndex - 1] : null,
            seriesName: item.SeriesName,
            seasonNumber: item.ParentIndexNumber,
            episodeNumber: item.IndexNumber,
            title: epName
        };
    }

    // Non-episode items have no "Episode detected" line — this is the title
    // contract the macOS app parses for movies/music (see AGENTS.md log contracts)
    if (!silent) log('info', 'episode', `▶️ Starting episode: ${info.title}`);
    return info;
}

async function getIntroSegments(itemId) {
    if (CONFIG.disableSkipIntro) {
        introSegments = [];
        skippedSegmentIds = new Set();
        isInIntroSegment = false;
        if (skipIntroTimeout) { clearTimeout(skipIntroTimeout); skipIntroTimeout = null; }
        return;
    }
    introSegments = [];
    skippedSegmentIds = new Set();
    isInIntroSegment = false;
    if (skipIntroTimeout) { clearTimeout(skipIntroTimeout); skipIntroTimeout = null; }
    try {
        const headers = getAuthHeaders();
        const response = await axios.get(`${CONFIG.serverUrl}/MediaSegments/${itemId}`, {
            headers,
            params: { includeSegmentTypes: ['Intro', 'Outro'] },
            // Repeat the array keys (includeSegmentTypes=Intro&includeSegmentTypes=Outro).
            // The axios default emits PHP-style includeSegmentTypes[]=... which ASP.NET
            // does not bind — the server then returns ALL segment types (Preview, Recap,
            // ...) and auto-skip would skip those too. Verified against Jellyfin 10.10.
            paramsSerializer: { indexes: null }
        });
        if (response.data && response.data.Items) {
            introSegments = response.data.Items.map(seg => ({
                startTicks: seg.StartTicks,
                endTicks: seg.EndTicks,
                type: seg.Type
            }));
            if (introSegments.length > 0) {
                log('info', 'segments', `🎬 Found ${introSegments.length} intro/outro segment(s)`);
            }
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            log('info', 'segments', 'ℹ️ Media segments API not available (server may not support it)');
        } else {
            log('error', 'segments', '⚠️ Error fetching intro segments:', error.message);
        }
    }
}

function skipIntro() {
    const posTicks = Math.round(currentPositionSeconds * 10000000);
    const segment = introSegments.find(seg => posTicks >= seg.startTicks && posTicks <= seg.endTicks);
    if (segment) {
        const seekTo = segment.endTicks / 10000000;
        log('info', 'segments', `⏩ Skipping ${segment.type} segment (seeking to ${seekTo.toFixed(2)}s)`);
        sendMpvCommand('seek', [seekTo, 'absolute+keyframes']);
        currentPositionSeconds = seekTo;
        if (currentItemId) reportPlaybackProgress(currentItemId, segment.endTicks);
        showSkipOsd(`Skipped ${segment.type.toLowerCase()}`);
        pushOscSkipButton('');
        // Mark this segment as skipped so we don't skip again
        skippedSegmentIds.add(segment.startTicks);
    }
    isInIntroSegment = false;
    if (skipIntroTimeout) { clearTimeout(skipIntroTimeout); skipIntroTimeout = null; }
}

function checkIntroSegment(positionTicks) {
    const segment = introSegments.find(seg =>
        positionTicks >= seg.startTicks &&
        positionTicks <= seg.endTicks &&
        !skippedSegmentIds.has(seg.startTicks)
    );
    if (segment) {
        if (!isInIntroSegment) {
            isInIntroSegment = true;
            const skipLabel = `Skip ${segment.type}`;
            pushOscSkipButton(skipLabel);
            // Don't auto-skip if the user is dragging the OSC seekbar
            if (CONFIG.autoSkipIntros && !oscSeekTimeout) {
                log('info', 'segments', `🎬 Auto-skip: ${segment.type} detected, skipping in 3s...`);
                showSkipOsd(`Skipping ${segment.type.toLowerCase()} in 3s...`);
                skipIntroTimeout = setTimeout(skipIntro, 3000);
            } else {
                log('info', 'segments', `🎬 ${segment.type} detected — press S to skip`);
                showSkipOsd(`Press S to skip ${segment.type.toLowerCase()}`);
            }
        }
    } else if (isInIntroSegment) {
        isInIntroSegment = false;
        pushOscSkipButton('');
        if (skipIntroTimeout) { clearTimeout(skipIntroTimeout); skipIntroTimeout = null; }
    }
}

let osdRestoreTimeout = null;

function showSkipOsd(text) {
    if (osdRestoreTimeout) { clearTimeout(osdRestoreTimeout); osdRestoreTimeout = null; }
    const savedSize = displayMessageOriginalFontSize || 55;
    const savedAlignX = displayMessageOriginalAlignX || 'center';
    const savedAlignY = displayMessageOriginalAlignY || 'bottom';
    if (displayMessageTimeout) {
        clearTimeout(displayMessageTimeout);
        displayMessageTimeout = null;
        displayMessageOriginalFontSize = null;
        displayMessageOriginalAlignX = null;
        displayMessageOriginalAlignY = null;
    }
    sendMpvCommand('set_property', ['osd-font-size', 40]);
    sendMpvCommand('set_property', ['osd-align-x', 'right']);
    sendMpvCommand('set_property', ['osd-align-y', 'bottom']);
    sendMpvCommand('show-text', [text, 3000]);
    osdRestoreTimeout = setTimeout(() => {
        sendMpvCommand('set_property', ['osd-font-size', savedSize]);
        sendMpvCommand('set_property', ['osd-align-x', savedAlignX]);
        sendMpvCommand('set_property', ['osd-align-y', savedAlignY]);
        osdRestoreTimeout = null;
    }, 3100);
}

function showErrorOsd(text) {
    const now = Date.now();
    if (now - lastErrorOsdTime < 30000) return;
    lastErrorOsdTime = now;
    if (osdRestoreTimeout) { clearTimeout(osdRestoreTimeout); osdRestoreTimeout = null; }
    const savedSize = displayMessageOriginalFontSize || 55;
    const savedAlignX = displayMessageOriginalAlignX || 'center';
    const savedAlignY = displayMessageOriginalAlignY || 'bottom';
    if (displayMessageTimeout) {
        clearTimeout(displayMessageTimeout);
        displayMessageTimeout = null;
        displayMessageOriginalFontSize = null;
        displayMessageOriginalAlignX = null;
        displayMessageOriginalAlignY = null;
    }
    sendMpvCommand('set_property', ['osd-font-size', 35]);
    sendMpvCommand('set_property', ['osd-align-x', 'right']);
    sendMpvCommand('set_property', ['osd-align-y', 'top']);
    sendMpvCommand('show-text', [text, 3000]);
    osdRestoreTimeout = setTimeout(() => {
        sendMpvCommand('set_property', ['osd-font-size', savedSize]);
        sendMpvCommand('set_property', ['osd-align-x', savedAlignX]);
        sendMpvCommand('set_property', ['osd-align-y', savedAlignY]);
        osdRestoreTimeout = null;
    }, 3100);
}

async function loadNewQueue(itemId, startTicks) {
    // Supersession token: two Play commands inside the info-fetch window would
    // otherwise interleave their playlist sends (the older run's insert-at
    // chunks can land AFTER the newer run's replace). Same pattern as
    // playbackGeneration in playMedia.
    const qgen = ++queueLoadGeneration;
    invalidateFileGeneration(); // stale file continuations die with this navigation
    stopProgressPoll();
    if (currentItemId && !isReportingStop) {
        const runtime = currentEpisodeInfo?.itemRuntime || 0;
        const completionThreshold = 0.9;
        if (runtime > 0 && currentPositionSeconds >= runtime * completionThreshold) {
            markItemAsWatched(currentItemId);
        }
        reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
    }
    isNewQueueLoad = true;

    currentItemId = itemId;
    currentPositionSeconds = startTicks / 10000000;
    pendingStartSeconds = 0;

    try {
        currentEpisodeInfo = await getEpisodeInfo(itemId);
        await getIntroSegments(itemId);
    } catch (e) {
        log('error', 'queue', '⚠️ Error getting episode info for new queue:', e.message);
        currentItemId = null;
        currentEpisodeInfo = null;
        isPlayingNext = false;
        isNewQueueLoad = false;
        return;
    }
    if (qgen !== queueLoadGeneration) return; // superseded by a newer Play

    if (!currentEpisodeInfo) {
        log('error', 'queue', `⚠️ Could not load item info for ${itemId} — aborting playback (server error, item not "non-playable")`);
        showErrorOsd('Failed to load item from server');
        currentItemId = null;
        currentEpisodeInfo = null;
        isPlayingNext = false;
        isNewQueueLoad = false;
        return;
    }

    if (!ipcClient || ipcClient.destroyed || !mpvProcess) {
        log('warn', 'queue', '⚠️ MPV/IPC no longer available after loading queue info, falling back to playMedia');
        playMedia(itemId, startTicks).catch(err => {
            log('error', 'mpv', '⚠️ Error playing media:', err.message);
        });
        return;
    }

    if (!currentEpisodeInfo.playable) {
        log('info', 'queue', `⏭️ Skipping non-playable item: ${currentEpisodeInfo.title}`);
        currentItemId = null;
        currentEpisodeInfo = null;
        return;
    }

    playSessionId = crypto.randomUUID();
    markedWatched.clear();

    const titleText = currentEpisodeInfo.isSeries
        ? [currentEpisodeInfo.seriesName, `${currentEpisodeInfo.seasonNumber}x${currentEpisodeInfo.episodeNumber}`, currentEpisodeInfo.title].filter(Boolean).join(' - ')
        : (currentEpisodeInfo.title || String(itemId));

    log('info', 'queue', `📺 Loading new queue: ${titleText}`);

    const savedAudioIndex = pendingAudioStreamIndex;
    const savedSubIndex = pendingSubtitleStreamIndex;
    pendingAudioStreamIndex = undefined;
    pendingSubtitleStreamIndex = undefined;

    // Rebuild the playlist. playlist-clear is NOT safe here: it keeps the
    // currently played file, which shifts every index by one (playlist-play-index
    // [queuePosition] would then play the wrong item, or restart the old one when
    // queuePosition is 0). loadfile replace swaps the whole playlist and
    // immediately plays the target (single-entry M3U so it carries its title);
    // loadlist insert-at places the remaining entries at their exact indices so
    // the mpv playlist matches playQueue order.
    if (playQueue.length === 0) {
        playQueue = [itemId];
        queuePosition = 0;
    } else {
        const itemIndex = playQueue.indexOf(itemId);
        queuePosition = itemIndex >= 0 ? itemIndex : Math.min(Math.max(queuePosition, 0), playQueue.length - 1);
    }
    await fetchItemInfoBatch(playQueue);
    if (qgen !== queueLoadGeneration) return; // superseded during the fetch
    sendMpvCommand('loadfile', [buildQueueM3u([playQueue[queuePosition]]), 'replace']);
    const before = playQueue.slice(0, queuePosition);
    const after = playQueue.slice(queuePosition + 1);
    if (before.length) sendMpvCommand('loadlist', [buildQueueM3u(before), 'insert-at', 0]);
    if (after.length) sendMpvCommand('loadlist', [buildQueueM3u(after), 'insert-at', queuePosition + 1]);
    queueLoadCounter = 1;
    log('info', 'queue', `📋 Loaded ${playQueue.length} items into MPV playlist (playing index ${queuePosition}).`);

    if (savedAudioIndex !== undefined) {
        sendMpvCommand('set_property', ['aid', savedAudioIndex === -1 ? 'no' : jellyfinStreamIndexToMpvId(savedAudioIndex, 'Audio')]);
    }
    if (savedSubIndex !== undefined) {
        isSettingSubtitleFromJellyfin = true;
        if (subtitleFlagTimeout) clearTimeout(subtitleFlagTimeout);
        subtitleFlagTimeout = setTimeout(() => { isSettingSubtitleFromJellyfin = false; subtitleFlagTimeout = null; }, 5000);
        sendMpvCommand('set_property', ['sid', savedSubIndex === 'no' || savedSubIndex === -1 ? 'no' : jellyfinStreamIndexToMpvId(savedSubIndex, 'Subtitle')]);
    }

    if (startTicks > 0) {
        pendingStartSeconds = startTicks / 10000000;
    }

    // Restore saved indices for reportPlaybackStart
    pendingAudioStreamIndex = savedAudioIndex;
    pendingSubtitleStreamIndex = savedSubIndex;
    reportPlaybackStart(itemId, startTicks);
    pendingAudioStreamIndex = undefined;
    pendingSubtitleStreamIndex = undefined;
    startProgressReporting(itemId);
    sendMpvCommand('set_property', ['force-media-title', `Jellyfin - ${titleText}`]);
    sendMpvCommand('set_property', ['title', `Jellyfin - ${titleText}`]);
}

async function playMedia(itemId, startTicks) {
    invalidateFileGeneration(); // stale file continuations die with this navigation
    if (currentItemId && !isReportingStop) {
        reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
    }
    killMpv();
    
    playbackGeneration++;
    const gen = playbackGeneration;

    currentItemId = itemId;
    currentPositionSeconds = startTicks / 10000000;
    currentEpisodeInfo = await getEpisodeInfo(itemId);
    await getIntroSegments(itemId);

    if (gen !== playbackGeneration) return;

    if (!currentEpisodeInfo) {
        log('error', 'mpv', `⚠️ Could not load item info for ${itemId} — aborting playback (server error, item not "non-playable")`);
        showErrorOsd('Failed to load item from server');
        currentItemId = null;
        currentEpisodeInfo = null;
        return;
    }

    if (!currentEpisodeInfo.playable) {
        log('info', 'queue', `⏭️ Skipping non-playable item: ${currentEpisodeInfo.title} (type: ${currentEpisodeInfo.isSeries ? 'series' : 'other'})`);
        currentItemId = null;
        currentEpisodeInfo = null;
        return;
    }

    playSessionId = crypto.randomUUID();

    pendingStreamUrl = `${CONFIG.serverUrl}/Videos/${itemId}/stream?static=true&ApiKey=${accessToken}`;
    pendingStartSeconds = startTicks / 10000000;

    log('info', 'mpv', '🍿 Launching MPV (Idle Mode)...');
    log('info', 'mpv', `    Item ID: ${itemId}`);
    log('info', 'mpv', `    Stream URL: ${redact(pendingStreamUrl)}`);
    log('info', 'mpv', `    MPV Path: ${CONFIG.mpvPath}`);

    const titleText = currentEpisodeInfo.isSeries 
        ? [currentEpisodeInfo.seriesName, `${currentEpisodeInfo.seasonNumber}x${currentEpisodeInfo.episodeNumber}`, currentEpisodeInfo.title].filter(Boolean).join(' - ')
        : (currentEpisodeInfo.title || String(itemId));
    
    const args = [
        '--idle=yes',
        '--force-window=immediate',
        `--force-media-title=Jellyfin - ${titleText}`,
        `--title=Jellyfin - ${titleText}`,
        '--keep-open=yes',
        `--input-ipc-server=${CONFIG.ipcSocketPath}`,
        '--save-position-on-quit=no',
        '--cache=yes'
    ];

    if (CONFIG.fullscreen) {
        args.push('--fullscreen');
    }

    if (Array.isArray(CONFIG.mpvFlags)) {
        args.push(...CONFIG.mpvFlags);
    }

    log('info', 'mpv', '🔧 MPV arguments:', args.join(' '));

    // Clear any stale IPC socket left behind by a previous crash
    try {
        if (fs.existsSync(CONFIG.ipcSocketPath)) {
            fs.unlinkSync(CONFIG.ipcSocketPath);
            log('info', 'mpv', '🧹 Cleaned up stale IPC socket');
        }
    } catch (e) {}

    try {
        mpvProcess = spawn(CONFIG.mpvPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: false
        });
        
        log('info', 'mpv', `✅ MPV started with PID: ${mpvProcess.pid}`);

        reportPlaybackStart(itemId, startTicks);
        startProgressReporting(itemId);

        setTimeout(() => {
            if (gen === playbackGeneration) {
                connectToMpvIpc(gen);
            }
        }, 500);

        mpvProcess.stdout.on('data', (data) => { 
            const line = data.toString().trim();
            if (line && !line.startsWith('AV:') && !line.startsWith('(Paused)') && !line.startsWith('(...)') && !line.includes('Cache:')) {
                log('debug', 'mpv', `MPV: ${redact(line)}`);
            }
        });
        
        mpvProcess.stderr.on('data', (data) => {
            const line = data.toString().trim();
            if (line && !line.startsWith('AV:') && !line.startsWith('(Paused)') && !line.startsWith('(...)') && !line.includes('Cache:') && !line.includes('File tags:')) {
                log('debug', 'mpv', `MPV stderr: ${redact(line)}`);
            }
        });

        mpvProcess.on('error', (err) => {
            log('error', 'mpv', '❌ Error executing MPV:', err.message);
            log('error', 'mpv', '   Check mpvPath configuration:', CONFIG.mpvPath);
        });

        mpvProcess.on('close', (code, signal) => {
            if (gen !== playbackGeneration) return;

            if (code === 4) {
                log('info', 'mpv', `🛑 MPV closed (code ${code}, signal: ${signal}) — normal for forced quit`);
            } else if (code === 0) {
                log('info', 'mpv', `🛑 MPV closed (code ${code}, signal: ${signal})`);
            } else {
                log('info', 'mpv', `🛑 MPV closed (code ${code}, signal: ${signal})`);
            }
            
            if (code === 1) {
                log('error', 'mpv', '⚠️ MPV closed with error. Possible causes:');
                log('error', 'mpv', '   - Command line argument issue');
                log('error', 'mpv', '   - Cannot create window');
                log('error', 'mpv', '   - Video driver problem');
                log('error', 'mpv', '   - Insufficient permissions');
            }
            
            // mpv emits a phantom pause=false ("Playback resumed") while exiting —
            // suppress progress reports before anything else so none can race the
            // stop report below (the ordering fix in reportPlaybackStop covers the
            // one already in flight).
            isStoppingPlayback = true;
            stopProgressPoll();
            if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }

            if (currentItemId && isUnwatchedQuit) {
                // "Quit and Mark Unwatched": leave no resume position anywhere —
                // no local save, no server resume point (stop report at 0), and
                // the item is reset to unwatched in Jellyfin.
                //
                // The DELETE must land AFTER the stop report: Jellyfin's stop
                // handler writes UserData, so a fire-and-forget delete racing
                // ahead of it leaves the user data recreated. Enqueue it on the
                // shared report chain so it is the last write.
                const unwatchedId = currentItemId;
                if (!isReportingStop) {
                    reportPlaybackStop(unwatchedId, 0);
                }
                chainReport(() => markItemAsUnwatched(unwatchedId));
            } else {
                if (currentItemId && currentPositionSeconds > 0) {
                    const positionTicks = Math.round(currentPositionSeconds * 10000000);
                    savePlaybackPosition(currentItemId, positionTicks);
                }
                if (currentItemId && !isReportingStop) {
                    reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
                }
            }
            // Mark watched independently of the stop-report guard: the Stop command
            // reports the stop first (isReportingStop=true) and then kills mpv —
            // tying these together meant stopping near the end never marked watched.
            if (currentItemId && !isUnwatchedQuit) {
                const runtime = currentEpisodeInfo?.itemRuntime || 0;
                const completionThreshold = 0.9;
                if (runtime > 0 && currentPositionSeconds >= runtime * completionThreshold) {
                    markItemAsWatched(currentItemId);
                }
            }
            isUnwatchedQuit = false;
            mpvProcess = null;
            for (const [, q] of pendingQueries) { if (q.timer) clearTimeout(q.timer); q.resolve(null); }
            pendingQueries.clear();
            if (ipcClient) { ipcClient.removeAllListeners(); ipcClient.destroy(); ipcClient = null; }
            currentItemId = null;
            isSettingSubtitleFromJellyfin = false;
            if (subtitleFlagTimeout) { clearTimeout(subtitleFlagTimeout); subtitleFlagTimeout = null; }
            currentSubtitleTrack = undefined;
            currentAudioTrack = undefined;
            mpvTrackList = [];
            streamIndexMap = { toMpv: new Map(), toJf: new Map() };
            externalStreamsAdded.clear();
            currentEpisodeInfo = null;
            // isReportingStop / isStoppingPlayback stay set on purpose: the next
            // reportPlaybackStart() lifts them. Clearing here let a late progress
            // report resurrect the session after a successful stop.
            isPlayingNext = false;
            isNewQueueLoad = false;
        });
    } catch (err) {
        log('error', 'mpv', '❌ Critical error executing MPV:', err);
        log('error', 'mpv', '   Stack:', err.stack);
        currentItemId = null;
        currentEpisodeInfo = null;
        stopProgressPoll();
        throw err;
    }
}

function connectToMpvIpc(gen) {
    if (ipcClient) {
        // Remove listeners BEFORE destroy so the old socket's close handler can't
        // fire later and clobber a newer connection (stale-close race).
        ipcClient.removeAllListeners();
        ipcClient.destroy();
        ipcClient = null;
    }

    let connectionAttempts = 0;
    const maxAttempts = 10;
    const retryDelay = 500;

    function attemptConnection() {
        if (gen !== playbackGeneration) return;
        connectionAttempts++;
        
        if (!mpvProcess || mpvProcess.exitCode !== null) {
            log('error', 'ipc', '❌ MPV not running, canceling IPC connection');
            return;
        }

        // Wait for socket file to exist before attempting connection
        if (!fs.existsSync(CONFIG.ipcSocketPath)) {
            if (connectionAttempts < maxAttempts) {
                setTimeout(attemptConnection, retryDelay);
            } else {
                log('error', 'ipc', '❌ Maximum IPC connection attempts reached — killing MPV');
                killMpv();
            }
            return;
        }

        log('info', 'ipc', `🔗 Connecting to MPV IPC...`);
        
        if (ipcClient) {
            ipcClient.removeAllListeners();
            ipcClient.destroy();
        }
        ipcClient = net.connect(CONFIG.ipcSocketPath);
        const sock = ipcClient;
        let buffer = '';

        sock.on('connect', () => {
            log('info', 'ipc', '✅ Connected to MPV IPC');

            setTimeout(async () => {
                if (pendingStreamUrl && gen === playbackGeneration) {
                    log('info', 'ipc', '📡 Loading playlist into MPV...');
                    await fetchItemInfoBatch(playQueue);
                    // One titled M3U instead of N raw URLs: the stock OSC playlist
                    // then shows episode/movie names instead of stream URLs.
                    sendMpvCommand('loadlist', [buildQueueM3u(playQueue), 'append']);
                    log('info', 'ipc', `    ✅ Loaded ${playQueue.length} items into playlist.`);

                    sendMpvCommand('playlist-play-index', [queuePosition]);

                    if (pendingAudioStreamIndex !== undefined) {
                        sendMpvCommand('set_property', ['aid', pendingAudioStreamIndex === -1 ? 'no' : jellyfinStreamIndexToMpvId(pendingAudioStreamIndex, 'Audio')]);
                        pendingAudioStreamIndex = undefined;
                    }
                    if (pendingSubtitleStreamIndex !== undefined) {
                        isSettingSubtitleFromJellyfin = true;
                        if (subtitleFlagTimeout) clearTimeout(subtitleFlagTimeout);
                        subtitleFlagTimeout = setTimeout(() => { isSettingSubtitleFromJellyfin = false; subtitleFlagTimeout = null; }, 5000);
                        sendMpvCommand('set_property', ['sid', pendingSubtitleStreamIndex === 'no' || pendingSubtitleStreamIndex === -1 ? 'no' : jellyfinStreamIndexToMpvId(pendingSubtitleStreamIndex, 'Subtitle')]);
                        pendingSubtitleStreamIndex = undefined;
                    }
                }
            }, CONFIG.mpvLoadDelayMs);

            sendMpvCommand('observe_property', [1, 'time-pos']);
            sendMpvCommand('observe_property', [2, 'pause']);
            sendMpvCommand('observe_property', [3, 'mute']);
            sendMpvCommand('observe_property', [4, 'volume']);
            sendMpvCommand('observe_property', [5, 'sid']);
            sendMpvCommand('observe_property', [6, 'seeking']);
            sendMpvCommand('observe_property', [7, 'playlist-pos']);
            sendMpvCommand('observe_property', [8, 'eof-reached']);
            sendMpvCommand('observe_property', [9, 'aid']);
            sendMpvCommand('observe_property', [10, 'loop-playlist']);
            sendMpvCommand('observe_property', [11, 'loop-file']);
            sendMpvCommand('observe_property', [12, 'sub-scale']);
            sendMpvCommand('observe_property', [13, 'sub-pos']);
            
            sendMpvCommand('keybind', ['>', 'script-message jellyfin-next']);
            sendMpvCommand('keybind', ['<', 'script-message jellyfin-prev']);
            if (!CONFIG.disableSkipIntro) {
                sendMpvCommand('keybind', ['s', 'script-message jellyfin-skip-intro']);
                log('info', 'ipc', '⌨️ Keys bound (>/< overridden for Jellyfin remote control, S for skip intro)');
            } else {
                log('info', 'ipc', '⌨️ Keys bound (>/< overridden for Jellyfin remote control)');
            }
        });

        sock.on('data', (data) => {
            buffer += data.toString();
            // Prevent unbounded buffer growth
            if (buffer.length > 1024 * 1024) { // 1MB limit
                log('warn', 'ipc', 'IPC buffer too large, clearing');
                buffer = '';
                return;
            }
            const lines = buffer.split('\n');
            buffer = lines.pop();

            lines.forEach(line => {
                if (line.trim()) {
                    try {
                        const response = JSON.parse(line);

                        if (response.request_id !== undefined && pendingQueries.has(response.request_id)) {
                            const query = pendingQueries.get(response.request_id);
                            if (query.timer) clearTimeout(query.timer);
                            pendingQueries.delete(response.request_id);
                            query.resolve(response.error === 'success' ? response.data : null);
                            return;
                        }

                        handleMpvEvent(response);
                        
                        if (response.error && response.error !== 'success') {
                            log('error', 'ipc', '⚠️ MPV Error:', response.error, JSON.stringify(response.command));
                        }
                    } catch (e) {
                        log('error', 'ipc', '⚠️ Failed to parse MPV IPC response:', line.substring(0, 200));
                    }
                }
            });
        });

        sock.on('error', (err) => {
            log('error', 'ipc', '⚠️ IPC error:', err.message);
            
            if (connectionAttempts < maxAttempts && mpvProcess && mpvProcess.exitCode === null) {
                setTimeout(attemptConnection, retryDelay);
            } else if (connectionAttempts >= maxAttempts) {
                log('error', 'ipc', '❌ Maximum IPC connection attempts reached');
                if (currentItemId && !isReportingStop) {
                    reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
                }
                killMpv();
            }
        });

        sock.on('close', () => {
            log('info', 'ipc', '🔌 Disconnected from MPV IPC');
            // Only clean up global state if this socket is still the active one —
            // a late close event from an old socket must not clobber a newer
            // connection or its outstanding queries.
            if (ipcClient !== sock) return;
            for (const [, q] of pendingQueries) { if (q.timer) clearTimeout(q.timer); q.resolve(null); }
            pendingQueries.clear();
            ipcClient = null;
        });
    }

    attemptConnection();
}

async function markItemAsUnwatched(itemId) {
    // "Quit and Mark Unwatched" (OSC): reset the item to unwatched in Jellyfin
    // and drop any local resume position so quitting leaves no trace.
    try {
        const headers = getAuthHeaders();
        await axios.delete(`${CONFIG.serverUrl}/Users/${userId}/PlayedItems/${itemId}`, { headers });
        log('info', 'report', `✅ Item marked as unwatched in Jellyfin (${itemId})`);
    } catch (error) {
        log('error', 'report', '⚠️ Error marking item as unwatched:', error.message);
    }
    try {
        const positions = loadPlaybackPositions();
        if (positions[itemId]) {
            delete positions[itemId];
            fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
            log('info', 'report', '🗑️ Local position cleared (marked unwatched)');
        }
    } catch (error) {
        log('error', 'position', '⚠️ Error clearing position:', error.message);
    }
}

async function markItemAsWatched(itemId) {
    if (markedWatched.has(itemId)) return true;
    markedWatched.add(itemId);
    try {
        const headers = getAuthHeaders();
        await axios.post(`${CONFIG.serverUrl}/Users/${userId}/PlayedItems/${itemId}`, {}, { headers });
        log('info', 'report', `✅ Item marked as watched in Jellyfin (${itemId})`);

        const positions = loadPlaybackPositions();
        if (positions[itemId]) {
            delete positions[itemId];
            fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
            log('info', 'report', '🗑️ Local position cleared (content watched)');
        }
        return true;
    } catch (error) {
        log('error', 'report', '⚠️ Error marking item as watched:', error.message);
        markedWatched.delete(itemId); // Allow retry on next attempt
        return false;
    }
}

function killMpv() {
    invalidateFileGeneration(); // the file this generation served is going away
    stopProgressPoll();
    introSegments = [];
    skippedSegmentIds = new Set();
    isInIntroSegment = false;
    nextUpShown = false;
    mpvTrackList = [];
    streamIndexMap = { toMpv: new Map(), toJf: new Map() };
    externalStreamsAdded.clear();
    if (skipIntroTimeout) { clearTimeout(skipIntroTimeout); skipIntroTimeout = null; }
    if (osdRestoreTimeout) { clearTimeout(osdRestoreTimeout); osdRestoreTimeout = null; }
    for (const [, q] of pendingQueries) { if (q.timer) clearTimeout(q.timer); q.resolve(null); }
    pendingQueries.clear();
    if (displayMessageTimeout) {
        clearTimeout(displayMessageTimeout);
        displayMessageTimeout = null;
        displayMessageOriginalFontSize = null;
        displayMessageOriginalAlignX = null;
        displayMessageOriginalAlignY = null;
    }
    if (mpvProcess) {
        log('info', 'mpv', '⏹️ Forcing previous MPV shutdown...');
        mpvProcess.kill();
        mpvProcess = null;
    }
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
    if (ipcClient) {
        ipcClient.removeAllListeners();
        ipcClient.destroy();
        ipcClient = null;
    }
    try {
        if (fs.existsSync(CONFIG.ipcSocketPath)) {
            fs.unlinkSync(CONFIG.ipcSocketPath);
        }
    } catch (e) {
        // ignore cleanup errors
    }
}

function sendMpvCommand(command, args = []) {
    if (!ipcClient || ipcClient.destroyed) {
        return;
    }

    const cmd = {
        command: [command, ...args],
        request_id: ipcCommandId++
    };

    try {
        const cmdStr = JSON.stringify(cmd) + '\n';
        const logArgs = args.map(arg => typeof arg === 'string' && (arg.includes('api_key=') || arg.includes('ApiKey=')) ? redact(arg) : arg);
        log('debug', 'mpv', '→', command, ...logArgs);
        ipcClient.write(cmdStr);
    } catch (e) {
        log('error', 'mpv', 'Error sending command:', e.message);
    }
}

function queryProperty(property, timeoutMs = 5000) {
    return new Promise((resolve) => {
        if (!ipcClient || ipcClient.destroyed) {
            resolve(null);
            return;
        }
        const requestId = ipcCommandId++;
        const timer = timeoutMs > 0 ? setTimeout(() => {
            pendingQueries.delete(requestId);
            resolve(null);
        }, timeoutMs) : null;
        pendingQueries.set(requestId, { property, resolve, timer });
        const cmd = { command: ['get_property', property], request_id: requestId };
        try {
            ipcClient.write(JSON.stringify(cmd) + '\n');
        } catch (e) {
            if (timer) clearTimeout(timer);
            pendingQueries.delete(requestId);
            resolve(null);
        }
    });
}

function startProgressPoll() {
    stopProgressPoll();
    progressPollTimer = setInterval(async () => {
        if (!currentItemId) return;

        if (isPlayingNext && Date.now() - isPlayingNextTimestamp > 30000) {
            log('warn', 'queue', '⚠️ isPlayingNext stuck for 30s, resetting');
            isPlayingNext = false;
        }

        const pos = await queryProperty('time-pos');
        const dur = await queryProperty('duration');
        if (typeof pos === 'number') currentPositionSeconds = pos;
        if (typeof dur === 'number') {
            currentDuration = dur;
        } else if (pos === null) {
            currentDuration = 0;
        }
        if (introSegments.length > 0) {
            checkIntroSegment(Math.round(currentPositionSeconds * 10000000));
        }
        if (!nextUpShown && !isMpvPaused && currentDuration > 0 && currentPositionSeconds >= currentDuration - 10 && currentEpisodeInfo?.nextEpisode) {
            nextUpShown = true;
            const next = currentEpisodeInfo.nextEpisode;
            const title = `${currentEpisodeInfo.seriesName} - ${next.ParentIndexNumber}x${next.IndexNumber} - ${next.Name}`;
            log('info', 'queue', `Next up: ${title}`);
            showSkipOsd(`Next up: ${title}`);
        }
        if (currentDuration > 0 && currentPositionSeconds >= currentDuration - 1 && !isPlayingNext && currentItemId) {
            const isLastInPlaylist = queuePosition >= playQueue.length - 1;
            if (isLastInPlaylist) {
                log('info', 'queue', `🎬 Near end of last item (${currentPositionSeconds.toFixed(1)}s / ${currentDuration.toFixed(1)}s), querying NextUp`);
                markItemAsWatched(currentItemId);
                reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
                playNextEpisode();
            }
        }
    }, 1000);
}

function stopProgressPoll() {
    if (progressPollTimer) {
        clearInterval(progressPollTimer);
        progressPollTimer = null;
    }
}

function handleMpvEvent(event) {
    if (event.event === 'file-loaded') {
        if (queueLoadCounter > 0) {
            queueLoadCounter--;
            if (queueLoadCounter === 0) {
                isNewQueueLoad = false;
            }
        } else {
            isNewQueueLoad = false;
        }

        // A loaded file is a new playback: lift the stopped state even if the
        // transition's reportPlaybackStart is still pending (or never ran — its
        // info fetch can fail).
        isReportingStop = false;
        isStoppingPlayback = false;
        log('info', 'mpv', '✅ File loaded by MPV. Preparing Seek if necessary...');
        isPlayingNext = false;
        currentDuration = 0;
        nextUpShown = false;
        markedWatched.clear();
        skippedSegmentIds.clear();
        isInIntroSegment = false;
        externalStreamsAdded.clear();
        const fileGen = ++fileLoadGeneration;

        // Refresh the track map, add external (sidecar) streams the container
        // does not carry, and rebuild the Jellyfin<->mpv index map. The item id
        // is resolved from the playlist entry — on auto-advance currentItemId
        // may not have been updated yet (its resolver is also async).
        (async () => {
            const pos = await queryProperty('playlist-pos').catch(() => null);
            const entry = typeof pos === 'number' ? await queryProperty(`playlist/${pos}/filename`).catch(() => null) : null;
            const itemId = itemIdFromPlaylistEntry(entry) || currentItemId;
            const tl = await queryProperty('track-list').catch(() => null);
            if (fileGen !== fileLoadGeneration) return; // a newer file won the race
            if (Array.isArray(tl)) mpvTrackList = tl;
            if (itemId) {
                refreshStreamIndexMap(itemId);
                // The map is authoritative for embedded tracks even before the
                // externals land (it zips embedded streams by order, so a
                // Jellyfin list that numbers externals first can't mis-map) —
                // re-apply the requested selection now, and again after the
                // external adds in case it targets one of those.
                applyRequestedStreamSelection(itemId);
                await loadExternalStreams(itemId, fileGen);
            } else {
                refreshStreamIndexMap();
            }
        })().catch(err => log('warn', 'mpv', `⚠️ Track setup failed: ${err.message}`));

        if (pendingStartSeconds > 0) {
            const seekTo = pendingStartSeconds;
            pendingStartSeconds = 0;
            setTimeout(() => {
                sendMpvCommand('seek', [seekTo, 'absolute+keyframes']);
                log('info', 'mpv', `⏩ Automatic seek to saved position: ${seekTo.toFixed(2)}s`);
                currentPositionSeconds = seekTo;
            }, 500);
        } else {
            currentPositionSeconds = 0;
            pendingStartSeconds = 0;
        }

        startProgressPoll();
        pendingStreamUrl = null;
        pushOscState();
        return;
    }

    if (event.event === 'property-change' && event.name === 'time-pos' && typeof event.data === 'number') {
        currentPositionSeconds = event.data;
        return;
    }

    if (event.event === 'property-change' && event.name === 'pause' && typeof event.data === 'boolean') {
        isMpvPaused = event.data;
        log('info', 'mpv', event.data ? '⏸️ Playback paused' : '▶️ Playback resumed');
        if (currentItemId) reportPlaybackProgress(currentItemId, Math.round(currentPositionSeconds * 10000000));
        return;
    }

    if (event.event === 'property-change' && event.name === 'mute' && typeof event.data === 'boolean') {
        isMuted = event.data;
        return;
    }

    if (event.event === 'property-change' && event.name === 'volume' && typeof event.data === 'number') {
        volumeLevel = Math.round(event.data);
        return;
    }

    if (event.event === 'file-loaded') {
        // A new file is a new intent: a stale isUnwatchedQuit (quit command
        // lost because the IPC dropped) must not mark THIS item unwatched.
        isUnwatchedQuit = false;
    }

    if (event.event === 'property-change' && event.name === 'aid') {
        currentAudioTrack = event.data;
        // The OSC renders track selection from shim-jf-osc-state — push fresh
        // state on every change (OSC action, Jellyfin command, or mpv's own menu)
        // or it keeps displaying the selection from load time.
        pushOscState();
        return;
    }

    if (event.event === 'property-change' && (event.name === 'loop-playlist' || event.name === 'loop-file')) {
        // Keep the RepeatMode we report to Jellyfin truthful (mpv's own loop
        // button / L key change these without going through SetRepeatMode)
        if (event.name === 'loop-file') currentLoopFile = event.data;
        else currentLoopPlaylist = event.data;
        const lf = currentLoopFile, lp = currentLoopPlaylist;
        currentRepeatMode = (lf && lf !== 'no') ? 'RepeatOne'
            : ((lp && lp !== 'no') ? 'RepeatAll' : 'RepeatNone');
        return;
    }

    if (event.event === 'property-change' && (event.name === 'sub-scale' || event.name === 'sub-pos')) {
        // jf-mpv-osc shows sub_style from the state blob; mpv's own G/F/r/R keys
        // change these without an OSC action — push (throttled: these fire in
        // bursts while a key is held)
        const now = Date.now();
        if (now - lastSubStylePushAt > 500) {
            lastSubStylePushAt = now;
            pushOscState();
        } else if (!subStylePushTimer) {
            // trailing push: the change that ends a burst must still land
            subStylePushTimer = setTimeout(() => {
                subStylePushTimer = null;
                lastSubStylePushAt = Date.now();
                pushOscState();
            }, 500 - (now - lastSubStylePushAt));
        }
        return;
    }

    if (event.event === 'property-change' && event.name === 'sid') {
        currentSubtitleTrack = event.data;
        pushOscState();
        if (isSettingSubtitleFromJellyfin) {
            isSettingSubtitleFromJellyfin = false;
            if (subtitleFlagTimeout) { clearTimeout(subtitleFlagTimeout); subtitleFlagTimeout = null; }
            return;
        }
        if (currentItemId) {
            const sid = event.data;
            log('info', 'mpv', `🔤 Subtitle changed in MPV: track ${sid}`);
            reportPlaybackProgress(currentItemId, Math.round(currentPositionSeconds * 10000000));
        }
        return;
    }

    if (event.event === 'property-change' && event.name === 'seeking' && event.data === false) {
        if (currentItemId) reportPlaybackProgress(currentItemId, Math.round(currentPositionSeconds * 10000000));
        return;
    }

    if (event.event === 'property-change' && event.name === 'playlist-pos' && typeof event.data === 'number') {
        const newPos = event.data;
        // Skip during new queue loads — file-loaded handler takes care of it
        if (isNewQueueLoad) return;
        if (playQueue.length > 0 && newPos >= 0 && newPos < playQueue.length && newPos !== queuePosition) {
            // Resolve the playing item from the PLAYLIST ENTRY, not playQueue[newPos]:
            // playlist reorders (SetShuffleQueue, playlist-shuffle) shift indexes
            // without changing the playing file, and the two lists may even be in
            // different orders. Treating an index shift as navigation caused bogus
            // "next episode" transitions and could clear the queue via NextUp.
            queryProperty(`playlist/${newPos}/filename`).then(entry => {
                const entryId = itemIdFromPlaylistEntry(entry) || playQueue[newPos];
                if (entryId && currentItemId && entryId === currentItemId) {
                    log('info', 'queue', `📋 Playlist reordered: queuePosition=${newPos} (same item)`);
                    queuePosition = newPos;
                    resyncQueueFromPlaylist();
                    return;
                }

                const prevItemId = currentItemId;
                const prevPos = currentPositionSeconds;
                const prevRuntime = currentEpisodeInfo?.itemRuntime || 0;

                if (prevItemId && prevItemId !== entryId) {
                    if (prevRuntime > 0 && prevPos >= prevRuntime * 0.9) {
                        markItemAsWatched(prevItemId);
                    }
                    reportPlaybackStop(prevItemId, Math.round(prevPos * 10000000));
                }
                stopProgressPoll();

                queuePosition = newPos;
                currentItemId = entryId;
                currentPositionSeconds = 0;

                log('info', 'queue', `📋 Playlist changed: queuePosition=${queuePosition}, itemId=${currentItemId}`);

                getEpisodeInfo(currentItemId).then(info => {
                    if (!info) log('warn', 'episode', `⚠️ Could not load item info for ${currentItemId} — continuing with generic title`);
                    currentEpisodeInfo = info;
                    const titleText = info && info.isSeries
                        ? [info.seriesName, `${info.seasonNumber}x${info.episodeNumber}`, info.title].filter(Boolean).join(' - ')
                        : ((info && info.title) || String(currentItemId));
                    log('info', 'queue', `▶️ Starting next episode: ${titleText}`);
                    sendMpvCommand('set_property', ['force-media-title', `Jellyfin - ${titleText}`]);
                    sendMpvCommand('set_property', ['title', `Jellyfin - ${titleText}`]);
                    beginPlaybackReporting(currentItemId);
                    getIntroSegments(currentItemId).catch(err => {
                        log('error', 'segments', '⚠️ Error getting intro segments:', err.message);
                    });
                    startProgressPoll();
                    pushOscState();
                }).catch(err => {
                    log('error', 'episode', '⚠️ Error getting episode info:', err.message);
                    // The report must not depend on the info fetch — without it
                    // the server hears STOP for the old item and only PROGRESS
                    // for the new one (no PlaybackStart for scrobblers).
                    beginPlaybackReporting(currentItemId);
                    startProgressPoll();
                });
            });
        }
        return;
    }

    if (event.event === 'property-change' && event.name === 'eof-reached' && event.data === true) {
        if (isNewQueueLoad) return; // Skip during new queue loads
        const isLastInPlaylist = queuePosition >= playQueue.length - 1;
        const posStr = currentPositionSeconds ? currentPositionSeconds.toFixed(1) : '?';
        const durStr = currentDuration ? currentDuration.toFixed(1) : '?';
        log('info', 'mpv', `End of file reached — itemId=${currentItemId || 'none'}, pos=${posStr}s/${durStr}s, queue=${queuePosition}/${playQueue.length - 1}, isLast=${isLastInPlaylist}`);
        if (currentItemId && !isPlayingNext && isLastInPlaylist) {
            log('info', 'queue', 'EOF on last item, checking for auto-close');
            markItemAsWatched(currentItemId);
            reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
            playNextEpisode();
        }
        return;
    }

    if (event.event === 'client-message' && event.args && event.args[0]) {
        if (event.args[0] === 'jellyfin-next') {
            log('info', 'episode', '⏭️ Next episode requested (Keypress)');
            playNextEpisode();
        } else if (event.args[0] === 'jellyfin-prev') {
            log('info', 'episode', '⏮️ Previous episode requested (Keypress)');
            playPreviousEpisode();
        } else if (event.args[0] === 'jellyfin-skip-intro') {
            log('info', 'segments', '⏩ Skip intro requested (Keypress)');
            skipIntro();
        } else if (event.args[0] === 'shim-jf-osc-action') {
            handleOscAction(event.args[1], event.args[2]);
        } else if (event.args[0] === 'shim-close') {
            log('info', 'osc', '🎮 OSC close requested — closing MPV');
            // Quit is initiated: mpv emits a phantom pause=false while exiting —
            // it must not fire a progress report that could outlive the stop.
            isStoppingPlayback = true;
            sendMpvCommand('quit');
        } else if (event.args[0] === 'shim-jf-osc-ui-seek') {
            // OSC seekbar was dragged — exempt from skip-intro detection
            if (oscSeekTimeout) clearTimeout(oscSeekTimeout);
            oscSeekTimeout = setTimeout(() => { oscSeekTimeout = null; }, 2000);
        }
    }
}

async function playNextEpisode() {
    if (isPlayingNext) {
        log('info', 'queue', '⏭️ Already playing next episode, skipping duplicate call.');
        return;
    }
    isPlayingNext = true;
    isPlayingNextTimestamp = Date.now();
    invalidateFileGeneration(); // stale file continuations die with this navigation
    // Safety timeout to reset isPlayingNext if progress poll isn't running
    setTimeout(() => {
        if (isPlayingNext && Date.now() - isPlayingNextTimestamp > 30000) {
            log('info', 'queue', '⚠️ isPlayingNext stuck for 30s (safety timeout), resetting');
            isPlayingNext = false;
        }
    }, 31000);

    if (playQueue.length > 0 && queuePosition < playQueue.length - 1) {
        const prevItemId = currentItemId;
        const prevPos = currentPositionSeconds;
        const prevRuntime = currentEpisodeInfo?.itemRuntime || 0;
        if (prevItemId) {
            if (prevRuntime > 0 && prevPos >= prevRuntime * 0.9) {
                markItemAsWatched(prevItemId);
            }
            reportPlaybackStop(prevItemId, Math.round(prevPos * 10000000));
        }
        stopProgressPoll();
        queuePosition++;
        currentItemId = playQueue[queuePosition];
        currentPositionSeconds = 0;
        log('info', 'queue', `▶️ Next in queue (${queuePosition + 1}/${playQueue.length})`);
        if (!ipcClient || ipcClient.destroyed || !mpvProcess) {
            log('warn', 'queue', '⚠️ MPV/IPC not available, cannot skip to next');
            isPlayingNext = false;
            return;
        }
        getEpisodeInfo(currentItemId).then(info => {
            if (!info) log('warn', 'episode', `⚠️ Could not load item info for ${currentItemId} — continuing with generic title`);
            currentEpisodeInfo = info;
            const titleText = info && info.isSeries
                ? [info.seriesName, `${info.seasonNumber}x${info.episodeNumber}`, info.title].filter(Boolean).join(' - ')
                : ((info && info.title) || String(currentItemId));
            log('info', 'queue', `▶️ Starting next episode: ${titleText}`);
            sendMpvCommand('set_property', ['force-media-title', `Jellyfin - ${titleText}`]);
            sendMpvCommand('set_property', ['title', `Jellyfin - ${titleText}`]);
            beginPlaybackReporting(currentItemId);
            pushOscState();
        }).catch(err => {
            log('error', 'episode', '⚠️ Error getting episode info:', err.message);
            beginPlaybackReporting(currentItemId);
        });
        sendMpvCommand('playlist-next');
        return;
    }

    if (!currentEpisodeInfo || !currentEpisodeInfo.isSeries) {
        log('info', 'queue', 'ℹ️ Not a series, ending playback.');
        playQueue = [];
        queuePosition = -1;
        isPlayingNext = false;
        pushOscState(false);
        if (CONFIG.autoClose) {
            log('info', 'queue', 'ℹ️ Auto-close enabled, closing MPV...');
            isStoppingPlayback = true;
            sendMpvCommand('quit');
        } else {
            log('info', 'queue', 'ℹ️ Playlist ended, MPV staying open (--keep-open=yes)');
        }
        return;
    }

    if (currentEpisodeInfo.nextEpisode) {
        const nextEp = currentEpisodeInfo.nextEpisode;
        const nextTitle = [currentEpisodeInfo.seriesName, `${currentEpisodeInfo.seasonNumber}x${nextEp.IndexNumber}`, nextEp.Name].filter(Boolean).join(' - ');
        log('info', 'queue', `▶️ Starting next episode: ${nextTitle}`);
        // Mark current episode as watched before advancing
        const prevItemId = currentItemId;
        const prevPos = currentPositionSeconds;
        const prevRuntime = currentEpisodeInfo?.itemRuntime || 0;
        if (prevItemId) {
            if (prevRuntime > 0 && prevPos >= prevRuntime * 0.9) {
                markItemAsWatched(prevItemId);
            }
            reportPlaybackStop(prevItemId, Math.round(prevPos * 10000000));
        }
        if (!ipcClient || ipcClient.destroyed || !mpvProcess) {
            playQueue = [nextEp.Id];
            queuePosition = 0;
            playMedia(nextEp.Id, 0).catch(err => {
                    log('error', 'episode', '⚠️ Error playing next episode:', err.message);
                isPlayingNext = false;
            });
            return;
        }
        playQueue.push(nextEp.Id);
        queuePosition = playQueue.length - 1;
        currentItemId = nextEp.Id;
        cacheItemInfo({ ...nextEp, Type: 'Episode' });
        sendMpvCommand('loadlist', [buildQueueM3u([nextEp.Id]), 'append']);
        sendMpvCommand('playlist-play-index', [queuePosition]);
        beginPlaybackReporting(nextEp.Id);
        return;
    }

    log('info', 'queue', '🔍 End of season, querying NextUp...');
    try {
        // Mark current episode as watched BEFORE querying NextUp to prevent race condition
        const prevItemId2 = currentItemId;
        const prevPos2 = currentPositionSeconds;
        const prevRuntime2 = currentEpisodeInfo?.itemRuntime || 0;
        if (prevItemId2) {
            if (prevRuntime2 > 0 && prevPos2 >= prevRuntime2 * 0.9) {
                let marked = await markItemAsWatched(prevItemId2);
                if (!marked) {
                    log('warn', 'queue', '⚠️ Failed to mark episode as watched, retrying...');
                    marked = await markItemAsWatched(prevItemId2); // One retry
                    if (!marked) {
                        log('error', 'queue', '❌ Failed to mark episode as watched after retry, proceeding anyway');
                    }
                }
            }
            reportPlaybackStop(prevItemId2, Math.round(prevPos2 * 10000000));
        }
        const nextUpId = await queryNextUp(currentEpisodeInfo.seriesId, prevItemId2);
        if (nextUpId) {
            const nextUpInfo = await getEpisodeInfo(nextUpId);
            if (!nextUpInfo) log('warn', 'queue', `⚠️ Could not load item info for NextUp ${nextUpId} — continuing with generic title`);
            const nextUpTitle = nextUpInfo && nextUpInfo.isSeries
                ? [nextUpInfo.seriesName, `${nextUpInfo.seasonNumber}x${nextUpInfo.episodeNumber}`, nextUpInfo.title].filter(Boolean).join(' - ')
                : ((nextUpInfo && nextUpInfo.title) || String(nextUpId));
            log('info', 'queue', `▶️ Starting next episode: ${nextUpTitle}`);
            if (!ipcClient || ipcClient.destroyed || !mpvProcess) {
                playMedia(nextUpId, 0).catch(err => {
                log('error', 'episode', '⚠️ Error playing next episode:', err.message);
                    isPlayingNext = false;
                });
                return;
            }
            playQueue.push(nextUpId);
            queuePosition = playQueue.length - 1;
            currentItemId = nextUpId;
            sendMpvCommand('loadlist', [buildQueueM3u([nextUpId]), 'append']);
            sendMpvCommand('playlist-play-index', [queuePosition]);
            beginPlaybackReporting(nextUpId);
        } else {
            log('info', 'queue', 'ℹ️ No more episodes, ending playback.');
            playQueue = [];
            queuePosition = -1;
            isPlayingNext = false;
            pushOscState(false);
            if (CONFIG.autoClose) {
                log('info', 'queue', 'ℹ️ Auto-close enabled, closing MPV...');
                isStoppingPlayback = true;
                sendMpvCommand('quit');
            } else {
                log('info', 'queue', 'ℹ️ Playlist ended, MPV staying open (--keep-open=yes)');
            }
        }
    } catch (e) {
        log('warn', 'queue', '⚠️ NextUp query failed, keeping playback alive:', e.message);
        isPlayingNext = false;
    }
}

async function queryNextUp(seriesId, excludeItemId = null) {
    const headers = getAuthHeaders();
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const response = await axios.get(`${CONFIG.serverUrl}/Shows/NextUp`, {
            headers,
            params: { userId, seriesId, limit: 1 }
        });
        if (response.data?.Items && response.data.Items.length > 0) {
            const nextEp = response.data.Items[0];
            if (excludeItemId && nextEp.Id === excludeItemId) {
                if (attempt < maxRetries) {
                    log('info', 'queue', `⚠️ NextUp returned same episode (attempt ${attempt}/${maxRetries}), waiting ${retryDelay}ms for server cache update...`);
                    await new Promise(r => setTimeout(r, retryDelay));
                    continue;
                }
                log('warn', 'queue', '⚠️ NextUp still returning same episode after retries, skipping');
                return null;
            }
            log('info', 'episode', `📺 NextUp from Jellyfin: ${nextEp.SeriesName} - S${nextEp.ParentIndexNumber}E${nextEp.IndexNumber} - ${nextEp.Name} (itemId: ${nextEp.Id})`);
            return nextEp.Id;
        }
        return null;
    }
    return null;
}

async function playPreviousEpisode() {
    if (isPlayingNext) {
        log('info', 'queue', '⏭️ Already transitioning, skipping.');
        return;
    }
    isPlayingNext = true;
    isPlayingNextTimestamp = Date.now();
    // Safety timeout to reset isPlayingNext if progress poll isn't running
    setTimeout(() => {
        if (isPlayingNext && Date.now() - isPlayingNextTimestamp > 30000) {
            log('info', 'queue', '⚠️ isPlayingNext stuck for 30s (safety timeout), resetting');
            isPlayingNext = false;
        }
    }, 31000);

    if (currentPositionSeconds > 30) {
        log('info', 'episode', '↩️ Restarting current episode (time > 30s)');
        sendMpvCommand('seek', [0, 'absolute+keyframes']);
        currentPositionSeconds = 0;
        if (currentItemId) reportPlaybackProgress(currentItemId, 0);
        isPlayingNext = false;
        return;
    }

    if (playQueue.length > 0 && queuePosition > 0) {
        invalidateFileGeneration(); // stale file continuations die with this navigation
        const prevItemId = currentItemId;
        const prevPos = currentPositionSeconds;
        const prevRuntime = currentEpisodeInfo?.itemRuntime || 0;
        if (prevItemId) {
            if (prevRuntime > 0 && prevPos >= prevRuntime * 0.9) {
                markItemAsWatched(prevItemId);
            }
            reportPlaybackStop(prevItemId, Math.round(prevPos * 10000000));
        }
        stopProgressPoll();
        queuePosition--;
        currentItemId = playQueue[queuePosition];
        currentPositionSeconds = 0;
        log('info', 'queue', `⏮️ Previous in queue (${queuePosition + 1}/${playQueue.length})`);
        getEpisodeInfo(currentItemId).then(info => {
            if (!info) log('warn', 'episode', `⚠️ Could not load item info for ${currentItemId} — continuing with generic title`);
            currentEpisodeInfo = info;
            const titleText = info && info.isSeries
                ? [info.seriesName, `${info.seasonNumber}x${info.episodeNumber}`, info.title].filter(Boolean).join(' - ')
                : ((info && info.title) || String(currentItemId));
            log('info', 'queue', `▶️ Starting previous episode: ${titleText}`);
            sendMpvCommand('set_property', ['force-media-title', `Jellyfin - ${titleText}`]);
            sendMpvCommand('set_property', ['title', `Jellyfin - ${titleText}`]);
            beginPlaybackReporting(currentItemId);
            pushOscState();
        }).catch(err => {
            log('error', 'episode', '⚠️ Error getting episode info:', err.message);
            beginPlaybackReporting(currentItemId);
        });
        sendMpvCommand('playlist-prev');
        return;
    }

    if (!currentEpisodeInfo || !currentEpisodeInfo.isSeries) {
        log('info', 'queue', 'ℹ️ Not a series, ignoring Previous command.');
        isPlayingNext = false;
        return;
    }

    if (!currentEpisodeInfo.previousEpisode) {
        log('info', 'queue', 'ℹ️ This is the first episode.');
        isPlayingNext = false;
        return;
    }

    const prevEp = currentEpisodeInfo.previousEpisode;
    const prevTitle = [currentEpisodeInfo.seriesName, `${currentEpisodeInfo.seasonNumber}x${prevEp.IndexNumber}`, prevEp.Name].filter(Boolean).join(' - ');
    log('info', 'queue', `◀️ Starting previous episode: ${prevTitle}`);
    // Use playMedia for cross-season previous to avoid queue desync
    playQueue = [prevEp.Id];
    queuePosition = 0;
    playMedia(prevEp.Id, 0).catch(err => {
        log('error', 'episode', '⚠️ Error playing previous episode:', err.message);
        isPlayingNext = false;
    });
    return;
}

// Kick off reporting for an item a transition jumped to. Paths that update
// queuePosition/currentItemId THEMSELVES (manual next/prev, in-season advance,
// NextUp) bypass the playlist-pos handler's transition block — its guard is
// newPos !== queuePosition, which is already false by the time the event lands.
// Those paths must call this explicitly or the server never hears the new
// playback started (STOP for the old item, only PROGRESS for the new one —
// scrobblers miss it and every later report carries a stale playSessionId).
function beginPlaybackReporting(itemId) {
    playSessionId = crypto.randomUUID();
    reportPlaybackStart(itemId, 0);
    startProgressReporting(itemId);
}

function reportPlaybackStart(itemId, positionTicks) {
    // A new playback re-enables progress reporting — this is the ONLY place
    // "stopped" state is lifted, so a late progress POST can never resurrect
    // the session after the stop report.
    isStoppingPlayback = false;
    isReportingStop = false;
    const headers = getAuthHeaders();
    
    const data = {
        ItemId: itemId,
        MediaSourceId: itemId,
        PositionTicks: positionTicks,
        IsPaused: isMpvPaused,
        IsMuted: isMuted,
        VolumeLevel: volumeLevel,
        PlayMethod: 'DirectPlay',
        PlaySessionId: playSessionId,
        CanSeek: true,
        RepeatMode: currentRepeatMode,
        PlaybackOrder: currentPlaybackOrder,
        AudioStreamIndex: pendingAudioStreamIndex,
        SubtitleStreamIndex: pendingSubtitleStreamIndex !== undefined
            ? (pendingSubtitleStreamIndex === 'no' ? -1 : pendingSubtitleStreamIndex)
            : (typeof currentSubtitleTrack === 'number'
                ? mpvTrackIdToJellyfinIndex(currentSubtitleTrack, 'Subtitle')
                : (currentSubtitleTrack === false || currentSubtitleTrack === 'no' ? -1 : undefined))
    };

    log('info', 'report', '📡 Reporting playback start...');
    
    return chainReport(() => axios.post(`${CONFIG.serverUrl}/Sessions/Playing`, data, { headers, timeout: 10000 })
        .then(() => {
            log('info', 'report', '✅ Playback start reported');
        })
        .catch(e => {
            const status = e.response?.status || 'unknown';
            const body = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            log('error', 'report', `⚠️ Error reporting start (${status}):`, body);
        })
    );
}

function startProgressReporting(itemId) {
    if (progressInterval) {
        clearInterval(progressInterval);
    }

    progressInterval = setInterval(() => {
        if (!mpvProcess || !currentItemId) {
            clearInterval(progressInterval);
            progressInterval = null;
            return;
        }

        const currentTicks = Math.round(currentPositionSeconds * 10000000);
        if (currentPositionSeconds > 10) {
            savePlaybackPosition(currentItemId, currentTicks);
        }
        // Report progress to server to keep session alive
        reportPlaybackProgress(currentItemId, currentTicks);
    }, 10000);
}

function reportPlaybackProgress(itemId, positionTicks) {
    if (isStoppingPlayback) return; // never let a progress report resurrect a stopped session
    const headers = getAuthHeaders();
    
    const data = {
        ItemId: itemId,
        MediaSourceId: itemId,
        PositionTicks: positionTicks,
        IsPaused: isMpvPaused,
        IsMuted: isMuted,
        VolumeLevel: volumeLevel,
        PlayMethod: 'DirectPlay',
        PlaySessionId: playSessionId,
        CanSeek: true,
        RepeatMode: currentRepeatMode,
        PlaybackOrder: currentPlaybackOrder,
        AudioStreamIndex: typeof currentAudioTrack === 'number'
            ? mpvTrackIdToJellyfinIndex(currentAudioTrack, 'Audio')
            : (currentAudioTrack === false ? -1 : undefined),
        SubtitleStreamIndex: typeof currentSubtitleTrack === 'number'
            ? mpvTrackIdToJellyfinIndex(currentSubtitleTrack, 'Subtitle')
            : (currentSubtitleTrack === false || currentSubtitleTrack === 'no' ? -1 : undefined)
    };

    // Serialized on the shared chain so reports reach the server in call order.
    return chainReport(() =>
        axios.post(`${CONFIG.serverUrl}/Sessions/Playing/Progress`, data, { headers, timeout: 10000 })
            .catch(e => {
                log('error', 'report', '⚠️ Failed to report progress:', e.message);
            })
    );
}

function reportPlaybackStop(itemId, positionTicks) {
    if (!itemId || isReportingStop) {
        return Promise.resolve();
    }
    
    isReportingStop = true;
    isStoppingPlayback = true;
    
    const headers = getAuthHeaders();
    
    const data = {
        ItemId: itemId,
        MediaSourceId: itemId,
        PositionTicks: positionTicks,
        PlaySessionId: playSessionId
    };

    log('info', 'report', `📡 Reporting playback stop (position: ${(positionTicks / 10000000).toFixed(2)}s)...`);
    
    // Serialized on the shared chain: the phantom-resume progress POST is
    // enqueued before the close handler's stop, so it lands first — and any
    // report enqueued later (there must be none until the next start) would
    // land after. isReportingStop stays set until reportPlaybackStart() — it
    // must NOT be cleared here or a late progress report would resurrect the
    // session.
    return chainReport(() =>
        axios.post(`${CONFIG.serverUrl}/Sessions/Playing/Stopped`, data, { headers, timeout: 10000 })
            .then(() => {
                log('info', 'report', '✅ Playback stop reported correctly');
            })
            .catch(e => {
                log('error', 'report', '⚠️ Error reporting stop:', e.message);
            })
    );
}

// jf-mpv-osc integration
function handleOscAction(verb, arg) {
    if (!verb) return;
    log('info', 'osc', `🎮 OSC action: ${verb}${arg !== undefined ? ' ' + arg : ''}`);
    switch (verb) {
        case 'skip-segment':
            skipIntro();
            break;
        case 'next-item':
            playNextEpisode();
            break;
        case 'prev-item':
            playPreviousEpisode();
            break;
        case 'set-sub':
            if (arg !== undefined) {
                // OSC track ids are Jellyfin stream indices (see pushOscState) — map to mpv sid
                requestedSubtitleStreamIndex = arg === '-1' || arg === -1 ? 'no' : Number(arg);
                requestedTrackItemId = currentItemId;
                const sid = arg === '-1' || arg === -1 ? 'no' : jellyfinStreamIndexToMpvId(Number(arg), 'Subtitle');
                sendMpvCommand('set_property', ['sid', sid]);
            }
            break;
        case 'set-audio':
            if (arg !== undefined) {
                requestedAudioStreamIndex = Number(arg);
                requestedTrackItemId = currentItemId;
                sendMpvCommand('set_property', ['aid', jellyfinStreamIndexToMpvId(Number(arg), 'Audio')]);
            }
            break;
        case 'set-sub-size':
            if (arg !== undefined) {
                // arg is percentage string from sub_style options (e.g., "100" = normal)
                const scale = Number(arg) / 100;
                sendMpvCommand('set_property', ['sub-scale', scale || 1.0]);
                pushOscState();
            }
            break;
        case 'set-sub-position':
            if (arg !== undefined) {
                // arg is position string from sub_style options ("top", "50", "100")
                // sub-pos moves both plain text and ASS subtitles (verified)
                const pos = arg === 'top' ? 0 : Number(arg) || 100;
                sendMpvCommand('set_property', ['sub-pos', pos]);
                pushOscState();
            }
            break;
        case 'set-sub-color':
            if (arg !== undefined) {
                // arg is hex color string from sub_style options (e.g., "#FFFFFF")
                sendMpvCommand('set_property', ['sub-color', arg]);
                // ASS/SSA subs ignore sub-color — recolour them via the style
                // override; push state once the override has landed so the
                // reported current colour reflects it
                setAssPrimaryColourOverride(arg).then(() => pushOscState());
            }
            break;
        case 'toggle-favorite':
            toggleFavorite();
            break;
        case 'screenshot':
            sendMpvCommand('screenshot');
            break;
        case 'set-fullscreen':
            // Notification from OSC — set to the requested state
            if (arg === 'yes') {
                sendMpvCommand('set_property', ['fullscreen', true]);
            } else if (arg === 'no') {
                sendMpvCommand('set_property', ['fullscreen', false]);
            } else {
                sendMpvCommand('cycle', ['fullscreen']);
            }
            break;
        case 'unwatched-quit':
            log('info', 'osc', '🎮 OSC unwatched quit — closing MPV');
            isUnwatchedQuit = true;
            isStoppingPlayback = true;
            sendMpvCommand('quit');
            break;
        case 'syncplay-refresh':
            log('info', 'syncplay', 'SyncPlay refresh requested');
            pushOscState();
            break;
        case 'syncplay-join':
            if (arg) {
                log('info', 'syncplay', `SyncPlay join group: ${arg}`);
                joinSyncPlayGroup(arg);
            }
            break;
        case 'syncplay-new':
            log('info', 'syncplay', 'SyncPlay create group');
            createSyncPlayGroup();
            break;
        case 'syncplay-disable':
            log('info', 'syncplay', 'SyncPlay leave group');
            leaveSyncPlayGroup();
            break;
        case 'syncplay-toggle-pause':
            log('info', 'syncplay', 'SyncPlay toggle pause');
            sendMpvCommand('cycle', ['pause']);
            break;
        default:
            log('debug', 'osc', `Unknown OSC action: ${verb} ${arg || ''}`);
    }
}

async function pushOscState(hasMedia = true) {
    if (!hasMedia) {
        sendMpvCommand('script-message', ['shim-jf-osc-state', JSON.stringify({ strings: {}, has_media: false })]);
        return;
    }
    if (!currentItemId || !mpvProcess) return;

    const hasPrev = playQueue.length > 0 && queuePosition > 0;
    const hasNext = playQueue.length > 0 && queuePosition < playQueue.length - 1;

    const state = {
        strings: {},
        has_media: true,
        allow_screenshot: true,
        queue: { has_prev: hasPrev, has_next: hasNext },
        favorite: currentEpisodeInfo?.userData?.IsFavorite || false
    };

    // Tier 1: Push subtitle and audio track lists from Jellyfin MediaStreams
    // Query current track selections from MPV
    const [currentSid, currentAid] = await Promise.all([
        queryProperty('sid').catch(() => null),
        queryProperty('aid').catch(() => null)
    ]);
    // Query results are mpv per-type track ids (or false when disabled) — translate
    // back to Jellyfin stream indices so the OSC track list ids/selected flags line up.
    const activeSub = currentSid !== null ? currentSid : currentSubtitleTrack;
    const activeAudio = currentAid !== null ? currentAid : null;
    const activeSubJf = (activeSub === false || activeSub === 'no' || activeSub === -1)
        ? -1
        : (typeof activeSub === 'number' ? mpvTrackIdToJellyfinIndex(activeSub, 'Subtitle') : undefined);
    const activeAudioJf = (activeAudio === false || activeAudio === 'no' || activeAudio === -1)
        ? -1
        : (typeof activeAudio === 'number' ? mpvTrackIdToJellyfinIndex(activeAudio, 'Audio') : undefined);

    if (Array.isArray(currentEpisodeInfo?.mediaStreams)) {
        const subtitles = currentEpisodeInfo.mediaStreams
            .filter(s => s.Type === 'Subtitle')
            .map(s => ({
                id: s.Index,
                label: s.DisplayTitle || s.Title || s.Language || `Track ${s.Index}`,
                selected: s.Index === activeSubJf
            }));
        if (subtitles.length > 0) {
            subtitles.unshift({ id: -1, label: 'Off', selected: activeSubJf === -1 });
            state.subtitles = subtitles;
        }

        const audio = currentEpisodeInfo.mediaStreams
            .filter(s => s.Type === 'Audio')
            .map(s => ({
                id: s.Index,
                label: s.DisplayTitle || s.Title || s.Language || `Track ${s.Index}`,
                selected: s.Index === activeAudioJf
            }));
        if (audio.length > 0) {
            state.audio = audio;
        }
    }

    // Tier 4: Subtitle styling options — query current values from MPV
    const [subScale, subPos, subColor, subTracks, assOverrides] = await Promise.all([
        queryProperty('sub-scale').catch(() => null),
        queryProperty('sub-pos').catch(() => null),
        queryProperty('sub-color').catch(() => null),
        queryProperty('track-list').catch(() => null),
        queryProperty('sub-ass-style-overrides').catch(() => null)
    ]);

    const currentScale = typeof subScale === 'number' ? Math.round(subScale * 100) : 100;
    const currentPos = typeof subPos === 'number' ? subPos : 100;
    // For ASS/SSA the visible colour is the subtitle style's PrimaryColour, not
    // sub-color — reporting "White" there would be false. Only report a colour
    // for styled subs when we (or the user's mpv.conf) forced one via
    // sub-ass-style-overrides; otherwise say "Style" and select nothing.
    const selectedSub = (Array.isArray(subTracks) ? subTracks : []).find(t => t && t.type === 'sub' && t.selected);
    const isAssSub = /ass|ssa/i.test(String((selectedSub && selectedSub.codec) || ''));
    const assColourOv = (Array.isArray(assOverrides) ? assOverrides : [])
        .map(String).find(e => /^(?:[^.=]+\.)?PrimaryColour=/i.test(e));
    let currentColor;
    if (isAssSub && !assColourOv) {
        currentColor = null;
    } else if (isAssSub && assColourOv) {
        // &H[AA]BBGGRR -> #RRGGBB
        const m = /PrimaryColour=&H([0-9a-f]+)/i.exec(assColourOv);
        const d = (m ? m[1] : '00ffffff').padStart(8, '0');
        currentColor = ('#' + d.slice(6, 8) + d.slice(4, 6) + d.slice(2, 4)).toUpperCase();
    } else {
        currentColor = normalizeSubColor(subColor);
    }

    state.sub_style = {
        size: { current: `${currentScale}%`, options: [
            { id: '50', label: 'Tiny', selected: currentScale === 50 },
            { id: '75', label: 'Small', selected: currentScale === 75 },
            { id: '100', label: 'Normal', selected: currentScale === 100 },
            { id: '125', label: 'Large', selected: currentScale === 125 },
            { id: '150', label: 'Huge', selected: currentScale === 150 }
        ]},
        position: { current: currentPos === 0 ? 'Top' : currentPos === 100 ? 'Bottom' : currentPos === 50 ? 'Middle' : `${Math.round(currentPos)}%`, options: [
            { id: 'top', label: 'Top', selected: currentPos === 0 },
            { id: '50', label: 'Middle', selected: currentPos === 50 },
            { id: '100', label: 'Bottom', selected: currentPos === 100 }
        ]},
        color: { current: currentColor === null ? 'Style' : currentColor === '#FFFFFF' ? 'White' : currentColor === '#FFFF00' ? 'Yellow' : currentColor === '#00FF00' ? 'Green' : currentColor === '#00FFFF' ? 'Cyan' : currentColor === '#FF0000' ? 'Red' : currentColor, options: [
            { id: '#FFFFFF', label: 'White', selected: currentColor === '#FFFFFF' },
            { id: '#FFFF00', label: 'Yellow', selected: currentColor === '#FFFF00' },
            { id: '#00FF00', label: 'Green', selected: currentColor === '#00FF00' },
            { id: '#00FFFF', label: 'Cyan', selected: currentColor === '#00FFFF' },
            { id: '#FF0000', label: 'Red', selected: currentColor === '#FF0000' }
        ]}
    };

    // Tier 4: SyncPlay state
    try {
        const syncplayState = await getSyncPlayState();
        if (syncplayState) {
            state.syncplay = syncplayState;
        }
    } catch (e) {
        // SyncPlay not available or error — omit from state
    }

    sendMpvCommand('script-message', ['shim-jf-osc-state', JSON.stringify(state)]);
}

function pushOscSkipButton(label) {
    sendMpvCommand('script-message', ['shim-jf-osc-skip', label || '']);
}

// SyncPlay API functions
async function getSyncPlayState() {
    const headers = getAuthHeaders();
    try {
        const response = await axios.get(`${CONFIG.serverUrl}/SyncPlay/List`, { headers, timeout: 5000 });
        const groups = response.data || [];
        const groupsList = groups.map(g => ({
            id: g.GroupId,
            label: g.GroupName || `Group ${g.GroupId}`,
            selected: g.GroupId === currentSyncPlayGroupId
        }));
        return {
            enabled: currentSyncPlayGroupId !== null,
            current: currentSyncPlayGroupName || 'None (Disabled)',
            groups: groupsList
        };
    } catch (e) {
        log('debug', 'syncplay', `Failed to get SyncPlay groups: ${e.message}`);
        return null;
    }
}

async function joinSyncPlayGroup(groupId) {
    const headers = getAuthHeaders();
    try {
        await axios.post(`${CONFIG.serverUrl}/SyncPlay/Join`, { GroupId: groupId }, { headers, timeout: 10000 });
        log('info', 'syncplay', `Joined SyncPlay group: ${groupId}`);
        // Server will send GroupJoined update, but set locally as fallback
        currentSyncPlayGroupId = groupId;
        pushOscState();
    } catch (e) {
        log('error', 'syncplay', `Failed to join SyncPlay group: ${e.message}`);
    }
}

async function leaveSyncPlayGroup() {
    const headers = getAuthHeaders();
    try {
        await axios.post(`${CONFIG.serverUrl}/SyncPlay/Leave`, {}, { headers, timeout: 10000 });
        log('info', 'syncplay', 'Left SyncPlay group');
        // Server will send GroupLeft update, but set locally as fallback
        currentSyncPlayGroupId = null;
        currentSyncPlayGroupName = null;
        pushOscState();
    } catch (e) {
        log('error', 'syncplay', `Failed to leave SyncPlay group: ${e.message}`);
    }
}

async function createSyncPlayGroup() {
    const headers = getAuthHeaders();
    try {
        await axios.post(`${CONFIG.serverUrl}/SyncPlay/New`, {}, { headers, timeout: 10000 });
        log('info', 'syncplay', 'Created new SyncPlay group');
        pushOscState();
    } catch (e) {
        log('error', 'syncplay', `Failed to create SyncPlay group: ${e.message}`);
    }
}

async function toggleFavorite() {
    if (!currentItemId) return;
    try {
        const headers = getAuthHeaders();
        const isFavorite = currentEpisodeInfo?.userData?.IsFavorite;
        if (isFavorite) {
            await axios.delete(`${CONFIG.serverUrl}/Users/${userId}/FavoriteItems/${currentItemId}`, { headers });
        } else {
            await axios.post(`${CONFIG.serverUrl}/Users/${userId}/FavoriteItems/${currentItemId}`, {}, { headers });
        }
        if (currentEpisodeInfo?.userData) {
            currentEpisodeInfo.userData.IsFavorite = !isFavorite;
        }
        pushOscState();
        log('info', 'osc', `${isFavorite ? '💔 Removed from' : '❤️ Added to'} favorites`);
    } catch (err) {
        log('error', 'osc', '⚠️ Error toggling favorite:', err.message);
    }
}

function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', 'main', `\n👋 Closing application (${signal})...`);
    
    // Clean up lock file
    const configBase = path.basename(configFile, path.extname(configFile));
    const lockFile = path.join(__dirname, 'data', `${configBase}.lock`);
    try {
        if (fs.existsSync(lockFile)) {
            const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            if (lockData.pid === process.pid) {
                fs.unlinkSync(lockFile);
            }
        }
    } catch (e) {
        // Ignore lock file errors
    }
    
    stopProgressPoll();
    for (const [, q] of pendingQueries) { if (q.timer) clearTimeout(q.timer); q.resolve(null); }
    pendingQueries.clear();
    for (const sock of Object.values(wsSockets)) {
        if (sock.reconnectInterval) { clearInterval(sock.reconnectInterval); sock.reconnectInterval = null; }
        if (sock.keepAliveInterval) { clearInterval(sock.keepAliveInterval); sock.keepAliveInterval = null; }
        if (sock.heartbeatInterval) { clearInterval(sock.heartbeatInterval); sock.heartbeatInterval = null; }
    }
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    
    const doUnwatched = !!(currentItemId && isUnwatchedQuit);
    if (!doUnwatched && currentItemId && currentPositionSeconds > 0) {
        savePlaybackPosition(currentItemId, Math.round(currentPositionSeconds * 10000000));
    }

    let doExitCalled = false;
    const doExit = () => {
        if (doExitCalled) return;
        doExitCalled = true;
        // Quit is initiated: the phantom pause=false during exit must not fire
        // a progress report (its POST could outlive the process and resurrect
        // the session on the server).
        isStoppingPlayback = true;
        // Try graceful quit first, then force kill after timeout
        if (mpvProcess && ipcClient && !ipcClient.destroyed) {
            sendMpvCommand('quit');
            setTimeout(() => {
                killMpv();
                sendWsMessage({ MessageType: 'SessionsStop' });
                closeAllWs();
                setTimeout(() => process.exit(0), 500);
            }, 1000);
        } else {
            killMpv();
            sendWsMessage({ MessageType: 'SessionsStop' });
            closeAllWs();
            setTimeout(() => process.exit(0), 500);
        }
    };

    // Unwatched-quit: the DELETE must land AFTER the stop report (Jellyfin's
    // stop handler writes UserData — a racing delete gets undone). It is
    // enqueued on the shared report chain so it is the last server write.
    let finishCalled = false;
    const finish = () => {
        if (finishCalled) return;
        finishCalled = true;
        if (doUnwatched) {
            chainReport(() => markItemAsUnwatched(currentItemId)).finally(doExit);
        } else {
            doExit();
        }
    };

    if (currentItemId && !isReportingStop) {
        const stopTimeout = setTimeout(finish, 3000);
        reportPlaybackStop(currentItemId, isUnwatchedQuit ? 0 : Math.round(currentPositionSeconds * 10000000))
            .finally(() => { clearTimeout(stopTimeout); finish(); });
    } else {
        finish();
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    if (isBrokenPipe(err)) {
        // Output pipe closed (parent torn down the pipes, `| head` exited, ...) —
        // not a crash and definitely not dialog-worthy (each further log line
        // would otherwise throw again: dialog storm). Keep running: playback must
        // not die because the log consumer left. A parent that wants us gone
        // sends SIGTERM, which is handled below.
        return;
    }
    log('error', 'main', '❌ Uncaught exception:', err);
    writeCrashLog('uncaughtException', err);
    showHeadlessErrorDialog('Uncaught Exception', `An unexpected error occurred:\n\n${err.message || err}`);
    shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    if (isBrokenPipe(reason)) {
        return;
    }
    if (isBrokenPipe(reason)) { return; }
    log('error', 'main', '❌ Unhandled rejection:', reason);
    writeCrashLog('unhandledRejection', reason);
    showHeadlessErrorDialog('Unhandled Rejection', `An unexpected error occurred:\n\n${reason?.message || reason}`);
    shutdown('unhandledRejection');
});

let lastCrashDialogAt = 0;
function writeCrashLog(type, error) {
    if (isBrokenPipe(error)) { return; }
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const crashFile = path.join(dataDir, 'crash.log');
        const timestamp = new Date().toISOString();
        const message = error instanceof Error ? error.stack || error.message : String(error);
        const logEntry = `[${timestamp}] ${type}\n${message}\n\n`;
        fs.appendFileSync(crashFile, logEntry);
        console.error(`Crash log written to: ${crashFile}`);

        // Rate-limit the dialog: a repeating failure must not spawn hundreds of
        // windows (observed with EPIPE dialog storms).
        const now = Date.now();
        if (now - lastCrashDialogAt < 30000) return;
        lastCrashDialogAt = now;
        const dialogMessage = `Jellyfin MPV Play crashed: ${type}\n\n${message.substring(0, 500)}`;
        showErrorDialog('Jellyfin MPV Play - Crash', dialogMessage);
    } catch (e) {
        // If we can't write the crash log, just continue with shutdown
    }
}

function showDuplicateInstanceDialog(message) {
    return new Promise((resolve) => {
        const { execFile } = require('child_process');
        
        if (process.platform === 'darwin') {
            // macOS: Use osascript for native dialog
            const escapedMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const script = `display dialog "${escapedMsg}" with title "Jellyfin MPV Play" buttons {"Stop", "Continue"} default button "Continue" with icon caution`;
            execFile('osascript', ['-e', script], (err, stdout) => {
                if (err) {
                    // User clicked Stop or dialog failed
                    resolve(false);
                } else {
                    resolve(stdout.includes('Continue'));
                }
            });
        } else if (process.platform === 'linux') {
            // Linux: Try zenity, then kdialog, then fall back to terminal prompt
            const escapedMsg = message.replace(/'/g, "'\\''");
            execFile('zenity', ['--question', '--title=Jellyfin MPV Play', `--text=${escapedMsg}`, '--ok-label=Continue', '--cancel-label=Stop', '--width=400'], (err) => {
                if (err) {
                    // zenity not available or user clicked Stop
                    if (err.code === 1 || err.killed) {
                        resolve(false);
                    } else {
                        // Try kdialog
                        execFile('kdialog', ['--yesno', escapedMsg, '--title', 'Jellyfin MPV Play'], (err2) => {
                            if (err2) {
                                resolve(false);
                            } else {
                                resolve(true);
                            }
                        });
                    }
                } else {
                    resolve(true);
                }
            });
        } else if (process.platform === 'win32') {
            // Windows: Use PowerShell message box
            const psScript = `
                Add-Type -AssemblyName System.Windows.Forms
                $result = [System.Windows.Forms.MessageBox]::Show('${message.replace(/'/g, "''")}', 'Jellyfin MPV Play', 'YesNo', 'Warning')
                if ($result -eq 'Yes') { exit 0 } else { exit 1 }
            `;
            execFile('powershell', ['-Command', psScript], (err) => {
                resolve(!err);
            });
        } else {
            // Unknown platform, default to continue
            resolve(true);
        }
    });
}

function showHeadlessErrorDialog(title, message) {
    if (!CONFIG.headless) return; // Only show dialogs in headless mode
    showErrorDialog(title, message);
}

function showErrorDialog(title, message) {
    // Test runs (and CI) must never raise dialogs on someone's desktop —
    // a test whose config is deliberately broken would spam the user.
    if (process.env.JELLYFIN_MPV_NO_DIALOGS === '1') return;
    const { execFile } = require('child_process');
    const fullMessage = `${title}\n\n${message}`;
    
    if (process.platform === 'darwin') {
        const escapedMsg = fullMessage.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const script = `display dialog "${escapedMsg}" with title "Jellyfin MPV Play" buttons {"OK"} default button "OK" with icon stop`;
        execFile('osascript', ['-e', script], () => {});
    } else if (process.platform === 'linux') {
        const escapedMsg = fullMessage.replace(/'/g, "'\\''");
        execFile('zenity', ['--error', '--title=Jellyfin MPV Play', `--text=${escapedMsg}`, '--width=400'], (err) => {
            if (err) {
                // zenity not available, try kdialog
                execFile('kdialog', ['--error', escapedMsg, '--title', 'Jellyfin MPV Play'], () => {});
            }
        });
    } else if (process.platform === 'win32') {
        const psScript = `
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show('${fullMessage.replace(/'/g, "''")}', 'Jellyfin MPV Play', 'OK', 'Error')
        `;
        execFile('powershell', ['-Command', psScript], () => {});
    }
}

// A previous instance killed without cleanup (force-quit, crash) leaves its
// mpv alive on our IPC socket forever (--idle --keep-open). Before doing
// anything else, tell any such leftover to quit: we are the only legitimate
// user of this socket (multi-config setups give each config its own).
function reapOrphanedMpv() {
    return new Promise(resolve => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            try { client.destroy(); } catch {}
            resolve();
        };
        const client = net.connect(CONFIG.ipcSocketPath);
        client.setTimeout(1500, done);
        client.on('connect', () => {
            log('warn', 'mpv', '⚠️ Found a leftover mpv on our IPC socket — quitting it');
            try { client.write(JSON.stringify({ command: ['quit'] }) + '\n'); } catch {}
            setTimeout(done, 800);
        });
        client.on('error', done);
    });
}

async function main() {
    log('info', 'main', '\n🚀 Starting Jellyfin MPV Shim...\n');

    // Clean up after a previous instance that died without running shutdown()
    await reapOrphanedMpv();
    
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { mode: 0o700 });
    }

    // Check for existing instance with same config
    const allowDuplicates = args.includes('--allow-duplicates');
    const configBase = path.basename(configFile, path.extname(configFile));
    const lockFile = path.join(dataDir, `${configBase}.lock`);
    try {
        if (fs.existsSync(lockFile)) {
            const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            // Check if the process is still running
            try {
                process.kill(lockData.pid, 0); // Signal 0 checks if process exists
                if (allowDuplicates) {
                    log('info', 'main', `ℹ️ Another instance is running (PID: ${lockData.pid}), --allow-duplicates specified`);
                } else {
                    const message = `Another instance is already running.\n\nConfig: ${configFile}\nPID: ${lockData.pid}\nStarted: ${lockData.started}\n\nWhat would you like to do?`;
                    const shouldContinue = await showDuplicateInstanceDialog(message);
                    if (!shouldContinue) {
                        log('info', 'main', '❌ User chose to exit due to duplicate instance');
                        process.exit(0);
                    }
                    log('info', 'main', 'ℹ️ User chose to continue with duplicate instance');
                }
            } catch (e) {
                // Process not running, stale lock file
                fs.unlinkSync(lockFile);
            }
        }
    } catch (e) {
        // Ignore lock file errors
    }

    // Write lock file
    try {
        fs.writeFileSync(lockFile, JSON.stringify({
            pid: process.pid,
            config: configFile,
            started: new Date().toISOString()
        }));
    } catch (e) {
        // Ignore lock file errors
    }
	
    const hasToken = loadToken();
    
    if (!hasToken || !accessToken) {
        const authenticated = await authenticateUser();
        if (!authenticated) {
            log('error', 'main', '❌ Could not authenticate. Check your CONFIG credentials.');
            showHeadlessErrorDialog('Authentication Failed', 'Could not authenticate with Jellyfin server.\n\nCheck your config.js credentials and try again.');
            process.exit(1);
        }
    } else {
        // Validate the saved token up front. Jellyfin access tokens expire, and a
        // stale one would otherwise only fail at WebSocket connect (403) followed
        // by a reconnect backoff — a blind delay at every startup.
        try {
            await axios.get(`${CONFIG.serverUrl}/System/Info`, { headers: getAuthHeaders(), timeout: 5000 });
        } catch (e) {
            if (e.response && (e.response.status === 401 || e.response.status === 403)) {
                log('info', 'auth', '🔐 Saved token rejected (expired) — re-authenticating');
                const authenticated = await authenticateUser();
                if (!authenticated) {
                    log('error', 'main', '❌ Re-authentication failed. Check your CONFIG credentials.');
                    showHeadlessErrorDialog('Authentication Failed', 'Saved login expired and re-authentication failed.\n\nCheck your config.js credentials and try again.');
                    process.exit(1);
                }
            }
            // Network errors fall through — the reconnect probe loop handles them
        }
    }
    
    ensureSocketsConnected();
    
    log('info', 'main', '\n✅ Script started correctly');
    log('info', 'main', '💡 Open Jellyfin in your browser and use "Play on" to select this device.');
    log('info', 'main', '💾 Local position system active');
    log('info', 'main', '🔄 Automatic reconnection enabled with Exponential Backoff');
    log('info', 'main', '⏭️ Use media keys or > and < keys to change episodes.\n');
}

main().catch(error => {
    log('error', 'main', '❌ Fatal error!:', error);
    showHeadlessErrorDialog('Fatal Error', `Jellyfin MPV Play encountered a fatal error:\n\n${error.message || error}`);
    process.exit(1);
});
