// Checks scripts/new-company-copy.js: writes the two files, refuses bad input, never overwrites.
// Run: node tests/new-company-copy-test.js
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const script = path.join(__dirname, '..', 'scripts', 'new-company-copy.js');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const base = ['--name', 'Acme Cleaning', '--domain', 'acmeclean.com', '--admin-email', 'Owner@AcmeClean.com', '--out', out];

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok - ' + name); }

check('writes env.txt and CHECKLIST.md with secrets marked', () => {
  const r = run([...base, '--slug', 'acme', '--tz', 'America/Chicago']);
  assert.strictEqual(r.status, 0, r.stderr);
  const env = fs.readFileSync(path.join(out, 'acme', 'env.txt'), 'utf8');
  assert.match(env, /^ADMIN_EMAIL=owner@acmeclean\.com$/m);
  assert.match(env, /^PUBLIC_BASE_URL=https:\/\/acmeclean\.com$/m);
  assert.match(env, /^STRIPE_SECRET_KEY=SET-IN-PROVIDER$/m);
  assert.match(env, /^JWT_SECRET=[0-9a-f]{96}$/m);
  assert.ok(fs.existsSync(path.join(out, 'acme', 'CHECKLIST.md')));
});

check('refuses to overwrite an existing folder', () => {
  const r = run([...base, '--slug', 'acme']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /already exists/);
});

check('rejects a bad slug', () => {
  assert.strictEqual(run([...base, '--slug', 'Bad Slug']).status, 1);
});

check('rejects an invalid time zone', () => {
  assert.strictEqual(run([...base, '--slug', 'tz-test', '--tz', 'Not/AZone']).status, 1);
});

check('rejects a missing name', () => {
  assert.strictEqual(run(['--slug', 'noname', '--domain', 'x.com', '--admin-email', 'a@x.com', '--out', out]).status, 1);
});

check('adds the company to the operator registry when asked', () => {
  const reg = path.join(out, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ companies: [] }));
  const r = run([...base, '--slug', 'regco', '--registry', reg]);
  assert.strictEqual(r.status, 0, r.stderr);
  const list = JSON.parse(fs.readFileSync(reg, 'utf8')).companies;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].health_url, 'https://acmeclean.com/api/health');
  assert.strictEqual(list[0].expected_build, '');
});

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
