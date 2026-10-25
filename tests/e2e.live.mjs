// Live end-to-end test suite. Exercises the shim against a REAL Jellyfin server
// and a REAL mpv, asserting on shim logs, mpv IPC properties, and Jellyfin API
// state. Opt-in (not part of `npm test`, needs a working config.js):
//
//     npm run test:e2e            run everything
//     npm run test:e2e -- --only 9,16   run selected test numbers
//
// The suite plays NextUp items and rewrites UserData (played/position/
// favorite) around every test. It REFUSES to run while another session is
// actively playing on the account (--force overrides) — running it alongside a
// live viewer fights their watch marks and floods their web UI with
// UserDataChanged churn.
//
// The suite runs headless (vo=null/ao=null via mpvFlags) on an isolated session
// (own deviceId + own IPC socket) so it never touches a production device or
// pops up windows. Everything the run mutates on the server (Played, resume
// position, favorite, PlayCount, SyncPlay groups) and locally (tokens, logs,
// locks) is snapshotted and restored/removed in teardown().
import { spawn, execSync } from 'child_process';
import net from 'net';
import http from 'http';
import https from 'https';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { createRequire } = await import('module');
const cfg = createRequire(import.meta.url)(path.join(ROOT, 'config.js'));

const TEST_ID = `e2e-live-suite-${process.pid}`;  // unique per run: concurrent runs must not collide
const TEST_NAME = 'E2E Live Suite';
const IPC_SOCK = `/tmp/mpv-e2e-live-${process.pid}.sock`;
const TMP_CONFIG = path.join(os.tmpdir(), `e2e-live-${Date.now()}.js`);
const ONLY = (process.argv.find(a => a.startsWith('--only')) ? (process.argv[process.argv.indexOf('--only') + 1] || '').split(',').map(Number) : null);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- tiny assert runner ----------
const results = [];
let current = { name: '', ok: true, details: [] };
function check(cond, msg) {
    if (!cond) {
        current.ok = false;
        current.details.push(msg);
        throw new Error(msg);
    }
}
function eq(a, b, msg) { check(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function near(a, b, tol, msg) { check(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b} ±${tol})`); }
// A fixture-dependent early return. Skips are counted and reported SEPARATELY
// from passes — a test that exercised nothing must never read as ✅ PASS (tests
// 18/19 once no-op'd on a last-in-season fixture and still claimed success).
function skip(msg) { current.skipped = true; current.details.push(msg); }

// ---------- Jellyfin API ----------
const api = axios.create({ baseURL: cfg.serverUrl, timeout: 15000 });
let authHeaders;
async function login(deviceId) {
    const r = await netRetry(() => api.post('/Users/AuthenticateByName', { Username: cfg.username, Pw: cfg.password }, {
        headers: { 'Content-Type': 'application/json', Authorization: `MediaBrowser Client="${TEST_NAME}", Device="${TEST_NAME}", DeviceId="${deviceId}", Version="1.0.0"` }
    }));
    return { Authorization: `MediaBrowser Token="${r.data.AccessToken}", Client="${TEST_NAME}", Device="${TEST_NAME}", DeviceId="${deviceId}", Version="1.0.0"`, userId: r.data.User.Id };
}
const netRetry = async (fn) => {
    try { return await fn(); } catch (e) {
        // transient network blips are common against a remote server (seen:
        // ETIMEDOUT flaps and TLS "wrong version number" on half-dead
        // connections) — retry once on anything transport-level before failing
        if (/ECONNRESET|ECONNABORTED|ETIMEDOUT|EPROTO|EPIPE|socket hang up|network|timeout/i.test(`${e.code || ''} ${e.message}`)) {
            await sleep(1500);
            return await fn();
        }
        throw e;
    }
};
const get = (url, params) => netRetry(() => api.get(url, { headers: authHeaders, params, paramsSerializer: { indexes: null }, validateStatus: () => true }));
const post = (url, body, params) => netRetry(() => api.post(url, body ?? {}, { headers: authHeaders, params, paramsSerializer: { indexes: null }, validateStatus: () => true }));
const del = (url) => api.delete(url, { headers: authHeaders, validateStatus: () => true });

async function findSession() {
    // The server drops a session from /Sessions while its WebSocket is down
    // (blips make the shim go through its reconnect backoff, by design) —
    // wait for it to reappear instead of failing every follow-up test.
    for (let i = 0; i < 30; i++) {
        const r = await get('/Sessions');
        const ses = (r.data || []).find(s => s.DeviceId === TEST_ID);
        if (ses) return ses;
        await sleep(1500);
    }
    return undefined;
}
async function playItem(itemId, { startTicks, playCommand, startIndex, audioStreamIndex, subtitleStreamIndex } = {}) {
    const ses = await findSession();
    check(ses, 'test session not found');
    void 0;
    const params = { playCommand: playCommand || 'PlayNow', itemIds: itemId };
    if (startTicks !== undefined) params.startPositionTicks = startTicks;
    if (startIndex !== undefined) params.startIndex = startIndex;
    if (audioStreamIndex !== undefined) params.audioStreamIndex = audioStreamIndex;
    if (subtitleStreamIndex !== undefined) params.subtitleStreamIndex = subtitleStreamIndex;
    const r = await post(`/Sessions/${ses.Id}/Playing`, null, params);
    check(r.status < 400, `Play request rejected: ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
    return r;
}
async function playstate(cmd, extra = {}) {
    const ses = await findSession();
    const r = await post(`/Sessions/${ses.Id}/Playing/${cmd}`, null, extra);
    check(r.status < 400, `Playstate ${cmd} rejected: ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
    return r;
}
async function generalCmd(name, args = {}) {
    const ses = await findSession();
    // Argument values are strings on the wire (ClientCapabilities/GeneralCommand)
    const strArgs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]));
    const r = await post(`/Sessions/${ses.Id}/Command`, { Name: name, Arguments: strArgs });
    check(r.status < 400, `GeneralCommand ${name} rejected: ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
    return r;
}

// ---------- leave Jellyfin as we found it ----------
const userDataSnapshots = new Map(); // itemId -> pre-run UserData subset
const GUID_RE = /^[a-f0-9]{32}$/i;
async function snapshotUserData(itemId) {
    // only skip when a VALID snapshot exists — a walk-time "unreadable" record
    // must get another chance for items that actually get played
    if (!itemId || userDataSnapshots.get(itemId)) return;
    let u = null;
    for (let i = 0; i < 3 && !u; i++) {
        const r = await get(`/Users/${authHeaders.userId}/Items/${itemId}`, { fields: 'UserData' });
        if (r.status === 200 && r.data && r.data.UserData) u = r.data.UserData;
        else await sleep(250 * (i + 1)); // bursts get throttled — pace and retry
    }
    if (!u) {
        // unreadable (segment/media-source id / missing item / persistent error):
        // record NOTHING so teardown can never write guessed zeros over real state
        userDataSnapshots.set(itemId, null);
        return;
    }
    userDataSnapshots.set(itemId, {
        Played: !!u.Played,
        PlaybackPositionTicks: u.PlaybackPositionTicks || 0,
        IsFavorite: !!u.IsFavorite,
        PlayCount: u.PlayCount || 0,
        LastPlayedDate: u.LastPlayedDate || null
    });
}
async function restoreUserData() {
    let restored = 0, skipped = 0, bad = 0;
    for (const [itemId, u] of userDataSnapshots) {
        if (!u) { skipped++; continue; }
        const body = { ItemId: itemId, UserId: authHeaders.userId, ...u };
        const r = await post(`/Users/${authHeaders.userId}/Items/${itemId}/UserData`, body);
        let a = null;
        for (let i = 0; i < 3 && !a; i++) {
            const after = await get(`/Users/${authHeaders.userId}/Items/${itemId}`, { fields: 'UserData' });
            if (after.status === 200 && after.data && after.data.UserData) a = after.data.UserData;
            else await sleep(400);
        }
        const ok = r.status < 400 && a && !!a.Played === u.Played
            && (a.PlaybackPositionTicks || 0) === u.PlaybackPositionTicks
            && !!a.IsFavorite === u.IsFavorite && (a.PlayCount || 0) === u.PlayCount;
        if (ok) { restored++; continue; }
        bad++;
        console.log(` restore MISMATCH ${itemId} status=${r.status} sent=${JSON.stringify(u)} got=${JSON.stringify(a)}`);
    }
    console.log(` restored UserData: ${restored} ok, ${skipped} skipped (unreadable/non-item), ${bad} mismatched`);
}
async function teardown() {
    try {
        // leave any SyncPlay group BEFORE the sessions die: a dead member pins
        // the group on the server indefinitely
        if (shimProc) {
            try { await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-disable'); await sleep(400); } catch {}
        }
        try { await post('/SyncPlay/Leave'); } catch {}
        await stopShim();
        if (authHeaders && userDataSnapshots.size) await restoreUserData();
        // end the runner session so it does not linger on the server
        try { await post('/Sessions/Logout'); } catch {}
        // local artifacts of THIS run only (concurrent runs stay untouched)
        const configBase = path.basename(TMP_CONFIG, '.js');
        for (const f of [
            TMP_CONFIG,
            path.join(ROOT, 'data', `jellyfin_token_${TEST_ID}.json`),
            path.join(ROOT, 'data', `playback_positions_${TEST_ID}.json`),
            path.join(ROOT, 'data', `shim-${configBase}.log`),
            path.join(ROOT, 'data', `shim-${configBase}-${process.pid}.log`),
            path.join(ROOT, 'data', `${configBase}.lock`),
        ]) { try { fs.unlinkSync(f); } catch {} }
        // stale artifacts of older runs (>24h) — never a live concurrent run's
        const dayAgo = Date.now() - 24 * 3600 * 1000;
        for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
            if (!/e2e/i.test(f)) continue;
            const fp = path.join(ROOT, 'data', f);
            try { if (fs.statSync(fp).mtimeMs < dayAgo) fs.unlinkSync(fp); } catch {}
        }
        try { execSync(`pkill -f "mpv-e2e-live-${process.pid}" 2>/dev/null`); } catch {}
        if (ipc) try { ipc.destroy(); } catch {}
    } catch (e) {
        console.log('teardown error:', e.message);
    }
}

// A run that dies before teardown leaves its mpv alive forever (--idle
// --keep-open). At startup, reap any test mpv whose owning run is dead.
// Live runs are identified by their (live) pid in the socket name, so
// concurrent runs are never touched.
function reapStaleTestMpvs() {
    let names = [];
    try { names = fs.readdirSync('/tmp'); } catch { return; }
    for (const f of names) {
        const m = /^mpv-e2e-live-(\d+)\.sock$/.exec(f);
        if (!m) continue;
        const pid = Number(m[1]);
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        if (alive) continue;
        try { execSync(`pkill -f "mpv-e2e-live-${pid}" 2>/dev/null`); } catch {}
        try { fs.unlinkSync(path.join('/tmp', f)); } catch {}
        console.log(`reaped stale test mpv (dead run ${pid})`);
    }
}

// ---------- shim process ----------
let shimProc, shimOut = '';
function startShim(configPath = TMP_CONFIG) {
    shimOut = '';
    shimProc = spawn('node', ['shim.js', configPath], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        // never let a test shim raise an error dialog on the user's desktop
        env: { ...process.env, JELLYFIN_MPV_NO_DIALOGS: '1' }
    });
    shimProc.stdout.on('data', d => shimOut += d);
    shimProc.stderr.on('data', d => shimOut += d);
}
async function waitFor(pattern, timeoutMs = 20000, label) {
    const t0 = Date.now();
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    while (Date.now() - t0 < timeoutMs) {
        if (re.test(shimOut)) return;
        await sleep(150);
    }
    check(false, `timeout waiting for ${label || pattern} — tail: ...${shimOut.slice(-500)}`);
}
async function stopShim() {
    if (!shimProc) return;
    shimProc.kill('SIGTERM');
    await sleep(1500);
    try { shimProc.kill('SIGKILL'); } catch {}
    shimProc = null;
    try { execSync(`pkill -f "mpv-e2e-live-${process.pid}" 2>/dev/null`); } catch {}
}

function markLog() { return shimOut.length; }
async function waitForSince(mark, pattern, timeoutMs = 30000, label) {
    const t0 = Date.now();
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    while (Date.now() - t0 < timeoutMs) {
        if (re.test(shimOut.slice(mark))) return;
        await sleep(150);
    }
    check(false, `timeout waiting for ${label || pattern} — tail: ...${shimOut.slice(-400)}`);
}
// Play an item and wait until mpv has DEFINITELY loaded it (the "File loaded by
// MPV" contract line). Polling `path` alone is not enough: the path updates when
// loading starts, and seeks sent during loading are dropped.
async function playAndWait(itemId, opts) {
    await snapshotUserData(itemId);
    const m = markLog();
    await playItem(itemId, opts);
    // Match the load for THIS play command only — a previous test's in-flight
    // transition can emit its own "File loaded by MPV" after our mark.
    await waitForSince(m, 'Play command data', 15000);
    const m2 = markLog();
    await waitForSince(m2, 'File loaded by MPV', 40000);
    await connectIpcWhenReady();
    await waitForMpvPath(itemId);
    await sleep(500);
}
// mpv rejects seeks while a file is still loading ("error running command") —
// retry until accepted. Success resolves to the command's data (null for seek);
// failures resolve to { __error }.
async function seekWhenReady(target, flags = 'absolute') {
    for (let i = 0; i < 25; i++) {
        const r = await mpvCmd('seek', target, flags);
        if (!r || !r.__error) { await sleep(350); return; }
        await sleep(300);
    }
    check(false, `mpv never accepted seek to ${target}`);
}

// ---------- mpv IPC (the suite's own socket) ----------
let ipc = null, ipcBuf = '', ipcId = 1;
const ipcPending = new Map();
const ipcEvents = [];  // shim-jf-osc-state broadcasts, as jf-mpv-osc receives them
function ipcConnect() {
    return new Promise((resolve, reject) => {
        ipc = net.connect(IPC_SOCK);
        ipc.on('data', d => {
            ipcBuf += d.toString();
            const lines = ipcBuf.split('\n');
            ipcBuf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let r; try { r = JSON.parse(line); } catch { continue; }
                if (r.event === 'client-message' && r.args && r.args[0] === 'shim-jf-osc-state') {
                    ipcEvents.push(r);
                }
                if (r.request_id !== undefined && ipcPending.has(r.request_id)) {
                    const p = ipcPending.get(r.request_id);
                    ipcPending.delete(r.request_id);
                    p.resolve(r.error === 'success' ? r.data : { __error: r.error });
                }
            }
        });
        ipc.on('close', () => { ipc = null; });
        ipc.on('connect', resolve);
        ipc.on('error', reject);
    });
}
function mpvCmd(command, ...args) {
    return new Promise(resolve => {
        if (!ipc || ipc.destroyed) { resolve({ __error: 'no-ipc' }); return; }
        const id = ipcId++;
        const t = setTimeout(() => { ipcPending.delete(id); resolve({ __error: 'timeout' }); }, 4000);
        ipcPending.set(id, { resolve: v => { clearTimeout(t); resolve(v); } });
        ipc.write(JSON.stringify({ command: [command, ...args], request_id: id }) + '\n');
    });
}
const mpvGet = (p) => mpvCmd('get_property', p);
const mpvSet = (p, v) => mpvCmd('set_property', p, v);
// NOTE: mpv's `filename` property is only the last path component (for stream
// URLs that is "stream?static=true&ApiKey=..."), so identity checks must use `path`.
function itemIdOf(p) {
    const m = /\/Videos\/([a-f0-9]+)/i.exec(String(p || ''));
    return m ? m[1] : String(p || '');
}
async function mpvPlaylist() {
    const n = await mpvGet('playlist-count');
    const out = [];
    for (let i = 0; i < (n || 0); i++) out.push(itemIdOf(await mpvGet(`playlist/${i}/filename`)));
    return out;
}
async function waitForMpvPath(expectedId, timeoutMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const p = await mpvGet('path');
        // `duration` only exists once the file is actually loaded — matching `path`
        // alone races the load (it updates when loading STARTS)
        const d = await mpvGet('duration');
        if (typeof p === 'string' && (!expectedId || p.includes(expectedId)) && typeof d === 'number' && d > 0) return p;
        await sleep(250);
    }
    check(false, `mpv never finished loading ${expectedId || 'a file'} (last: ${JSON.stringify(await mpvGet('path'))}, dur: ${JSON.stringify(await mpvGet('duration'))})`);
}
async function connectIpcWhenReady(timeoutMs = 25000) {
    if (ipc && !ipc.destroyed) return;
    ipc = null;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (fs.existsSync(IPC_SOCK)) {
            try { await ipcConnect(); return; } catch {}
        }
        await sleep(250);
    }
    check(false, 'test IPC socket never appeared');
}

