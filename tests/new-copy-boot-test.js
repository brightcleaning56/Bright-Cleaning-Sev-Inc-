// Boots a server from the settings the copy script generates, then checks health and admin sign-in.
// This is the staging rehearsal: it runs locally and calls no provider.
// Run: node tests/new-copy-boot-test.js
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-boot-'));
const password = 'rehearsal-password-123';
const email = 'owner@rehearsal.example';

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'new-company-copy.js'),
  '--name', 'Rehearsal Co', '--slug', 'rehearsal', '--domain', 'rehearsal.example',
  '--admin-email', email, '--out', work], { encoding: 'utf8' });

const env = {};
for (const line of fs.readFileSync(path.join(work, 'rehearsal', 'env.txt'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (!m || /SET-IN-PROVIDER/.test(m[2])) continue; // provider secrets stay unset in the rehearsal
  env[m[1]] = m[2];
}
// Sign-in needs the hash for the password the rehearsal uses (create-admin.js prints this in production).
env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(password, 12);
env.ADMIN_EMAIL = email;

const port = 3960 + Math.floor(Math.random() * 30);
const base = `http://127.0.0.1:${port}`;
const dataDir = path.join(work, 'data');
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...env, PORT: String(port), DATA_DIR: dataDir, UPLOAD_DIR: path.join(work, 'uploads'), DISABLE_SCHEDULER: '1', DOTENV_CONFIG_PATH: '/nonexistent' }
});
let log = '';
child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let health = null;
  for (let i = 0; i < 80 && !health; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) health = await r.json(); } catch { }
    if (!health) await sleep(150);
  }
  assert.ok(health, 'Server did not start from the generated settings:\n' + log);
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.db, 'ok');
  console.log('ok - server boots from generated settings and reports healthy');

  const wrong = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'wrong-password-123' }) });
  assert.strictEqual(wrong.status, 401, 'wrong password should be refused');
  console.log('ok - wrong password is refused');

  const right = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.ok(right.status === 200, 'correct password should reach sign-in (got ' + right.status + ')');
  console.log('ok - correct password reaches sign-in (status ' + right.status + ')');
})().then(() => {
  child.kill(); fs.rmSync(work, { recursive: true, force: true }); console.log('\n3 checks passed');
}).catch(e => {
  child.kill(); fs.rmSync(work, { recursive: true, force: true }); console.error('FAIL: ' + e.message); process.exit(1);
});
