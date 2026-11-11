import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regression: the real server entry point must keep running after its timers fire. A bad reference inside a timer
// crashed production every minute and no unit test ran that code, so this starts the actual process with a short timer.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('the server entry point keeps running after its periodic jobs fire', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, SCHEDULER: "on", PORT: String(port), APP_SECRET: 'x'.repeat(40), EMAIL_MODE: 'dry-run', NODE_ENV: 'test',
    DOC_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bi-entry-docs-')), BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bi-entry-bk-')),
    OUTBOX_INTERVAL_MS: '150' };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', exited = null;
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  try {
    const deadline = Date.now() + 15000;
    while (!out.includes('BUILDINTEL on') && Date.now() < deadline && !exited) await new Promise(r => setTimeout(r, 100));
    assert.ok(out.includes('BUILDINTEL on'), 'server started: ' + out.slice(-400));
    await new Promise(r => setTimeout(r, 1200));   // several timer ticks
    assert.equal(exited, null, 'the process must not exit after a timer fires: ' + out.slice(-600));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  } finally {
    if (!exited) child.kill('SIGTERM');
  }
});