// ---------- config fixture ----------
// Escape for a JS single-quoted string: backslashes first, then quotes.
const jsStr = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
function writeConfig({ autoClose = false, headless = true, extraMpvFlags = [], serverUrl = cfg.serverUrl, apiKey = '' } = {}) {
    const flags = ['--vo=null', '--ao=null', '--force-window=no', ...extraMpvFlags]
        .map(f => `'${jsStr(f)}'`).join(', ');
    fs.writeFileSync(TMP_CONFIG, `module.exports = {
    serverUrl: '${jsStr(serverUrl)}',
    username: '${jsStr(cfg.username)}',
    password: '${jsStr(cfg.password)}',
    apiKey: '${jsStr(apiKey)}',
    mpvPath: '${jsStr(cfg.mpvPath)}',
    deviceName: '${TEST_NAME}',
    deviceId: '${TEST_ID}',
    ipcSocketPath: '${IPC_SOCK}',
    mpvFlags: [${flags}],
    headless: ${headless},
    verbose: true,
    autoClose: ${autoClose},
};
`);
}

// ---------- discovery ----------
async function discoverItems() {
    const items = {};
    const movies = await get(`/Users/${authHeaders.userId}/Items`, { IncludeItemTypes: 'Movie', Limit: 5, Fields: 'MediaStreams,RunTimeTicks' });
    items.movie = (movies.data.Items || [])[0];
    items.movie2 = (movies.data.Items || [])[1];
    check(items.movie && items.movie2, 'need at least 2 movies in library');

    // multi-track item: >=2 subtitle streams or >=2 audio streams
    const episodes = await get(`/Users/${authHeaders.userId}/Items`, { IncludeItemTypes: 'Episode', Limit: 30, Fields: 'MediaStreams,RunTimeTicks' });
    for (const it of episodes.data.Items || []) {
        // ParentIndexNumber > 0: specials (season 0) are deliberately redirected by
        // the shim to the NextUp episode of the regular season, so they cannot be
        // used as fixtures for "play THIS item" assertions.
        if (!(it.ParentIndexNumber > 0)) continue;
        const streams = it.MediaStreams || [];
        const subs = streams.filter(s => s.Type === 'Subtitle');
        const auds = streams.filter(s => s.Type === 'Audio');
        if (!items.multiTrack && (subs.length >= 2 || auds.length >= 2)) items.multiTrack = { ...it, subs, auds };
        if (items.multiTrack && items.multiTrack.subs.length >= 2 && items.multiTrack.auds.length >= 2) break;
    }
    check(items.multiTrack, 'no multi-track episode in library');

    // an episode with a season behind it (for queue/advance tests) + segments.
    // Prefer one with a FOLLOWING episode in the season: tests 18/19 (next-up,
    // auto-advance) exercise seasonList[seasonIndex + 1] and were silently
    // skipping whenever discovery happened to pick the season's last episode.
    const nextUp = await get('/Shows/NextUp', { userId: authHeaders.userId, limit: 5 });
    let fallback = null;
    for (const ep of nextUp.data.Items || []) {
        const full = await get(`/Users/${authHeaders.userId}/Items/${ep.Id}`, { fields: 'MediaStreams,RunTimeTicks,UserData' });
        const segs = await get(`/MediaSegments/${ep.Id}`, { includeSegmentTypes: ['Intro', 'Outro'] });
        const season = await get(`/Shows/${full.data.SeriesId}/Episodes`, { seasonId: full.data.SeasonId, userId: authHeaders.userId, fields: 'IndexNumber,RunTimeTicks' });
        const list = (season.data.Items || []).sort((a, b) => a.IndexNumber - b.IndexNumber);
        const idx = list.findIndex(e => e.Id === ep.Id);
        if (idx >= 0 && list.length >= 2 && list.every(e => e.ParentIndexNumber > 0)) {
            const cand = { full: full.data, segs: segs.data.Items || [], list, idx };
            if (idx < list.length - 1) {
                items.episode = { ...full.data, seasonList: list, seasonIndex: idx, segments: cand.segs };
                // Same id set the shim's expansion uses; specials-free so a shuffled
                // first item cannot trigger the season-0 NextUp redirect.
                items.shuffleSeason = list;
                break;
            }
            if (!fallback) fallback = cand;
        }
    }
    if (!items.episode && fallback) {
        // NextUp can point at a season's last episode (e.g. after earlier runs
        // marked the middle ones played). The fixture only needs SOME episode
        // with a follower — step one back within the same season.
        let f = fallback;
        if (f.idx > 0) {
            const prev = f.list[f.idx - 1];
            const full = await get(`/Users/${authHeaders.userId}/Items/${prev.Id}`, { fields: 'MediaStreams,RunTimeTicks,UserData' });
            const segs = await get(`/MediaSegments/${prev.Id}`, { includeSegmentTypes: ['Intro', 'Outro'] });
            f = { full: full.data, segs: segs.data.Items || [], list: f.list, idx: f.idx - 1 };
        }
        items.episode = { ...f.full, seasonList: f.list, seasonIndex: f.idx, segments: f.segs };
        items.shuffleSeason = f.list;
    }
    check(items.episode, 'no NextUp episode with a multi-episode season found');

    // a series whose episode list mixes specials and regular episodes — used to
    // pin the "series play starts past specials, explicit special plays itself" rule
    const allSeries = await get(`/Users/${authHeaders.userId}/Items`, { IncludeItemTypes: 'Series', Limit: 50 });
    for (const s of allSeries.data.Items || []) {
        const eps = await get(`/Shows/${s.Id}/Episodes`, { userId: authHeaders.userId, fields: 'ParentIndexNumber,UserData' });
        const list = eps.data.Items || [];
        const specials = list.filter(e => e.ParentIndexNumber === 0);
        const regulars = list.filter(e => e.ParentIndexNumber > 0);
        if (specials.length > 0 && regulars.length > 0) {
            items.seriesWithSpecials = { id: s.Id, name: s.Name, specialId: specials[0].Id, regularIds: regulars.map(e => e.Id) };
            break;
        }
    }
    // an item with ASS/SSA subs (colour comes from the style, sub-color is
    // ignored) and one with plain-text subs (sub-color applies) — the two cases
    // the sub_style controls must be verified against
    for (const it of episodes.data.Items || []) {
        const subs = (it.MediaStreams || []).filter(s => s.Type === 'Subtitle');
        if (it.ParentIndexNumber <= 0 || subs.length === 0) continue;
        if (!items.assItem && subs.some(s => /ass|ssa/i.test(s.Codec || ''))) items.assItem = it;
        if (!items.srtItem && subs.some(s => /subrip|srt|webvtt|mov_text/i.test(s.Codec || ''))) items.srtItem = it;
        if (items.assItem && items.srtItem) break;
    }
    if (!items.srtItem) {
        // the first 30 episodes can be all-ASS (anime libraries); widen the search
        const wide = await get(`/Users/${authHeaders.userId}/Items`, { IncludeItemTypes: 'Episode,Movie', Limit: 200, Fields: 'MediaStreams' });
        for (const it of wide.data.Items || []) {
            const subs = (it.MediaStreams || []).filter(s => s.Type === 'Subtitle');
            if (subs.some(s => /subrip|srt|webvtt|mov_text/i.test(s.Codec || ''))) { items.srtItem = it; break; }
        }
    }
    return items;
}

