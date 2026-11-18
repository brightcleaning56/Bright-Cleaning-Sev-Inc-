// Two-step sign-in replay checks (F-14.3a: a code is single-use; F-14.3b: a challenge is single-use).
// Runs on an in-memory database with the real mfa.js and totp.js. No server, no email, no provider.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mfa-replay-test-secret';
const assert = require('assert');
const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const totp = require('../totp');
const mountMfa = require('../mfa');

const EMAIL = 'owner@example.test';
const db = new Database(':memory:');
db.exec(`CREATE TABLE admin_users(id INTEGER PRIMARY KEY, email TEXT, last_login_at TEXT);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);`);
db.prepare('INSERT INTO admin_users(email) VALUES(?)').run(EMAIL);

const app = express();
app.use(express.json());
mountMfa(app, {
  db,
  auth: (req, res, next) => { req.user = { email: EMAIL }; next(); },
  jwt,
  rateLimit: () => (req, res, next) => next(),
  signToken: email => 'token-for-' + email,
  logAction: () => {},
  clean: s => String(s || '').trim(),
});

const secret = totp.newSecret();
db.prepare('INSERT INTO mfa_factors(email, secret, enabled, created_at, enabled_at) VALUES(?, ?, 1, ?, ?)')
  .run(EMAIL, secret, new Date().toISOString(), new Date().toISOString());

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (mfaToken, code) => {
    const r = await fetch(base + '/api/admin/login/mfa', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mfa_token: mfaToken, code }),
    });
    return r.status;
  };
  const counter = Math.floor(Date.now() / 1000 / 30);
  const codeNow = totp.codeAt(secret, counter);
  const codeNext = totp.codeAt(secret, counter + 1);
  let passed = 0;
  const total = 6;
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (e) { console.log('FAIL ' + name + ' -> ' + e.message); process.exitCode = 1; }
  };
  try {
    await check('a valid code with a fresh challenge signs in', async () => {
      assert.strictEqual(await post(mountMfa.challenge(EMAIL), codeNow), 200);
    });
    await check('the same code with a second fresh challenge is refused (code replay)', async () => {
      assert.strictEqual(await post(mountMfa.challenge(EMAIL), codeNow), 401);
    });
    const reused = mountMfa.challenge(EMAIL);
    await check('a challenge that already completed sign-in is refused (challenge reuse)', async () => {
      // A malformed code is refused and must not use up the challenge.
      assert.strictEqual(await post(reused, 'abc'), 401);
      assert.strictEqual(await post(reused, codeNext), 200);
      assert.strictEqual(await post(reused, codeNext), 401);
    });
    await check('a challenge without an id is refused', async () => {
      const legacy = jwt.sign({ purpose: 'mfa', email: EMAIL }, process.env.JWT_SECRET, { expiresIn: '5m' });
      assert.strictEqual(await post(legacy, codeNext), 401);
    });
    await check('an older step cannot be used after a newer one', async () => {
      assert.strictEqual(await post(mountMfa.challenge(EMAIL), codeNow), 401);
    });
    const logged = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='two-step sign-in refused'").get().n;
    await check('refused replays are written to the audit log', async () => {
      assert.ok(logged >= 2, 'expected at least 2 refusals logged, got ' + logged);
    });
    console.log(`\n${passed}/${total} checks passed`);
  } finally {
    server.close();
    db.close();
  }
});
