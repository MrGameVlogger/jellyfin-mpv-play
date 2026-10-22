import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

test('shim.js has valid JavaScript syntax', () => {
  try {
    execSync('node --check shim.js', { encoding: 'utf8' });
  } catch (e) {
    assert.fail(`shim.js has syntax errors:\n${e.stderr}`);
  }
});

test('config.example.js is valid JavaScript', () => {
  const config = require('../config.example.js');
  assert(typeof config === 'object', 'config.example.js should export an object');
  assert(config !== null, 'config.example.js should not export null');
});

test('config.example.js has required options', () => {
  const config = require('../config.example.js');

  const requiredKeys = [
    'serverUrl',
    'username',
    'password',
    'mpvPath',
    'deviceName',
    'deviceId'
  ];

  for (const key of requiredKeys) {
    assert(key in config, `Missing required config key: "${key}"`);
  }
});

test('CONFIG object in shim.js has all expected properties', () => {
  const shim = fs.readFileSync('shim.js', 'utf8');

  const expectedConfig = [
    'serverUrl',
    'username',
    'password',
    'apiKey',
    'mpvPath',
    'deviceName',
    'deviceId',
    'clientVersion',
    'ipcSocketPath',
    'mpvLoadDelayMs',
    'fullscreen',
    'autoClose',
    'mpvFlags',
    'headless',
    'autoSkipIntros',
    'disableSkipIntro',
    'verbose',
    'wsPresenceSocket'
  ];

  for (const key of expectedConfig) {
    assert(
      shim.includes(`${key}:`) || shim.includes(`${key} :`),
      `Missing CONFIG property: "${key}"`
    );
  }
});

test('config.example.js documents all CONFIG options', () => {
  const configExample = fs.readFileSync('config.example.js', 'utf8');

  const documentedOptions = [
    'serverUrl',
    'username',
    'password',
    'apiKey',
    'mpvPath',
    'deviceName',
    'deviceId',
    'ipcSocketPath',
    'fullscreen',
    'autoClose',
    'mpvFlags',
    'headless',
    'autoSkipIntros',
    'disableSkipIntro',
    'verbose',
    'wsPresenceSocket'
  ];

  for (const option of documentedOptions) {
    assert(
      configExample.includes(option),
      `Config option not documented in config.example.js: "${option}"`
    );
  }
});

test('macOS Preferences panel supports apiKey', () => {
  const prefs = fs.readFileSync('macapp/Sources/PreferencesWindowController.swift', 'utf8');

  // The Settings panel is the macOS config editor — an option that exists only
  // in config.example.js is invisible to Mac users. apiKey must be a managed
  // key (load + save) so it round-trips through the UI.
  assert(prefs.includes('private var apiKeyField'), 'Preferences must declare an apiKey field');
  assert(/"apiKey"/.test(prefs), 'Preferences must manage the "apiKey" config key');
  assert(
    prefs.includes('key: "apiKey"'),
    'Preferences must read apiKey from the config on load'
  );
});