// ---------- tests ----------
const tests = [];
const t = (num, name, fn) => tests.push({ num, name, fn });

t(1, 'startup: connects, registers capabilities incl. SetShuffleQueue', async () => {
    await waitFor('WebSocket connection established', 30000);
    await waitFor('Script started correctly', 10000);
    await sleep(800);
    const ses = await findSession();
    check(ses, 'session not listed');
    check((ses.Capabilities && ses.Capabilities.SupportedCommands || []).includes('SetShuffleQueue'),
        'SetShuffleQueue not advertised in session capabilities');
    const f = await get(`/Users/${authHeaders.userId}/Items`, { Limit: 1 });
    check(f.status === 200, 'API not reachable with suite token');
});

t(2, 'PlayNow movie: loads, reports playing, emits title contract', async ({ items }) => {
    const m = markLog();
    await playItem(items.movie.Id);
    await waitForSince(m, 'PLAY command received', 10000);
    await waitForSince(m, 'Starting episode: ', 15000);
    await waitForSince(m, 'File loaded by MPV', 30000);
    await connectIpcWhenReady();
    await waitForMpvPath(items.movie.Id);
    const ses = await findSession();
    check(ses.PlayState && ses.PlayState.PlayMethod, 'session PlayState not reporting');
});

t(3, 'Playstate pause/unpause/playpause', async () => {
    await playstate('Pause'); await sleep(700);
    eq(await mpvGet('pause'), true, 'Pause command did not pause mpv');
    await waitFor('Playback paused', 5000);
    await playstate('Unpause'); await sleep(700);
    eq(await mpvGet('pause'), false, 'Unpause command did not resume mpv');
    await playstate('PlayPause'); await sleep(700);
    eq(await mpvGet('pause'), true, 'PlayPause did not toggle');
    await playstate('PlayPause'); await sleep(500);
});

t(4, 'Playstate seek/rewind/fastforward', async () => {
    await playstate('Seek', { seekPositionTicks: 30 * 10000000 }); await sleep(900);
    near(await mpvGet('time-pos'), 30, 8, 'Seek to 30s');
    await playstate('Rewind'); await sleep(900);
    near(await mpvGet('time-pos'), 20, 8, 'Rewind 10s');
    await playstate('FastForward'); await sleep(900);
    near(await mpvGet('time-pos'), 30, 8, 'FastForward 10s');
});

t(5, 'Volume up/down/set and mute/unmute/toggle', async () => {
    await mpvSet('volume', 50); await sleep(300);
    await generalCmd('VolumeUp'); await sleep(500);
    near(await mpvGet('volume'), 55, 2, 'VolumeUp +5');
    await generalCmd('VolumeDown'); await sleep(500);
    near(await mpvGet('volume'), 50, 2, 'VolumeDown -5');
    await generalCmd('SetVolume', { Volume: 33 }); await sleep(500);
    near(await mpvGet('volume'), 33, 2, 'SetVolume 33');
    await generalCmd('Mute'); await sleep(400);
    eq(await mpvGet('mute'), true, 'Mute');
    await generalCmd('Unmute'); await sleep(400);
    eq(await mpvGet('mute'), false, 'Unmute');
    await generalCmd('ToggleMute'); await sleep(400);
    eq(await mpvGet('mute'), true, 'ToggleMute');
    await generalCmd('ToggleMute'); await sleep(300);
});

t(6, 'SetRepeatMode maps to mpv loop properties', async () => {
    await generalCmd('SetRepeatMode', { RepeatMode: 'RepeatAll' }); await sleep(500);
    eq(await mpvGet('loop-playlist'), 'inf', 'RepeatAll -> loop-playlist=inf');
    await generalCmd('SetRepeatMode', { RepeatMode: 'RepeatOne' }); await sleep(500);
    eq(await mpvGet('loop-file'), 'inf', 'RepeatOne -> loop-file=inf');
    await generalCmd('SetRepeatMode', { RepeatMode: 'RepeatNone' }); await sleep(500);
    check((await mpvGet('loop-playlist')) !== 'inf', 'RepeatNone did not clear loop-playlist');
});

t(7, 'DisplayMessage shows the message without pausing (web parity)', async () => {
    // jellyfin-web shows DisplayMessage as a toast/alert and never touches
    // playback (serverNotifications.js displayMessage)
    await playstate('Unpause'); await sleep(400);
    await generalCmd('DisplayMessage', { Header: 'E2E', Text: 'hello from the suite', TimeoutMs: '4000' }); await sleep(1200);
    eq(await mpvGet('pause'), false, 'DisplayMessage must NOT pause playback (web parity)');
    eq(await mpvGet('osd-font-size'), 60, 'the message OSD should be shown while the message is up');
    await sleep(3500);
    check((await mpvGet('osd-font-size')) !== 60, 'OSD settings should be restored after the message');
});

t(8, 'track mapping: Jellyfin stream indices select the right mpv tracks', async ({ items }) => {
    const { subs, auds } = items.multiTrack;
    await playAndWait(items.multiTrack.Id);
    if (subs.length >= 2) {
        await generalCmd('SetSubtitleStreamIndex', { Index: subs[1].Index }); await sleep(800);
        eq(await mpvGet('sid'), 2, `SetSubtitleStreamIndex(${subs[1].Index}) must select mpv sid 2`);
        // Jellyfin-initiated changes are echo-guarded (no immediate progress report),
        // so the session reflects it on the next 10s progress tick.
        await sleep(11000);
        const ses = await findSession();
        near(ses.PlayState.SubtitleStreamIndex, subs[1].Index, 0.5,
            'session must report the Jellyfin stream index back (not the mpv id)');
        await generalCmd('SetSubtitleStreamIndex', { Index: subs[0].Index }); await sleep(800);
        eq(await mpvGet('sid'), 1, `SetSubtitleStreamIndex(${subs[0].Index}) must select mpv sid 1`);
        await generalCmd('SetSubtitleStreamIndex', { Index: -1 }); await sleep(600);
        check([false, 'no', null].includes(await mpvGet('sid')), 'Index -1 must disable subtitles');
    }
    if (auds.length >= 2) {
        await generalCmd('SetAudioStreamIndex', { Index: auds[1].Index }); await sleep(800);
        eq(await mpvGet('aid'), 2, `SetAudioStreamIndex(${auds[1].Index}) must select mpv aid 2`);
    }
});

t(9, 'episode PlayNow expands to the full season at the right index', async ({ items }) => {
    const ep = items.episode;
    const m = markLog();
    await playItem(ep.Id);
    await waitForSince(m, 'Full season queue:', 20000);
    await waitForSince(m, 'File loaded by MPV', 30000);
    await connectIpcWhenReady();
    await waitForMpvPath(items.episode.Id);
    await sleep(500);
    const pl = await mpvPlaylist();
    eq(pl.length, ep.seasonList.length, 'playlist length must equal season episode count');
    const cur = await mpvGet('playlist-current-pos');
    eq(cur, ep.seasonIndex, 'playback must start at the clicked episode index');
    const started = itemIdOf(await mpvGet('path'));
    check(started === ep.Id, `wrong episode started: ${started}`);
});

