import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

test('no duplicate keyboard shortcuts in Swift files', () => {
  const sourcesDir = 'macapp/Sources';
  const swiftFiles = fs.readdirSync(sourcesDir)
    .filter(f => f.endsWith('.swift'))
    .map(f => path.join(sourcesDir, f));

  for (const file of swiftFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const keyEquivs = [];
    const regex = /keyEquivalent:\s*"([^"]*)"/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1] !== '') { // ignore empty key equivalents
        keyEquivs.push({ key: match[1], line: content.substring(0, match.index).split('\n').length });
      }
    }

    // Same key with DIFFERENT modifier masks is legal (e.g. Hide ⌘H and
    // Hide Others ⌘⌥H — the standard macOS pair). Only identical (key, mask)
    // pairs are duplicates; a keyEquivalentModifierMask set within a few lines
    // of the keyEquivalent distinguishes them.
    const lines = content.split('\n');
    const maskOf = (line) => {
      // only a mask assigned to the same variable counts — otherwise a nearby
      // mask (e.g. Hide Others ⌘⌥H next to Hide ⌘H) would be attributed twice
      const varMatch = (lines[line] || '').match(/(?:let|var)\s+(\w+)\s*=/);
      if (varMatch) {
        for (let i = line + 1; i < Math.min(line + 3, lines.length); i++) {
          const m = lines[i].match(/^\s*(\w+)\.keyEquivalentModifierMask\s*=\s*(.*)/);
          if (m && m[1] === varMatch[1]) return m[2].trim();
        }
      }
      return '.command'; // NSMenuItem default
    };
    const seen = new Map();
    for (const { key, line } of keyEquivs) {
      const id = key + '|' + maskOf(line - 1);
      if (seen.has(id)) {
        assert.fail(`Duplicate keyEquivalent "${key}" in ${file} (lines ${seen.get(id)} and ${line})`);
      }
      seen.set(id, line);
    }
  }
});

test('all PlaystateCommand types are handled', () => {
  const shim = fs.readFileSync('shim.js', 'utf8');

  const playstateCommands = [
    'Stop',
    'Pause',
    'Unpause',
    'PlayPause',
    'NextTrack',
    'PreviousTrack',
    'Seek',
    'Rewind',
    'FastForward'
  ];

  for (const cmd of playstateCommands) {
    assert(
      shim.includes(`'${cmd}'`) || shim.includes(`"${cmd}"`),
      `PlaystateCommand not handled: "${cmd}"`
    );
  }
});

test('all GeneralCommand types are handled', () => {
  const shim = fs.readFileSync('shim.js', 'utf8');

  const generalCommands = [
    'SetAudioStreamIndex',
    'SetSubtitleStreamIndex',
    'SetVolume',
    'VolumeUp',
    'VolumeDown',
    'Mute',
    'Unmute',
    'ToggleMute',
    'SetRepeatMode',
    'DisplayMessage',
    'PlayNext',
    'ToggleFullscreen'
  ];

  for (const cmd of generalCommands) {
    assert(
      shim.includes(`'${cmd}'`) || shim.includes(`"${cmd}"`),
      `GeneralCommand not handled: "${cmd}"`
    );
  }
});

test('no hardcoded secrets in source files', () => {
  const secretPatterns = [
    /api_key=[a-f0-9]{32}/i,          // Full API keys in URLs
    /password:\s*'[^\s']{12,}'/,      // hardcoded passwords (12+ chars, no spaces)
    /Bearer\s+[A-Za-z0-9\-._~+\/]{40,}/ // Bearer tokens (40+ chars)
  ];

  const filesToCheck = ['shim.js', 'config.example.js'];

  for (const file of filesToCheck) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of secretPatterns) {
      const match = content.match(pattern);
      assert(
        match === null,
        `Potential hardcoded secret in ${file}: ${match?.[0]?.substring(0, 50)}...`
      );
    }
  }
});

test('package.json version matches Info.plist version', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const plist = fs.readFileSync('macapp/Info.plist', 'utf8');

  const plistVersionMatch = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  assert(plistVersionMatch, 'CFBundleShortVersionString not found in Info.plist');

  assert.strictEqual(
    pkg.version,
    plistVersionMatch[1],
    `Version mismatch: package.json has ${pkg.version}, Info.plist has ${plistVersionMatch[1]}`
  );
});

