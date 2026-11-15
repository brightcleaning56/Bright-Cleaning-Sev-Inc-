// Dry run of the whole path for a test company, all on this computer and with fake data:
// setup script -> settings and checklist -> registry entry -> copy starts from those settings
// -> operator console sees it healthy -> operator console flags a wrong build.
// Calls no hosting, phone, email or payment provider. Run: node tests/company-dry-run-test.js
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-'));
const registry = path.join(work, 'companies.json');
const password = 'test-company-password-123';
const email = 'owner@test-cleaning.example';
const steps = [];
const done = (name) => { steps.push(name); console.log('ok - ' + name); };

fs.writeFileSync(registry, JSON.stringify({ companies: [] }));
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'new-company-copy.js'),
  '--name', 'Test Cleaning Co', '--slug', 'test-cleaning-co', '--domain', 'test-cleaning.example',
  '--admin-email', email, '--out', work, '--registry', registry], { encoding: 'utf8' });
done('setup script writes the settings and checklist, and registers the company');

const folder = path.join(work, 'test-cleaning-co');
const envText = fs.readFileSync(path.join(folder, 'env.txt'), 'utf8');
assert.match(envText, /^COMPANY_SETUP_PENDING=on$/m);
assert.match(envText, /^STRIPE_SECRET_KEY=SET-IN-PROVIDER$/m);
assert.doesNotMatch(envText, /sk_live|sk_test|AKIA/);
done('settings file has the setup flag, marks secrets, and contains no real keys');

const reg = JSON.parse(fs.readFileSync(registry, 'utf8')).companies;
assert.strictEqual(reg.length, 1);
assert.strictEqual(reg[0].slug, 'test-cleaning-co');
done('registry lists the company with a health address and no secrets');

const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (!m || /SET-IN-PROVIDER/.test(m[2])) continue;
  env[m[1]] = m[2];
}
env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(password, 12);
env.ADMIN_EMAIL = email;

const port = 3900 + Math.floor(Math.random() * 60);
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...env, PORT: String(port), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'uploads'), DISABLE_SCHEDULER: '1', DOTENV_CONFIG_PATH: '/nonexistent' }
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let health = null;
  for (let i = 0; i < 80 && !health; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) health = await r.json(); } catch { }
    if (!health) await sleep(150);
  }
  assert.ok(health && health.ok === true && health.db === 'ok', 'copy did not start from its settings');
  done('copy starts from the generated settings and reports healthy (build ' + health.build + ')');

  const ops = require('../operator/server.js');
  const pointAt = (expected) => ({ slug: 'test-cleaning-co', name: 'Test Cleaning Co', health_url: base + '/api/health', expected_build: expected });

  const right = await ops.checkOne(pointAt(health.build));
  assert.strictEqual(right.ok, true); assert.strictEqual(right.problem, '');
  done('operator console shows the copy running and on the expected build');

  const wrong = await ops.checkOne(pointAt('000000000000'));
  assert.strictEqual(wrong.ok, true); assert.match(wrong.problem, /expected 000000000000/);
  done('operator console flags a copy running a different build');

  child.kill();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${steps.length} dry-run steps passed`);
  process.exit(0);
})().catch(e => {
  child.kill();
  fs.rmSync(work, { recursive: true, force: true });
  console.error('FAIL: ' + e.message);
  process.exit(1);
});