t(10, 'resume: StartPositionTicks seeks mpv to the saved position', async ({ items }) => {
    await playAndWait(items.movie.Id, { startTicks: 60 * 10000000 });
    await sleep(1200);
    near(await mpvGet('time-pos'), 60, 12, 'resume position ~60s');
});

t(11, 'PlayNext/PlayLast insert into the playlist WITHOUT starting playback', async ({ items }) => {
    await playAndWait(items.episode.Id);
    const before = await mpvGet('playlist-current-pos');
    const beforeFile = itemIdOf(await mpvGet('path'));
    const r1 = await playItem(items.movie.Id, { playCommand: 'PlayNext' });
    check(r1.status < 400, 'PlayNext rejected');
    await sleep(1200);
    // NOTE: PlayLast must use a movie — the server expands a single episode to
    // its whole series queue before forwarding (SessionManager.SendPlayCommand).
    const r2 = await playItem(items.movie2.Id, { playCommand: 'PlayLast' });
    check(r2.status < 400, 'PlayLast rejected');
    await sleep(1200);
    const after = await mpvGet('playlist-current-pos');
    const afterFile = itemIdOf(await mpvGet('path'));
    eq(after, before, 'PlayNext/PlayLast must not change the playing item');
    eq(afterFile, beforeFile, 'PlayNext/PlayLast must not switch files');
    const pl = await mpvPlaylist();
    check(pl.includes(items.movie.Id), 'PlayNext item missing from playlist');
    check(pl[pl.length - 1] === items.movie2.Id, 'PlayLast item must be at the end');
});

