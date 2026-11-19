#!/usr/bin/env node
// Encrypt password and apiKey in config.js so they are not stored in
// clear text. Run: node encrypt-config.js
//
// Values that are already encrypted (start with "enc:") are skipped.
// The shim decrypts them automatically at startup.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = process.argv[2] || 'config.js';

if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`Error: ${CONFIG_FILE} not found. Create one from config.example.js first.`);
    process.exit(1);
}

// Derive the Fernet key from machine identity (matches shim.js and config_parser.py)
function deriveFernetKey() {
    const os = require('os');
    const material = `${os.hostname()}:${os.userInfo().username}:jf-mpv-play`;
    const salt = 'jf-mpv-play-config-key-v1';
    const rawKey = crypto.pbkdf2Sync(material, salt, 390000, 32, 'sha256');
    const b64 = rawKey.toString('base64url');
    return b64 + '='.repeat((4 - b64.length % 4) % 4);
}

// Encrypt a value using Fernet (AES-128-CBC + HMAC-SHA256)
function encryptValue(plaintext) {
    if (!plaintext || plaintext.startsWith('enc:')) return plaintext;
    const fernet = require('fernet');
    const secret = new fernet.Secret(deriveFernetKey());
    const token = new fernet.Token({ secret, message: plaintext, time: new Date() });
    return 'enc:' + token.encode();
}

const content = fs.readFileSync(CONFIG_FILE, 'utf8');
let changed = false;

// Encrypt password field
const updated = content.replace(
    /(\bpassword:\s*)'([^']*)'/g,
    (match, prefix, value) => {
        if (!value || value.startsWith('enc:')) return match;
        changed = true;
        return prefix + "'" + encryptValue(value) + "'";
    }
).replace(
    /(\bapiKey:\s*)'([^']*)'/g,
    (match, prefix, value) => {
        if (!value || value.startsWith('enc:')) return match;
        changed = true;
        return prefix + "'" + encryptValue(value) + "'";
    }
);

if (changed) {
    fs.writeFileSync(CONFIG_FILE, updated, { mode: 0o600 });
    console.log(`Encrypted password and apiKey in ${CONFIG_FILE}`);
} else {
    console.log('Nothing to encrypt — password/apiKey are already encrypted or empty.');
}
