// Checks the operator console (Phase A): sign-in, the status API, drift and down detection.
// Uses fake company health endpoints, so it never calls a live system. Run: node tests/operator-test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const bcrypt = require('bcryptjs');
const totp = require('../totp');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));
const password = 'operator-password-123';
const secret = totp.newSecret();

function fakeCompany(body, status = 200) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

(async () => {
  const good = await fakeCompany({ ok: true, db: 'ok', build: 'aaa111bbb222', errors_1h: 0 });
  const drift = await fakeCompany({ ok: true, db: 'ok', build: 'ccc333ddd444', errors_1h: 0 });
  const down = await fakeCompany({ error: 'x' }, 500);
  const base = url => 'http://127.0.0.1:' + url.address().port + '/api/health';
  const registry = path.join(work, 'companies.json');
  fs.writeFileSync(registry, JSON.stringify({ companies: [
    { slug: 'good', name: 'Good Co', health_url: base(good), expected_build: 'aaa111bbb222' },
    { slug: 'drift', name: 'Drift Co', health_url: base(drift), expected_build: 'aaa111bbb222' },
    { slug: 'down', name: 'Down Co', health_url: base(down), expected_build: 'aaa111bbb222' }
  ] }));

  Object.assign(process.env, {
    OPS_REGISTRY: registry, OPS_ADMIN_EMAIL: 'owner@brightclean.test',
    OPS_PASSWORD_HASH: bcrypt.hashSync(password, 10), OPS_TOTP_SECRET: secret, OPS_SESSION_SECRET: 'test-session-secret-0123456789abcdef'
  });
  const ops = require('../operator/server.js');
  const server = await ops.startServer(0);
  const B = 'http://127.0.0.1:' + server.address().port;
  let passed = 0;
  const ok = name => { passed++; console.log('ok - ' + name); };

  const health = await fetch(B + '/ops/health');
  assert.strictEqual(health.status, 200); ok('operator health endpoint answers');

  assert.strictEqual((await fetch(B + '/api/status')).status, 401); ok('status is refused without signing in');

  const wrong = await fetch(B + '/ops/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@brightclean.test', password: 'wrong-password-123', code: '000000' }) });
  assert.strictEqual(wrong.status, 401); ok('wrong password is refused');

  const code = totp.codeAt(secret, Math.floor(Date.now() / 30000));
  const right = await fetch(B + '/ops/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@brightclean.test', password, code }) });
  assert.strictEqual(right.status, 200, 'correct password and code should sign in');
  const cookie = right.headers.get('set-cookie').split(';')[0];
  ok('correct password and two-step code sign in');

  const poll = await fetch(B + '/api/poll', { method: 'POST', headers: { Cookie: cookie } });
  assert.strictEqual((await poll.json()).checked, 3); ok('a check runs for all three companies');

  const list = await (await fetch(B + '/api/status', { headers: { Cookie: cookie } })).json();
  const by = Object.fromEntries(list.companies.map(c => [c.slug, c]));
  assert.strictEqual(by.good.ok, true); assert.strictEqual(by.good.problem, ''); ok('a healthy copy on the expected build shows no problem');
  assert.match(by.drift.problem, /expected aaa111bbb222/); ok('a copy on another build is flagged as build drift');
  assert.match(by.down.problem, /HTTP 500/); assert.strictEqual(by.down.ok, false); ok('a copy returning an error is shown as down');

  const board = await fetch(B + '/', { headers: { Cookie: cookie } });
  assert.match(await board.text(), /Operator console/); ok('the status board loads when signed in');

  await new Promise(r => server.close(r));
  for (const s of [good, drift, down]) await new Promise(r => s.close(r));
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