t(12, 'PlayShuffle (web-UI flow): shuffled order survives to the playlist', async ({ items }) => {
    // jellyfin-web sends ALL season ids with PlayShuffle; the server shuffles them
    // and forwards PlayNow + the shuffled list. The shim must NOT re-sort it.
    // (Server-side note: single-id PlayShuffle is expanded in canonical order by
    // Jellyfin before it reaches any client - not fixable client-side.)
    const season = items.shuffleSeason;
    const m = markLog();
    await playItem(season.map(e => e.Id).join(','), { playCommand: 'PlayShuffle' });
    await waitForSince(m, 'File loaded by MPV', 40000);
    await connectIpcWhenReady();
    const seg = shimOut.slice(m);
    const line = seg.split('\n').find(l => l.includes('Play command data')) || '';
    const sent = (line.match(/itemIds":\[(.*?)\]/) || [, ''])[1].split(',').map(x => x.slice(1, 9));
    check(sent.length === season.length, `expected ${season.length} ids in the play message, got ${sent}`);
    const pl = await mpvPlaylist();
    eq(pl.map(x => x.slice(0, 8)), sent, 'playlist must keep the server-shuffled order');
    const started = itemIdOf(await mpvGet('path'));
    check(started.slice(0, 8) === sent[0], `playback must start at the first shuffled item (got ${started.slice(0, 8)})`);
});
t(13, 'SetShuffleQueue reorders the playlist but keeps playback', async () => {
    const beforeFile = await mpvGet('filename');
    const posBefore = await mpvGet('time-pos');
    await generalCmd('SetShuffleQueue'); await sleep(1200);
    const afterFile = await mpvGet('filename');
    eq(afterFile, beforeFile, 'shuffle must not restart the current item');
    const posAfter = await mpvGet('time-pos');
    check(typeof posAfter === 'number' && posAfter >= (typeof posBefore === 'number' ? posBefore - 1 : 0),
        'playback must keep running across shuffle');
    await waitFor('Queue shuffled by server', 8000);
});

t(14, 'SetPlaybackOrder uses playlist-shuffle/unshuffle', async () => {
    const before = await mpvPlaylist();
    check(before.length >= 2, `want a 2+ item queue for shuffle discrimination, got ${before.length}`);
    let changed = false;
    for (let i = 0; i < 8 && !changed; i++) {
        await generalCmd('SetPlaybackOrder', { PlaybackOrder: 'Shuffle' }); await sleep(900);
        changed = JSON.stringify(before) !== JSON.stringify(await mpvPlaylist());
        if (!changed) {
            await generalCmd('SetPlaybackOrder', { PlaybackOrder: 'Default' }); await sleep(400);
        }
    }
    check(changed, 'Shuffle did not reorder the playlist after 8 attempts');
    await generalCmd('SetPlaybackOrder', { PlaybackOrder: 'Default' }); await sleep(400);
});
t(15, 'NextTrack / PreviousTrack navigate the playlist', async ({ items }) => {
    await playAndWait(items.episode.Id);
    // the advance assertion needs to start mid-queue: at the last item NextTrack
    // legitimately ends playback instead of advancing
    let before = await mpvGet('playlist-current-pos');
    const count = await mpvGet('playlist-count');
    if (before >= count - 1) {
        let m = markLog();
        await playstate('PreviousTrack');
        await waitForSince(m, /Starting previous episode|Playlist changed/, 15000);
        await waitForSince(m, 'File loaded by MPV', 25000);
        before = await mpvGet('playlist-current-pos');
    }
    // wait for each transition to COMPLETE before the next command: the shim
    // debounces commands during file loads (isPlayingNext) — firing the reverse
    // command mid-load gets it dropped by design
    let m = markLog();
    await playstate('NextTrack');
    await waitForSince(m, /Starting next episode|Playlist changed/, 15000);
    await waitForSince(m, 'File loaded by MPV', 25000);
    const afterNext = await mpvGet('playlist-current-pos');
    check(afterNext > before, `NextTrack did not advance (${before} -> ${afterNext})`);
    await seekWhenReady(5);
    m = markLog();
    await playstate('PreviousTrack');
    await waitForSince(m, /Starting previous episode|Playlist changed/, 15000);
    await waitForSince(m, 'File loaded by MPV', 25000);
    const afterPrev = await mpvGet('playlist-current-pos');
    check(afterPrev < afterNext, `PreviousTrack did not go back (${afterNext} -> ${afterPrev})`);
    // NextTrack/PreviousTrack can kick off async transition work (NextUp queries
    // with retries) that lands AFTER this test returns and would clobber the
    // next test's playback — let it settle first.
    await sleep(4500);
});

t(16, 'skip intro: S-key wire path seeks past the segment', async ({ items }) => {
    const ep = items.episode;
    // Fetch segments fresh and clamp to the real duration: Jellyfin segment/runtime
    // metadata can disagree with the actual media file, and the NextUp-based
    // fixture can drift between runs.
    const segResp = await get(`/MediaSegments/${ep.Id}`, { includeSegmentTypes: ['Intro', 'Outro'] });
    const seg = (segResp.data?.Items || []).find(s => s.Type === 'Intro');
    if (!seg) return skip('no Intro segment on the chosen episode');
    await playAndWait(ep.Id);
    const dur = await mpvGet('duration');
    check(typeof dur === 'number' && dur > 5, `unexpected duration ${JSON.stringify(dur)}`);
    const introEnd = Math.min(seg.EndTicks / 10000000, dur - 2);
    const startSec = Math.min(seg.StartTicks / 10000000 + 5, Math.max(introEnd - 2, 1));
    await seekWhenReady(startSec);
    await mpvCmd('script-message', 'jellyfin-skip-intro');
    await sleep(1500);
    const pos = await mpvGet('time-pos');
    check(typeof pos === 'number', `no position after skip (got ${JSON.stringify(pos)})`);
    check(pos >= introEnd - 2, `skip did not jump past intro end (pos=${pos}, introEnd=${introEnd}, dur=${dur})`);
    await waitFor(/Skip intro requested/, 5000);
});

t(17, 'OSC wire path: toggle-favorite flips favorite in Jellyfin', async ({ items }) => {
    await playAndWait(items.movie.Id);
    const before = await get(`/Users/${authHeaders.userId}/Items/${items.movie.Id}`);
    const wasFav = !!before.data.UserData?.IsFavorite;
    await mpvCmd('script-message', 'shim-jf-osc-action', 'toggle-favorite');
    await sleep(1800);
    const after = await get(`/Users/${authHeaders.userId}/Items/${items.movie.Id}`);
    check(!!after.data.UserData?.IsFavorite !== wasFav, 'favorite state did not flip');
    await mpvCmd('script-message', 'shim-jf-osc-action', 'toggle-favorite'); // restore
    await sleep(1200);
    const restored = await get(`/Users/${authHeaders.userId}/Items/${items.movie.Id}`);
    check(!!restored.data.UserData?.IsFavorite === wasFav, 'favorite restore failed');
});

t(18, 'next-up notification fires near the end of an episode', async ({ items }) => {
    const ep = items.episode;
    const nextEp = ep.seasonList[ep.seasonIndex + 1];
    if (!nextEp) return skip('chosen episode is last in season');
    await playAndWait(items.episode.Id);
    const dur = await mpvGet('duration');
    check(typeof dur === 'number' && dur > 30, `unexpected duration ${dur}`);
    await seekWhenReady(dur - 12);
    shimOut = shimOut.replace(/Next up:/g, 'Next up-seen:'); // isolate this test's marker
    await waitFor('Next up:', 15000);
});

t(19, 'auto-advance: reaching EOF moves to the next episode', async ({ items }) => {
    const ep = items.episode;
    const nextEp = ep.seasonList[ep.seasonIndex + 1];
    if (!nextEp) return skip('chosen episode is last in season');
    await playAndWait(items.episode.Id);
    const dur = await mpvGet('duration');
    await seekWhenReady(dur - 0.4);
    await waitFor('Starting next episode', 25000);
    // Identity checks must use `path` (mpv's `filename` is only the last path
    // component — for stream URLs that is "stream?static=true&ApiKey=...").
    // waitForMpvPath also polls instead of trusting a fixed sleep.
    await waitForMpvPath(nextEp.Id);
});

t(20, 'mark watched at 90%+ and restore unplayed afterwards', async ({ items }) => {
    const ep = items.episode;
    const before = await get(`/Users/${authHeaders.userId}/Items/${ep.Id}`);
    const wasPlayed = !!before.data.UserData?.Played;
    try {
        await playAndWait(items.episode.Id);
        const dur = await mpvGet('duration');
        check(typeof dur === 'number' && dur > 10, `unexpected duration ${JSON.stringify(dur)}`);
        // 97% keeps margin against stream-duration estimates (Jellyfin runtime is
        // the mark threshold; mpv's duration can differ slightly)
        await seekWhenReady(dur * 0.97); await sleep(1000);
        const pos = await mpvGet('time-pos');
        check(typeof pos === 'number' && pos > dur * 0.9, `seek did not land near end (pos=${pos}, dur=${dur})`);
        await playstate('Stop');
        // markItemAsWatched is an async API call — poll for it
        let played = false;
        for (let i = 0; i < 20 && !played; i++) {
            await sleep(1000);
            const poll = await get(`/Users/${authHeaders.userId}/Items/${ep.Id}`);
            played = !!poll.data.UserData?.Played;
        }
        // The shim's success log (which records the item id) is the product's own
        // record that the mark POST completed — valid evidence on its own.
        const marked = new RegExp('marked as watched in Jellyfin \\(' + ep.Id + '\\)').test(shimOut);
        check(played || marked, `item was not marked watched at 97% (fixture=${ep.Id}, wasPlayed at start: ${wasPlayed}, pos=${pos}, dur=${dur}, runtime: ${(items.episode.RunTimeTicks || 0) / 1e7})`);
    } finally {
        if (!wasPlayed) {
            await del(`/Users/${authHeaders.userId}/PlayedItems/${ep.Id}`);
        }
    }
});

t(21, 'autoClose quits mpv when playback ends', async ({ items }) => {
    await stopShim();
    writeConfig({ autoClose: true });
    startShim();
    await waitFor('WebSocket connection established', 30000);
    await playAndWait(items.movie.Id);
    const dur = await mpvGet('duration');
    await seekWhenReady(dur - 0.4);
    await waitFor(/Auto-close enabled/, 30000);
    await waitFor(/ending playback|No more episodes/, 15000);
    // restore the default fixture for the remaining tests
    await stopShim();
    writeConfig();
    startShim();
    await waitFor('WebSocket connection established', 30000);
});

t(22, 'SyncPlay: create, leave, and join groups through the OSC wire path', async ({ items }) => {
    await playAndWait(items.movie.Id);
    // own group: create + leave (no other members, so no forced Stop sync)
    await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-new');
    await waitFor('Created new SyncPlay group', 12000);
    await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-disable');
    await waitFor('Left SyncPlay group', 12000);
    // foreign group: joining works (the group owner is idle, so the server will
    // sync us to stopped — that is correct SyncPlay behavior, not a bug)
    const r1 = await post('/SyncPlay/New');
    check(r1.status < 400, `SyncPlay/New failed: ${r1.status}`);
    const list = await get('/SyncPlay/List');
    const group = (list.data || [])[0];
    check(group, 'no SyncPlay group after New');
    const m = markLog();
    await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-join', String(group.GroupId));
    await waitForSince(m, /Joined SyncPlay group/, 12000);
    // leave it again — a dead member would pin this group on the server forever.
    // Joining the idle group made the server sync us to stopped, and SyncPlay
    // Stop runs killMpv() (by design: stop playback) — so mpv, and with it the
    // OSC transport, is gone. Revive playback first (the real user path: start
    // something, then leave the group from the OSC).
    await playAndWait(items.movie.Id);
    const m2 = markLog();
    await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-disable');
    await waitForSince(m2, /Left SyncPlay group|Failed to leave SyncPlay/, 12000, 'shim syncplay leave');
    const lv = await post('/SyncPlay/Leave');
    check(lv.status < 400, `SyncPlay/Leave failed: ${lv.status}`);
    let gone = false, after;
    for (let i = 0; i < 15 && !gone; i++) {
        await sleep(700);
        after = await get('/SyncPlay/List');
        gone = !(after.data || []).some(g => g.GroupId === group.GroupId);
    }
    check(gone, `test SyncPlay group still on server: ${JSON.stringify(after && after.data)}`);
});
t(25, 'specials rule: series play starts past specials, explicit special plays itself', async ({ items }) => {
    const fx = items.seriesWithSpecials;
    if (!fx) return skip('no series with specials in library');
    // series-level play: the server expands a series id by SortName ("0x1 ..." first),
    // so a special leads the list — playback must still start at a regular episode
    // (season 1 for a new series), matching jellyfin-web's client-side resolution.
    let m = markLog();
    await playItem(fx.id);
    await waitForSince(m, /Queue set: .*starting past specials/, 20000);
    await connectIpcWhenReady();
    // poll until the loaded item is one of the regular episodes — a bare path
    // check would be satisfied by a previous test's still-loaded file
    let started = null;
    for (let i = 0; i < 30 && !(started && fx.regularIds.includes(started)); i++) {
        await sleep(400);
        started = itemIdOf(await mpvGet('path'));
    }
    check(fx.regularIds.includes(started), `series play must start at a regular episode (got ${started})`);
    // explicit special selection: the special itself must play
    m = markLog();
    await playItem(fx.specialId);
    await waitForSince(m, /Full season queue: /, 20000);
    await waitForMpvPath(fx.specialId);
});

t(26, 'web-style episode click: startItemId-shaped list starts at the clicked item', async ({ items }) => {
    // jellyfin-web resolves a single-episode click via getEpisodes(SeriesId,
    // startItemId: clicked) and sends the resulting list with StartIndex at the
    // clicked item (playbackmanager.js filterEpisodes). Emulate that exact shape.
    const ep = items.episode;
    const resolved = await get(`/Shows/${ep.SeriesId}/Episodes`, {
        userId: authHeaders.userId, seasonId: ep.SeasonId, startItemId: ep.Id, fields: 'IndexNumber'
    });
    const list = (resolved.data.Items || []);
    check(list.length > 0, 'server returned no items for the startItemId query');
    const startIdx = Math.max(0, list.findIndex(e => e.Id === ep.Id));
    const m = markLog();
    await playItem(list.map(e => e.Id).join(','), { startIndex: startIdx });
    await waitForSince(m, /Queue set: |Full season queue: /, 20000);
    await connectIpcWhenReady();
    await waitForMpvPath(ep.Id);
});
t(27, 'OSC state push reflects track changes made through the OSC', async ({ items }) => {
    // jf-mpv-osc renders its track menus from shim-jf-osc-state broadcasts; after
    // an OSC-initiated track change the shim must push fresh state or the UI
    // keeps showing the selection from load time
    const fx = items.multiTrack;
    const subs = fx.subs, auds = fx.auds;
    await playAndWait(fx.Id);
    await sleep(600);
    if (subs.length >= 2) {
        ipcEvents.length = 0;
        await mpvCmd('script-message', 'shim-jf-osc-action', 'set-sub', String(subs[1].Index));
        await sleep(2000);
        check(ipcEvents.length > 0, 'no shim-jf-osc-state push after a set-sub action');
        const state = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
        const sel = (state.subtitles || []).find(x => x.selected);
        check(sel && sel.id === subs[1].Index, `OSC state shows sub ${sel ? sel.id : 'none'}, expected ${subs[1].Index}`);
    }
    if (auds.length >= 2) {
        ipcEvents.length = 0;
        await mpvCmd('script-message', 'shim-jf-osc-action', 'set-audio', String(auds[1].Index));
        await sleep(2000);
        check(ipcEvents.length > 0, 'no shim-jf-osc-state push after a set-audio action');
        const state = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
        const sel = (state.audio || []).find(x => x.selected);
        check(sel && sel.id === auds[1].Index, `OSC state shows audio ${sel ? sel.id : 'none'}, expected ${auds[1].Index}`);
    }
    // and Jellyfin-side changes must reach the OSC too (same observers)
    ipcEvents.length = 0;
    await generalCmd('SetSubtitleStreamIndex', { Index: subs[0].Index });
    await sleep(2000);
    check(ipcEvents.length > 0, 'no shim-jf-osc-state push after a Jellyfin-side track change');
});

t(28, 'state feedback: queue changes, repeat reporting, mpv-key sub-style changes', async ({ items }) => {
    // same bug class as test 27: state changes must reach the UIs
    await playAndWait(items.episode.Id);
    await sleep(500);

    // (a) queue mutations push OSC state (has_prev/has_next live in the blob)
    ipcEvents.length = 0;
    await playItem(items.movie.Id, { playCommand: 'PlayNext' });
    await sleep(2000);
    check(ipcEvents.length > 0, 'no OSC state push after PlayNext (queue changed)');
    const qstate = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
    check(qstate.queue && qstate.queue.has_next === true, `queue.has_next should be true after PlayNext (got ${JSON.stringify(qstate.queue)})`);

    // (b) RepeatMode reported to Jellyfin reflects the real state (web parity)
    await generalCmd('SetRepeatMode', { RepeatMode: 'RepeatAll' });
    await sleep(11500); // next 10s progress tick carries it
    const ses = await findSession();
    check(ses.PlayState && ses.PlayState.RepeatMode === 'RepeatAll',
        `session should report RepeatAll (got ${ses.PlayState && ses.PlayState.RepeatMode})`);
    await generalCmd('SetRepeatMode', { RepeatMode: 'RepeatNone' });

    // (c) mpv's own keys (G/F/r/R change sub-scale/sub-pos directly) must push
    //     OSC state too — jf-mpv-osc renders sub_style from the blob
    ipcEvents.length = 0;
    await mpvSet('sub-scale', 1.25);
    await sleep(1500);
    check(ipcEvents.length > 0, 'no OSC state push after an mpv-side sub-scale change');
    const sstate = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
    check(sstate.sub_style && sstate.sub_style.size && sstate.sub_style.size.current === '125%',
        `sub_style.size.current should reflect 1.25 (got ${sstate.sub_style && sstate.sub_style.size && sstate.sub_style.size.current})`);
    await mpvSet('sub-scale', 1.0);
});

t(29, 'sub_style: correct defaults reported; size/position/color work on ASS subs', async ({ items }) => {
    // mpv returns sub-color as #AARRGGBB (the old comparison to #FFFFFF never
    // matched). For ASS/SSA the visible colour is the style's PrimaryColour and
    // sub-color is ignored — report "Style" until a colour is forced via
    // sub-ass-style-overrides. sub-pos moves ASS too (verified by frame
    // rendering), so position must NOT be forced through style Alignment
    // (unreliable and destructive); sub-scale applies to ASS under the default
    // sub-ass-override=scale.
    const fx = items.assItem;
    if (!fx) return skip('no ASS-subtitled item in library');
    await playAndWait(fx.Id);
    await sleep(600);
    // make sure an ASS track is actually selected for the assertions below
    const tl = await mpvCmd('get_property', 'track-list');
    const assTrack = (Array.isArray(tl) ? tl : []).find(t => t && t.type === 'sub' && /ass|ssa/i.test(t.codec || ''));
    if (assTrack) { await mpvSet('sid', assTrack.id); await sleep(400); }

    ipcEvents.length = 0;
    await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-refresh'); // triggers a state push
    await sleep(1500);
    check(ipcEvents.length > 0, 'no state push');
    let st = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
    const defColor = st.sub_style.color, defPos = st.sub_style.position, defSize = st.sub_style.size;
    eq(defColor.current, 'Style', 'ASS default color should read Style (colour comes from the ASS style)');
    eq(defColor.options.find(o => o.selected), undefined, 'no color option should be selected for untouched ASS');
    eq(defPos.current, 'Bottom', 'default position current should read Bottom');
    eq(defSize.current, '100%', 'default size current should read 100%');

    ipcEvents.length = 0;
    await mpvCmd('script-message', 'shim-jf-osc-action', 'set-sub-color', '#FF0000');
    await sleep(1500);
    st = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
    eq(st.sub_style.color.current, 'Red', 'color current after set-sub-color');
    eq((st.sub_style.color.options.find(o => o.selected) || {}).id, '#FF0000', 'Red should be marked selected');
    const assOv = String(await mpvCmd('get_property', 'sub-ass-style-overrides'));
    check(/PrimaryColour/.test(assOv), `ASS style override missing PrimaryColour (got ${assOv})`);

    ipcEvents.length = 0;
    await mpvCmd('script-message', 'shim-jf-osc-action', 'set-sub-position', 'top');
    await sleep(1500);
    eq(await mpvCmd('get_property', 'sub-pos'), 0, 'set-sub-position top should set sub-pos=0 (moves ASS and plain alike)');
    const assOv2 = String(await mpvCmd('get_property', 'sub-ass-style-overrides'));
    check(!/Alignment/.test(assOv2), `position must not force ASS style Alignment (destructive/unreliable; got ${assOv2})`);
    check(/PrimaryColour/.test(assOv2), `position handling must not clobber the color override (got ${assOv2})`);

    await mpvCmd('script-message', 'shim-jf-osc-action', 'set-sub-size', '125');
    await sleep(1500);
    eq(await mpvCmd('get_property', 'sub-scale'), 1.25, 'set-sub-size should set sub-scale (applies to ASS)');
});

t(30, 'sub_style: plain-text subs report real defaults and accept color', async ({ items }) => {
    const fx = items.srtItem;
    if (!fx) return skip('no plain-text-subtitle item in library');
    await playAndWait(fx.Id);
    await sleep(600);
    const tl = await mpvCmd('get_property', 'track-list');
    const srtTrack = (Array.isArray(tl) ? tl : []).find(t => t && t.type === 'sub' && !/ass|ssa/i.test(t.codec || ''));
    if (srtTrack) { await mpvSet('sid', srtTrack.id); await sleep(400); }

    // sub-color is a global mpv preference persisting across files (earlier
    // tests may have changed it) — reset to the default to check the mapping
    await mpvSet('sub-color', '#FFFFFFFF');
    await sleep(300);

    ipcEvents.length = 0;
    await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-refresh');
    await sleep(1500);
    check(ipcEvents.length > 0, 'no state push');
    const st = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
    eq(st.sub_style.color.current, 'White', 'plain default color should read White (mpv sub-color is #FFFFFFFF)');
    eq((st.sub_style.color.options.find(o => o.selected) || {}).id, '#FFFFFF', 'White should be marked selected');

    // and the OSC set path on plain text (sub-color, not the ASS override)
    ipcEvents.length = 0;
    await mpvCmd('script-message', 'shim-jf-osc-action', 'set-sub-color', '#FFFF00');
    await sleep(1500);
    const st2 = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
    eq(st2.sub_style.color.current, 'Yellow', 'plain color current after set-sub-color');
    eq(await mpvCmd('get_property', 'sub-color'), '#FFFFFF00', 'set-sub-color should set sub-color for plain text');
});

t(31, 'sub_style: mpv.conf settings honored/displayed; shim changes nothing on its own', async ({ items }) => {
    // The shim must not touch subtitle settings until the user acts in the OSC,
    // and when mpv.conf restyles subtitles (typical for SRT/subrip) those values
    // must show up as the OSC's current settings.
    await stopShim();
    writeConfig({ extraMpvFlags: [
        '--sub-color=0/1/0',
        '--sub-scale=1.25',
        '--sub-ass-style-overrides=PrimaryColour=&H00FF0000',
    ] });
    startShim();
    await waitFor('WebSocket connection established', 30000);
    try {
        if (items.srtItem) {
            await playAndWait(items.srtItem.Id);
            await sleep(600);
            ipcEvents.length = 0;
            await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-refresh');
            await sleep(1500);
            check(ipcEvents.length > 0, 'no state push');
            const st = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
            eq(st.sub_style.color.current, 'Green', 'mpv.conf sub-color displayed in OSC');
            eq((st.sub_style.color.options.find(o => o.selected) || {}).id, '#00FF00', 'mpv.conf sub-color marked selected');
            eq(st.sub_style.size.current, '125%', 'mpv.conf sub-scale displayed in OSC');
        } else {
            current.details.push('no plain-text item - display check skipped');
        }
        // nothing of ours was written, before or after a file load
        eq(await mpvCmd('get_property', 'sub-scale'), 1.25, 'sub-scale changed without user action');
        eq(await mpvCmd('get_property', 'sub-pos'), 100, 'sub-pos changed without user action');
        eq(await mpvCmd('get_property', 'sub-color'), '#FF00FF00', 'sub-color changed without user action');
        const ov = String(await mpvCmd('get_property', 'sub-ass-style-overrides'));
        eq(ov, 'PrimaryColour=&H00FF0000', 'shim wrote ASS overrides of its own');

        if (items.assItem) {
            await playAndWait(items.assItem.Id);
            await sleep(600);
            ipcEvents.length = 0;
            await mpvCmd('script-message', 'shim-jf-osc-action', 'syncplay-refresh');
            await sleep(1500);
            const st = JSON.parse(ipcEvents[ipcEvents.length - 1].args[1]);
            // mpv.conf's PrimaryColour override IS the ASS colour — display it
            eq(st.sub_style.color.current, '#0000FF', 'mpv.conf ASS colour displayed in OSC');
            eq(st.sub_style.color.options.find(o => o.selected), undefined, 'custom mpv.conf colour must not select a preset');
        }
    } finally {
        await stopShim();
        writeConfig();
        startShim();
        await waitFor('WebSocket connection established', 30000);
        await connectIpcWhenReady().catch(() => {});
    }
});

t(32, 'unwatched-quit: saves no position anywhere, item reset to unwatched', async ({ items }) => {
    // the OSC's "Quit and Mark Unwatched" must leave no resume point (local
    // file or Jellyfin) and must reset the item to unwatched in Jellyfin
    const fx = items.movie2 || items.movie;
    await playAndWait(fx.Id);
    const dur = await mpvGet('duration');
    check(typeof dur === 'number' && dur > 10, `unexpected duration ${JSON.stringify(dur)}`);
    await seekWhenReady(dur * 0.5);
    await sleep(800);
    // exactly the wire message jf-mpv-osc sends for that menu item
    const m = markLog();
    await mpvCmd('script-message', 'shim-jf-osc-action', 'unwatched-quit');
    await waitForSince(m, /OSC unwatched quit/, 12000, 'unwatched quit handled');
    await sleep(1500);
    let ud = null;
    for (let i = 0; i < 20; i++) {
        const r = await get(`/Users/${authHeaders.userId}/Items/${fx.Id}`, { fields: 'UserData' });
        ud = r.data && r.data.UserData;
        if (ud && !ud.Played && !ud.PlaybackPositionTicks) break;
        await sleep(700);
    }
    check(ud, 'no UserData readable after unwatched-quit');
    check(!ud.Played, `item still marked played after unwatched-quit (got ${JSON.stringify(ud)})`);
    check(!ud.PlaybackPositionTicks, `resume position still saved after unwatched-quit (got ${ud.PlaybackPositionTicks})`);
    const posFile = path.join(ROOT, 'data', `playback_positions_${TEST_ID}.json`);
    const saved = fs.existsSync(posFile) ? JSON.parse(fs.readFileSync(posFile, 'utf8')) : {};
    check(!saved[fx.Id], `local position still saved for ${fx.Id}`);
});

t(35, 'apiKey: media URLs carry the configured key; token fallback; logs redacted', async ({ items }) => {
    // #386/#388: mediaApiKey() must prefer CONFIG.apiKey over the access token,
    // and whatever ends up in the URL must be redacted to *** in shim logs.
    const created = await post('/Auth/Keys', null, { app: `${TEST_NAME}-urlcheck` });
    if (created.status === 401 || created.status === 403) return skip('admin required to create API keys');
    check(created.status < 400, `API key creation rejected (${created.status})`);
    const list = await get('/Auth/Keys');
    const key = (list.data.Items || []).find(k => k.AppName === `${TEST_NAME}-urlcheck`);
    check(key, 'created API key not listed');
    try {
        await stopShim();
        writeConfig({ apiKey: key.AccessToken });
        startShim();
        await waitFor('WebSocket connection established', 30000);
        await connectIpcWhenReady().catch(() => {});
        const m = markLog();
        await playAndWait(items.movie.Id);
        const p = String(await mpvGet('path'));
        const masked = p.replace(/ApiKey=[^&]+/, 'ApiKey=***');
        const shimTok = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `jellyfin_token_${TEST_ID}.json`), 'utf8')).AccessToken;
        check(p.includes(`ApiKey=${key.AccessToken}`), `URL must carry the configured apiKey (path=${masked})`);
        check(!p.includes(`ApiKey=${shimTok}`), 'URL must NOT carry the access token when apiKey is configured');
        // redaction contract: the raw key must never reach the logs
        check(!shimOut.includes(key.AccessToken), 'raw apiKey leaked into shim logs');
        check(shimOut.slice(m).includes('ApiKey=***'), 'stream URL should be logged redacted');

        // fallback branch: no apiKey → the access token goes into the URL
        await stopShim();
        writeConfig();
        startShim();
        await waitFor('WebSocket connection established', 30000);
        await connectIpcWhenReady().catch(() => {});
        await playAndWait(items.movie.Id);
        const p2 = String(await mpvGet('path'));
        const shimTok2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `jellyfin_token_${TEST_ID}.json`), 'utf8')).AccessToken;
        check(p2.includes(`ApiKey=${shimTok2}`), `with no apiKey the URL must carry the token (path=${p2.replace(/ApiKey=[^&]+/, 'ApiKey=***')})`);
    } finally {
        await stopShim();
        writeConfig();
        startShim();
        await waitFor('WebSocket connection established', 30000);
        await connectIpcWhenReady().catch(() => {});
        // revocation takes the TOKEN string, not the numeric Id (all Ids report 0)
        await del('/Auth/Keys/' + key.AccessToken);
    }
});