test('SupportedCommands uses exact Jellyfin enum names', () => {
  const shim = fs.readFileSync('shim.js', 'utf8');

  // Complete GeneralCommandType enum from Jellyfin 12.2 (/api-docs/openapi.json).
  // Any other name makes POST /Sessions/Capabilities/Full fail with 400 and the
  // server then never sends us commands.
  const jellyfinGeneralCommandTypes = [
    'MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight', 'PageUp', 'PageDown',
    'PreviousLetter', 'NextLetter', 'ToggleOsd', 'ToggleContextMenu', 'Select',
    'Back', 'TakeScreenshot', 'SendKey', 'SendString', 'GoHome', 'GoToSettings',
    'VolumeUp', 'VolumeDown', 'Mute', 'Unmute', 'ToggleMute', 'SetVolume',
    'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'ToggleFullscreen',
    'DisplayContent', 'GoToSearch', 'DisplayMessage', 'SetRepeatMode',
    'ChannelUp', 'ChannelDown', 'Guide', 'ToggleStats', 'PlayMediaSource',
    'PlayTrailers', 'SetShuffleQueue', 'PlayState', 'PlayNext', 'ToggleOsdMenu',
    'Play', 'SetMaxStreamingBitrate', 'SetPlaybackOrder'
  ];

  // Find the SupportedCommands block (may span multiple lines)
  const startIdx = shim.indexOf('SupportedCommands:');
  assert(startIdx !== -1, 'SupportedCommands not found');
  const endIdx = shim.indexOf(']', startIdx);
  const block = shim.substring(startIdx, endIdx);

  const advertised = [...block.matchAll(/['"]([A-Za-z]+)['"]/g)].map(m => m[1]);
  assert(advertised.length > 0, 'no SupportedCommands parsed');

  for (const cmd of advertised) {
    assert(
      jellyfinGeneralCommandTypes.includes(cmd),
      `SupportedCommands contains "${cmd}" which is not a Jellyfin GeneralCommandType — the server will reject the capabilities request with 400`
    );
  }

  // Commands the shim implements — must be advertised or the server never sends them
  for (const cmd of ['Play', 'PlayState', 'PlayNext', 'SetShuffleQueue', 'SetAudioStreamIndex',
    'SetSubtitleStreamIndex', 'SetRepeatMode', 'SetPlaybackOrder', 'Mute', 'Unmute',
    'ToggleMute', 'VolumeUp', 'VolumeDown', 'SetVolume', 'DisplayMessage', 'ToggleFullscreen']) {
    assert(
      advertised.includes(cmd),
      `SupportedCommands missing: "${cmd}"`
    );
  }
});

test('regression guards for verified mpv and Jellyfin semantics', () => {
  const shim = fs.readFileSync('shim.js', 'utf8');

  // mpv playlist-clear keeps the currently played file — rebuilding with
  // playlist-clear + playlist-play-index plays the wrong entry. Verified on
  // mpv 0.41. Use loadfile replace + insert-at (loadNewQueue) or keep the
  // current entry and insert around it (SetShuffleQueue).
  assert(
    !shim.includes("set_property', ['playlist-pos'"),
    'set_property playlist-pos is not guaranteed to start playback — use playlist-play-index'
  );

  // mpv has no runtime shuffle property; --shuffle only applies at load time.
  // Verified on mpv 0.41: playlist-shuffle / playlist-unshuffle do the work.
  assert(
    !shim.includes("set_property', ['shuffle'"),
    'set_property shuffle is a no-op — use playlist-shuffle / playlist-unshuffle'
  );

  // axios serializes array params with PHP-style brackets which ASP.NET does
  // not bind — Jellyfin then ignores the includeSegmentTypes filter. Verified
  // against a live Jellyfin 12.2 server.
  assert(
    shim.includes('paramsSerializer: { indexes: null }'),
    'MediaSegments query must use repeated keys (paramsSerializer indexes: null)'
  );

  // Jellyfin stream indices are global ff-indices; mpv aid/sid are per-type ids.
  assert(
    shim.includes('function jellyfinStreamIndexToMpvId') && shim.includes('function mpvTrackIdToJellyfinIndex'),
    'stream index <-> mpv track id mapping helpers must exist'
  );

  // Verified on mpv 0.41: playlist/N/title is read-only and loadfile's per-file
  // force-media-title only lands after an entry opens. In-memory M3U entries via
  // loadlist are the only way to show names instead of raw stream URLs (which
  // carry the ApiKey token) in the stock OSC playlist.
  assert(
    shim.includes('function buildQueueM3u') && shim.includes("sendMpvCommand('loadlist'"),
    'queue loads must go through titled M3U playlists (loadlist) for the stock OSC'
  );

  // External (sidecar) streams are not in the static container stream — without
  // sub-add/audio-add a movie whose subs are all external has no subtitle tracks
  // in mpv at all.
  assert(
    shim.includes("sendMpvCommand('sub-add'") && shim.includes("sendMpvCommand('audio-add'"),
    'external streams must be added to mpv via sub-add/audio-add'
  );

  // Jellyfin Index is not the container ff-index when external streams exist
  // (externals are numbered first) — mapping must be explicit, not ff-index only.
  assert(
    shim.includes('function buildStreamIndexMap'),
    'explicit Jellyfin<->mpv stream index map must exist'
  );
});

test('fetchEpisodeInfo returns the full payload for every item type', () => {
  const shim = fs.readFileSync('shim.js', 'utf8');
  const start = shim.indexOf('async function fetchEpisodeInfo');
  assert(start !== -1, 'fetchEpisodeInfo not found');
  const end = shim.indexOf('\nasync function ', start + 1);
  const body = shim.slice(start, end === -1 ? undefined : end);

  // Both item-type branches must share one payload — mediaStreams in
  // particular, since pushOscState and the stream index mapping read it.
  // Movies once omitted it, which hid every audio/subtitle option in the OSC.
  assert(
    body.includes('mediaStreams: item.MediaStreams || []'),
    'fetchEpisodeInfo must populate mediaStreams for all item types'
  );
  assert(
    body.includes('...info,'),
    'fetchEpisodeInfo episode branch must spread the shared payload'
  );
  assert(
    body.includes('return info;'),
    'fetchEpisodeInfo non-episode branch must return the shared payload'
  );
});

test('macos app matches the shim log contracts', () => {
  const shim = fs.readFileSync('shim.js', 'utf8');
  const npm = fs.readFileSync('macapp/Sources/NodeProcessManager.swift', 'utf8');

  // Every title contract the shim emits must have a matcher in the macapp
  for (const marker of ['Episode detected: ', 'Starting next episode: ', 'Starting previous episode: ', 'Starting episode: ']) {
    assert(shim.includes(marker), `shim.js missing title contract: "${marker}"`);
    assert(npm.includes(marker), `NodeProcessManager missing matcher for: "${marker}"`);
  }
});
