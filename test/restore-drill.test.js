import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createBackup } from '../src/backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'a'.repeat(64), WRONG = 'b'.repeat(64);
const run = (file, key) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'scripts/restore-drill.mjs'), file], { env: { ...process.env, BACKUP_KEY: key }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

test('the restore drill proves a backup with the right key, refuses a wrong key, and catches a checksum mismatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-drill-'));
  const store = new Store(null);
  store.put('orgs', { slug: 'gc', name: 'ABC', kind: 'buyer', status: 'active', settings: {} });
  const b = createBackup(store, dir, KEY);
  fs.writeFileSync(`${b.file}.sha256`, b.checksum + '\n');
  const ok = run(b.file, KEY);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /RESTORE OK: checksum matches/);
  const bad = run(b.file, WRONG);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /does not match this backup/);
  fs.writeFileSync(`${b.file}.sha256`, 'deadbeef\n');
  const mismatch = run(b.file, KEY);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.out, /CHECKSUM MISMATCH/);
});