t(36, 'revoked token: shim reauthenticates and recovers instead of going silent', async ({ items }) => {
    // #385: a revoked/invalidated token must trigger reauthenticate() and a
    // retry — not silently drop reporting until restart.
    //
    // How to invalidate a live session token (verified against the server):
    // DELETE /Auth/Keys/{token} returns 204 but only kills true API keys — a
    // session token keeps working. A same-device re-login DOES invalidate the
    // old token (401 afterwards) and kicks the device's sockets — the exact
    // sequence that stranded the running shim earlier today.
    const tokFile = path.join(ROOT, 'data', `jellyfin_token_${TEST_ID}.json`);
    const before = JSON.parse(fs.readFileSync(tokFile, 'utf8')).AccessToken;
    const m = markLog();
    const probe = await login(TEST_ID); // invalidate 'before' + kick the sockets
    // drop the probe's own session row right away so findSession() below can
    // only match the shim's recovered session
    await api.post('/Sessions/Logout', {}, { headers: probe.Authorization, validateStatus: () => true });
    await waitForSince(m, /Token expired, reauthenticating/, 20000, 'reauth log line');
    await waitForSince(m, /Authentication successful/, 20000, 'reauth completion');
    await waitForSince(m, /WebSocket connection established/, 20000, 'sockets back up');
    // and it fully works afterwards: a whole play cycle on the fresh token
    await playAndWait(items.movie.Id);
    const after = JSON.parse(fs.readFileSync(tokFile, 'utf8')).AccessToken;
    check(after && after !== before, 'shim did not save a fresh token after reauth');
    const ses = await findSession();
    check(ses, 'session lost after token revocation');
});

