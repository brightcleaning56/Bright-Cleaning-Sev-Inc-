#!/usr/bin/env node
// Writes BUILD_MANIFEST.json: the build fingerprint (same calculation as the live /health "build" field) + every file's hash.
const path = require('path'), fs = require('fs'), b = require('../buildinfo').compute(path.join(__dirname, '..'));
fs.writeFileSync(path.join(__dirname, '..', 'BUILD_MANIFEST.json'), JSON.stringify({ generated: new Date().toISOString(), fingerprint: b.fingerprint, short: b.fingerprint.slice(0, 12), files: b.files, list: b.list }, null, 1));
console.log(`build ${b.fingerprint.slice(0, 12)} (${b.files} files)`);