const crashLogBytes = () => { try { return fs.statSync(path.join(ROOT, 'data', 'crash.log')).size; } catch { return 0; } };

t(37, 'shutdown while sockets are mid-handshake: no crash (closeAllWs regression)', async () => {
    // Regression for a crash seen live (crash.log 2026-10-23T01:58Z): during
    // SIGTERM shutdown closeAllWs() called removeAllListeners() then close() on
    // sockets still CONNECTING (a reconnect was in flight while the server was
    // restarting). ws aborts a pending handshake and emits 'error'
    // asynchronously (process.nextTick) — past the try/catch, with no listener
    // left → uncaughtException → crash dialog + crash.log during quit. The
    // stalled proxy keeps both sockets in CONNECTING to reproduce exactly that.
    const proxy = startWsProxy(cfg.serverUrl, { stallUpgrades: true });
    const port = await proxy.listen();
    const base = new URL(cfg.serverUrl);
    await stopShim();
    writeConfig({ serverUrl: `http://127.0.0.1:${port}${base.pathname.replace(/\/$/, '')}` });
    const crashBefore = crashLogBytes();
    startShim();
    await waitFor('Script started correctly', 25000, 'shim up');
    for (let i = 0; i < 20 && proxy.upgrades.length < 2; i++) await sleep(250);
    check(proxy.upgrades.length >= 2, `both sockets should be mid-handshake, saw ${proxy.upgrades.length}`);
    await stopShim(); // SIGTERM → shutdown → closeAllWs on CONNECTING sockets
    await sleep(1000);
    check(/Closing application/.test(shimOut), 'clean shutdown message missing');
    check(!/Uncaught exception/.test(shimOut), 'closeAllWs crashed on a CONNECTING socket');
    check(crashLogBytes() === crashBefore, 'crash.log grew during shutdown');
    await proxy.close();
    // restore the default fixture for whatever runs next
    writeConfig();
    startShim();
    await waitFor('WebSocket connection established', 30000);
    await connectIpcWhenReady().catch(() => {});
});

t(38, 'completed item ends watched with NO resume position (server or local)', async ({ items }) => {
    // Regression: an item played to its end used to finish as Played=true WITH a
    // resume position in Jellyfin (stuck in Continue Watching) plus a local
    // playback_positions entry — the stop report re-wrote the position after
    // markPlayed (a wrong RunTimeTicks keeps Jellyfin's own MaxResumePct check
    // from zeroing it) and the mpv close handler re-saved locally right after
    // the watched-mark cleared the entry.
    const fx = items.movie;
    await stopShim();
    writeConfig({ autoClose: true });
    startShim();
    await waitFor('WebSocket connection established', 30000);
    try {
        // deterministic starting state: unplayed
        await del(`/Users/${authHeaders.userId}/PlayedItems/${fx.Id}`);
        await playAndWait(fx.Id);
        const dur = await mpvGet('duration');
        check(typeof dur === 'number' && dur > 10, `unexpected duration ${JSON.stringify(dur)}`);
        await seekWhenReady(dur - 0.4);
        // The near-end poll (dur-1) usually finishes the item before mpv's own
        // eof event lands — any of these marks completion.
        await waitFor(/End of file reached|Near end of last item|Auto-close enabled/, 30000);
        await waitFor('Auto-close enabled', 20000);
        await sleep(2500); // let the stop report + markPlayed land and mpv close out

        // server: watched AND no resume position
        const r = await get(`/Users/${authHeaders.userId}/Items/${fx.Id}`, { fields: 'UserData' });
        const ud = r.data.UserData || {};
        check(ud.Played, `item not marked watched after completion (UserData=${JSON.stringify(ud)})`);
        check(!ud.PlaybackPositionTicks, `resume position left on completed item: ${ud.PlaybackPositionTicks}`);

        // local: no entry in the resume file
        const posFile = path.join(ROOT, 'data', `playback_positions_${TEST_ID}.json`);
        const saved = fs.existsSync(posFile) ? JSON.parse(fs.readFileSync(posFile, 'utf8')) : {};
        check(!saved[fx.Id], `local resume position saved for completed item: ${JSON.stringify(saved[fx.Id])}`);

        // mpv's exit phantom must not claim the show resumed — anchor at the
        // stop report, which always precedes the quit that triggers the phantom
        const eofAt = shimOut.indexOf('Reporting playback stop');
        check(eofAt >= 0, 'stop report not logged');
        check(!/Playback resumed/.test(shimOut.slice(eofAt)), 'phantom "Playback resumed" logged after the stop report');

        // plugin contract: the completed stop must be reported at/over the item's
        // RunTimeTicks (logged as ", completed") so Jellyfin's UpdatePlayState
        // sets playedToCompletion on the PlaybackStopped event — scrobblers
        // (jellyfin-ani-sync etc.) gate their entire sync on that flag
        check(/Reporting playback stop \(position: [\d.]+s, completed\)/.test(shimOut), 'completed stop not reported at/over RunTimeTicks (playedToCompletion would stay false)');
    } finally {
        await stopShim();
        writeConfig();
        startShim();
        await waitFor('WebSocket connection established', 30000);
        await connectIpcWhenReady().catch(() => {});
    }
});

t(23, 'security: token never appears in shim logs', async () => {
    const r = await api.post('/Users/AuthenticateByName', { Username: cfg.username, Pw: cfg.password }, {
        headers: { 'Content-Type': 'application/json', Authorization: `MediaBrowser Client="x", Device="x", DeviceId="tokcheck", Version="1.0"` }
    });
    check(!shimOut.includes(r.data.AccessToken), 'access token leaked into logs');
    check(!shimOut.includes(cfg.password), 'password leaked into logs');
    // this throwaway session exists only for the check — do not leave it behind
    await api.post('/Sessions/Logout', {}, {
        headers: { Authorization: `MediaBrowser Token="${r.data.AccessToken}", Client="x", Device="x", DeviceId="tokcheck", Version="1.0"` },
        validateStatus: () => true
    });
});

t(24, 'shutdown: lock file cleaned, session stops', async () => {
    const lockPath = path.join(ROOT, 'data', `${path.basename(TMP_CONFIG, '.js')}.lock`);
    check(fs.existsSync(lockPath), 'lock file missing while running');
    await stopShim();
    await sleep(800);
    check(!fs.existsSync(lockPath), 'lock file not cleaned up on shutdown');
    check(/Closing application/.test(shimOut), 'shutdown contract missing');
});

// Minimal HTTP+WebSocket TCP proxy — lets a test sever ONE shim connection at
// the TCP level (an RST exactly like the real-world 1006 drops) without
// touching the other.
function startWsProxy(target, { stallUpgrades = false } = {}) {
    const t = new URL(target);
    const isTls = t.protocol === 'https:';
    const upstreamPort = Number(t.port) || (isTls ? 443 : 80);
    const upgrades = [];
    const server = http.createServer((req, res) => {
        const headers = { ...req.headers, host: t.host };
        const p = (isTls ? https : http).request({ hostname: t.hostname, port: upstreamPort, path: req.url, method: req.method, headers }, pr => {
            res.writeHead(pr.statusCode, pr.headers);
            pr.pipe(res);
        });
        p.on('error', () => { try { res.destroy(); } catch {} });
        req.pipe(p);
    });
    server.on('upgrade', (req, clientSock, head) => {
        if (stallUpgrades) {
            // Accept the TCP connection but never answer the handshake: the
            // client's WebSocket stays CONNECTING indefinitely. Used to
            // reproduce "close() during a pending handshake" shutdown bugs.
            clientSock.on('error', () => {});
            upgrades.push({ dead: false, kill() { this.dead = true; try { clientSock.destroy(); } catch {} } });
            return;
        }
        const up = isTls
            ? tls.connect({ host: t.hostname, port: upstreamPort, servername: t.hostname })
            : net.connect(upstreamPort, t.hostname);
        up.on(isTls ? 'secureConnect' : 'connect', () => {
            const hdrs = [];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const k = req.rawHeaders[i];
                if (k.toLowerCase() === 'host') { hdrs.push(`Host: ${t.host}`); continue; }
                hdrs.push(`${k}: ${req.rawHeaders[i + 1]}`);
            }
            up.write(`${req.method} ${req.url} HTTP/1.1\r\n${hdrs.join('\r\n')}\r\n\r\n`);
            if (head && head.length) up.write(head);
            const pair = { dead: false, kill() { if (!pair.dead) { pair.dead = true; try { clientSock.destroy(); } catch {} try { up.destroy(); } catch {} } } };
            upgrades.push(pair);
            clientSock.on('error', () => {});
            up.on('error', () => {});
            clientSock.pipe(up);
            up.pipe(clientSock);
        });
        up.on('error', () => { try { clientSock.destroy(); } catch {} });
    });
    return {
        upgrades,
        listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
        // Force-destroy every accepted connection first: a stalled upgrade
        // socket is never read/closed, so it keeps server.close() waiting
        // forever — and with all handles gone Node exits 0 mid-test (pending
        // promise, empty loop), silently skipping the rest of the suite.
        close: () => new Promise(r => {
            const done = () => r();
            try { for (const u of upgrades) u.kill(); } catch {}
            try { server.close(done); } catch { done(); }
            setTimeout(done, 2000);
        })
    };
}

t(33, 'presence socket: session stays in /Sessions while any socket lives', async () => {
    // Pure server-mechanism proof with raw sockets: Jellyfin merges both
    // connections into one session and only drops the session when the LAST
    // socket closes (SessionManager.CloseIfNeededAsync). This is what the shim's
    // redundant presence socket relies on to keep the web UI's cast alive.
    const deviceId = `${TEST_ID}-dual`;
    const auth = await login(deviceId);
    const token = auth.Authorization.match(/Token="([^"]+)"/)[1];
    const url = cfg.serverUrl.replace(/^http/, 'ws') + `/socket?ApiKey=${token}&deviceId=${deviceId}`;
    const findSes = async () => {
        const r = await get('/Sessions');
        return (r.data || []).find(s => s.DeviceId === deviceId);
    };
    const openSock = () => new Promise((resolve, reject) => {
        const w = new WebSocket(url);
        w.on('open', () => resolve(w));
        w.on('error', reject);
    });
    const a = await openSock();
    const b = await openSock();
    let ses;
    for (let i = 0; i < 25 && !ses; i++) { ses = await findSes(); if (!ses) await sleep(300); }
    check(ses, 'dual-socket session never appeared in /Sessions');

    a.close();
    let vanishedAt = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
        const cur = await findSes();
        if (!cur) { vanishedAt = Date.now() - t0; break; }
        ses = cur;
        await sleep(250);
    }
    check(vanishedAt === null, `session vanished ${vanishedAt}ms after ONE socket closed`);
    check(ses && ses.Id === (await findSes())?.Id, 'session id changed after a single socket closed');

    b.close();
    let gone = false;
    for (let i = 0; i < 20; i++) { if (!(await findSes())) { gone = true; break; } await sleep(300); }
    check(gone, 'session still listed after BOTH sockets closed');

    await api.post('/Sessions/Logout', {}, { headers: { Authorization: auth.Authorization }, validateStatus: () => true });
});

t(34, 'presence socket: shim keeps its session through a single-socket kill', async () => {
    // The user-visible acceptance test: kill ONE of the shim's two connections
    // at the TCP level and verify /Sessions never blips (which is exactly the
    // condition under which jellyfin-web keeps its cast selection).
    const proxy = startWsProxy(cfg.serverUrl);
    const port = await proxy.listen();
    const base = new URL(cfg.serverUrl);
    await stopShim(); // the runner may have revived a suite shim — it holds the config lock
    writeConfig({ serverUrl: `http://127.0.0.1:${port}${base.pathname.replace(/\/$/, '')}` });
    startShim();
    await waitFor('WebSocket connection established', 25000, 'primary socket up');
    await waitFor('Presence WebSocket established', 25000, 'presence socket up');
    const ses = await findSession();
    check(ses, 'shim session not found');
    check(proxy.upgrades.length >= 2, `expected 2 WS upgrades through proxy, saw ${proxy.upgrades.length}`);

    const mark = markLog();
    proxy.upgrades[1].kill();
    let vanishedAt = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
        const r = await get('/Sessions');
        const still = (r.data || []).find(s => s.DeviceId === TEST_ID);
        if (!still) { vanishedAt = Date.now() - t0; break; }
        await sleep(200);
    }
    check(vanishedAt === null, `session vanished ${vanishedAt}ms after single-socket kill`);

    await waitForSince(mark, /Presence socket disconnected|Reconnecting presence socket|Reconnecting primary socket/, 15000, 'drop logged');
    for (let i = 0; i < 40 && proxy.upgrades.length < 3; i++) await sleep(250);
    check(proxy.upgrades.length >= 3, 'killed socket did not reconnect through proxy');
    await sleep(1500);
    const ses2 = await findSession();
    check(ses2, 'shim session lost after single-socket kill + reconnect');

    await stopShim();
    await proxy.close();
});

// ---------- runner ----------
// If the event loop ever drains before the run completes (a hung await with no
// live handles — e.g. server.close() waiting on a stalled socket), Node exits
// 0 with no SUMMARY and silently skips everything left. Never let that pass.
// Every normal exit below goes through process.exit(), which does NOT emit
// beforeExit — so reaching this handler is always a bug.
process.on('beforeExit', () => {
    console.error('SUITE BUG: event loop drained before the run completed (hung await?). Failing.');
    process.exit(1);
});
async function main() {
    reapStaleTestMpvs();
    writeConfig();
    const loginInfo = await login('e2e-runner');
    authHeaders = loginInfo;

    // The suite plays NextUp items and rewrites UserData (played/position/
    // favorite) around every test. If a human is watching the same account
    // concurrently, the restore step fights their marks and the web UI churns
    // (observed live: watched flags reverting, UserDataChanged storms).
    if (!process.argv.includes('--force')) {
        const s = await get('/Sessions');
        const busy = (s.data || []).filter(x => x.DeviceId !== TEST_ID && x.NowPlayingItem);
        if (busy.length) {
            console.error('REFUSING TO RUN: another session is actively playing on this account:');
            for (const b of busy) console.error(`  - ${b.DeviceName} (${b.DeviceId}) is playing "${b.NowPlayingItem.Name}"`);
            console.error('The suite plays NextUp items and rewrites UserData; running it now will');
            console.error('fight the viewer. Wait for them to finish, or re-run with --force.');
            process.exit(1);
        }
    }

    const items = await discoverItems();
    // snapshot UserData for every fixture id (incl. auto-advanced episodes) so
    // teardown can put Played/resume/favorite/PlayCount back exactly
    const fixtureIds = new Set();
    (function walk(v) {
        if (typeof v === 'string') { if (GUID_RE.test(v)) fixtureIds.add(v); return; }
        if (!v || typeof v !== 'object') return;
        // MediaSegment entries have their own GUID ids that are NOT items
        if (v.StartTicks !== undefined) return;
        if (typeof v.Id === 'string') fixtureIds.add(v.Id);
        if (Array.isArray(v)) v.forEach(walk);
        else Object.values(v).forEach(walk);
    })(items);
    for (const id of fixtureIds) await snapshotUserData(id);
    console.log(`Discovered: movie="${items.movie.Name}", multiTrack="${items.multiTrack.Name}" (${items.multiTrack.subs.length} subs/${items.multiTrack.auds.length} aud), episode="${items.episode.Name}" S${items.episode.ParentIndexNumber}E${items.episode.IndexNumber} @index ${items.episode.seasonIndex}/${items.episode.seasonList.length}, segments: ${items.episode.segments.map(s => s.Type).join(',') || 'none'}\n`);

    startShim();
    // always wait for the shim to be connected before running any selected tests
    await waitFor('WebSocket connection established', 30000);
    await waitFor('Script started correctly', 10000);
    try {
        for (const test of tests) {
            if (ONLY && !ONLY.includes(test.num)) continue;
            current = { name: `${test.num}. ${test.name}`, ok: true, details: [], skipped: false };
            const t0 = Date.now();
            try {
                await test.fn({ items });
                results.push({ ...current, pass: !current.skipped, ms: Date.now() - t0 });
                console.log(current.skipped
                    ? `⏭ SKIP  ${current.name}  — ${current.details.join('; ')}`
                    : `✅ PASS  ${current.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            } catch (e) {
                results.push({ ...current, pass: false, ms: Date.now() - t0, error: e.message });
                console.log(`❌ FAIL  ${current.name}  — ${e.message}`);
                const interesting = shimOut.split('\n').filter(l =>
                    /→|General command|Play command data|Playlist changed|Starting|Already playing|MPV Error|error|No more|Queue|shuffled|Skip intro|SyncPlay|File loaded|watched|report|Report|mark/i.test(l)).slice(-12);
                for (const l of interesting) console.log(`      dbg| ${l.trim().slice(0, 160)}`);
            }
            // revive the shim if a test left it dead (24 and 34 end shim-less on purpose)
            if (!shimProc && test.num !== 24 && test.num !== 34) {
                writeConfig();
                startShim();
                await waitFor('WebSocket connection established', 30000);
                await connectIpcWhenReady().catch(() => {});
            }
        }
    } finally {
        await teardown();
    }

    const pass = results.filter(r => r.pass && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.pass && !r.skipped).length; // skips are NOT failures
    console.log(`\n========== SUMMARY: ${pass} passed, ${skipped} skipped, ${failed} failed ==========`);
    for (const r of results.filter(r => r.skipped)) {
        console.log(`SKIPPED: ${r.name}\n   ${r.details.join('; ')}`);
    }
    for (const r of results.filter(r => !r.pass && !r.skipped)) {
        console.log(`FAILED: ${r.name}\n   ${r.error || r.details.join('; ')}`);
    }
    process.exit(failed ? 1 : 0);
}

process.on('SIGINT', async () => { console.log('\nSIGINT - cleaning up'); await teardown(); process.exit(130); });
// shell-tool timeouts and `kill` deliver SIGTERM — without this handler the run
// dies mid-test and leaves its Played/resume mutations on the server (SIGKILL
// can't be caught at all, so treat any stray mutations as suspect after a kill)
process.on('SIGTERM', async () => { console.log('\nSIGTERM - cleaning up'); await teardown(); process.exit(143); });
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT:', e); await teardown(); process.exit(1); });
main().catch(async (e) => { console.error('SUITE ERROR:', e); await teardown(); process.exit(1); });
