import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { hashPassword, sign } from '../src/security.js';
import { world } from './_fixtures.js';

async function boot() {
  const w = world();
  w.store.put('users', { email: 'eric@test', passwordHash: hashPassword('correct horse battery'), role: 'platform_owner', orgId: w.org.id });
  w.store.put('users', { email: 'crew@test', passwordHash: hashPassword('crew member password'), role: 'member', orgId: w.org.id });
  const other = w.store.put('orgs', { slug: 'other', name: 'Other Co', status: 'active', legal: {}, settings: {} });
  w.store.put('users', { email: 'other@test', passwordHash: hashPassword('other owner password'), role: 'owner', orgId: other.id });
  w.store.tput('bids', other.id, { status: 'draft', total: 99 });
  const srv = createServer(w.store).listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  };
  const login = async (email, password) => (await call('POST', '/api/login', { email, password })).body.token;
  return { ...w, srv, call, login, other };
}

test('auth, roles and tenant scoping over HTTP', async (t) => {
  const { srv, call, login, org } = await boot();
  t.after(() => srv.close());
  assert.equal((await call('GET', '/api/bids')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'eric@test', password: 'wrong password here' })).status, 401);
  const eric = await login('eric@test', 'correct horse battery');
  const crew = await login('crew@test', 'crew member password');
  const other = await login('other@test', 'other owner password');
  assert.equal((await call('GET', '/api/readiness', undefined, eric)).body.verdict, 'NO-GO');
  assert.equal((await call('GET', '/api/readiness', undefined, crew)).status, 403);
  assert.equal((await call('POST', '/api/rate-cards', {}, crew)).status, 403);
  // other org's owner sees only their own bid, never Bright Clean's data
  const ob = (await call('GET', '/api/bids', undefined, other)).body;
  assert.equal(ob.length, 1); assert.equal(ob[0].total, 99);
  assert.equal((await call('GET', '/api/rate-cards', undefined, other)).body.length, 0);
  assert.equal((await call('POST', `/api/bids/${ob[0].id}/approve`, {}, eric)).status, 404); // cross-tenant id → not found
  // activation requires legal identity
  assert.equal((await call('PATCH', '/api/org', { legal: { postalAddress: '' } }, eric)).status, 200);
  const act = await call('POST', '/api/org/activate', {}, eric);
  assert.equal(act.status, 400); assert.match(act.body.error, /postalAddress/);
  assert.equal((await call('PATCH', '/api/org', { settings: { liveSending: true } }, eric)).status, 400);
});

test('login is rate limited', async (t) => {
  const { srv, call } = await boot();
  const prev = config.loginRateLimit; config.loginRateLimit = 10; // production default
  t.after(() => { srv.close(); config.loginRateLimit = prev; });
  let last;
  for (let i = 0; i < 12; i++) last = await call('POST', '/api/login', { email: 'x@test', password: 'nope nope nope' }, null, { 'X-Forwarded-For': '9.9.9.9' });
  assert.equal(last.status, 429);
});

test('unsubscribe link suppresses across all tenants; forged links rejected', async (t) => {
  const { srv, call, store } = await boot();
  t.after(() => srv.close());
  const tok = sign({ e: 'pat@weitz.test', t: 1 });
  assert.equal((await call('GET', '/u/' + tok)).status, 200);
  assert.equal(store.isSuppressed('pat@weitz.test'), false); // GET alone does not unsubscribe (link scanners)
  assert.equal((await call('POST', '/u/' + tok)).status, 200);
  assert.equal(store.isSuppressed('pat@weitz.test'), true);
  assert.equal((await call('POST', '/u/' + tok.slice(0, -2) + 'xx')).status, 400);
});

test('stripe webhook: valid signature updates subscription, invalid rejected', async (t) => {
  const { srv, call, store, other } = await boot();
  t.after(() => { srv.close(); config.stripeWebhookSecret = ''; });
  config.stripeWebhookSecret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.payment_failed', data: { object: { metadata: { orgId: other.id } } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${payload}`).digest('hex');
  assert.equal((await call('POST', '/webhooks/stripe', payload, null, { 'stripe-signature': `t=${ts},v1=bad` })).status, 400);
  assert.equal((await call('POST', '/webhooks/stripe', payload, null, { 'stripe-signature': `t=${ts},v1=${sig}` })).status, 200);
  assert.equal(store.get('orgs', other.id).subscription.status, 'past_due');
});

test('privacy requests: opt-out suppresses immediately; deletion removes contact records', async (t) => {
  const { srv, call, login, store } = await boot();
  t.after(() => srv.close());
  assert.equal((await call('POST', '/api/privacy/requests', { email: 'pat@weitz.test', type: 'delete' })).status, 200);
  const eric = await login('eric@test', 'correct horse battery');
  const [req] = (await call('GET', '/api/privacy/requests', undefined, eric)).body;
  const r = await call('POST', `/api/privacy/requests/${req.id}/resolve`, {}, eric);
  assert.equal(r.body.matchedContacts, 1);
  assert.equal(store.list('contacts', c => c.email === 'pat@weitz.test').length, 0);
  assert.equal(store.isSuppressed('pat@weitz.test'), true);
});

test('contacts API refuses invented or personal data', async (t) => {
  const { srv, call, login, gc } = await boot();
  t.after(() => srv.close());
  const eric = await login('eric@test', 'correct horse battery');
  const bad = await call('POST', '/api/contacts', { companyId: gc.id, name: 'X', email: 'x@weitz.test', status: 'verified' }, eric);
  assert.equal(bad.status, 400); assert.match(bad.body.error, /evidenceUrl/);
  const ok = await call('POST', '/api/contacts', { companyId: gc.id, name: 'Y', email: 'y@weitz.test', status: 'source_confirmed', evidenceUrl: 'https://weitz.test/team' }, eric);
  assert.equal(ok.status, 200);
});

test('run-now answers immediately and reports status', async (t) => {
  const { srv, call, login } = await boot();
  t.after(() => srv.close());
  const eric = await login('eric@test', 'correct horse battery');
  const t0 = Date.now();
  const r = await call('POST', '/api/cycle', {}, eric);
  assert.equal(r.status, 200); assert.ok('started' in r.body); assert.ok(Date.now() - t0 < 2000);
  assert.equal((await call('GET', '/api/cycle', undefined, eric)).status, 200);
});

test('links: javascript: URLs are refused for directory entries and contacts', async (t) => {
  const { srv, call, login, gc } = await boot();
  t.after(() => srv.close());
  const eric = await login('eric@test', 'correct horse battery');
  assert.equal((await call('POST', '/api/companies', { name: 'Evil Co', website: 'javascript:alert(1)' }, eric)).status, 400);
  const bad = await call('POST', '/api/contacts', { companyId: gc.id, name: 'Z', email: 'z@weitz.test', status: 'source_confirmed', evidenceUrl: 'javascript:alert(1)' }, eric);
  assert.equal(bad.status, 400); assert.match(bad.body.error, /http\(s\)/);
  assert.equal((await call('POST', '/api/companies', { name: 'Good Co', website: 'https://good.test' }, eric)).status, 200);
});

test('test email: explains exactly what is missing, sends when live', async (t) => {
  const { srv, call, login } = await boot();
  t.after(() => { srv.close(); Object.assign(config, { platformFrom: '', emailMode: 'dry-run' }); });
  const eric = await login('eric@test', 'correct horse battery');
  assert.match((await call('POST', '/api/admin/test-email', {}, eric)).body.problem, /PLATFORM_FROM/);
  config.platformFrom = 'alerts@buildintel.test';
  assert.match((await call('POST', '/api/admin/test-email', {}, eric)).body.problem, /dry-run/);
  const crew = await login('crew@test', 'crew member password');
  assert.equal((await call('POST', '/api/admin/test-email', {}, crew)).status, 403);
});

test('sign-in brute-force limit: 10 attempts per 15 minutes by default', async (t) => {
  const { srv } = await boot();
  const prev = config.loginRateLimit; config.loginRateLimit = 10; // the production default
  t.after(() => { srv.close(); config.loginRateLimit = prev; });
  // Its own client address, so it only uses up its own allowance (other tests keep signing in normally).
  const base = `http://127.0.0.1:${srv.address().port}`;
  const attempt = () => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ email: 'nobody@x.test', password: 'wrong password 123' }) });
  const codes = []; for (let i = 0; i < 11; i++) codes.push((await attempt()).status);
  assert.ok(codes.slice(0, 10).every(c => c === 401)); assert.equal(codes[10], 429);
});

test('release identifier (owner only) and honest coverage', async (t) => {
  process.env.RENDER_GIT_COMMIT = 'abc1234def';
  const { srv, call, login } = await boot();
  t.after(() => { srv.close(); delete process.env.RENDER_GIT_COMMIT; });
  const eric = await login('eric@test', 'correct horse battery');
  const rl = (await call('GET', '/api/release', undefined, eric)).body;
  assert.equal(rl.commit, 'abc1234def'); assert.match(rl.version, /^\d+\.\d+\.\d+$/); assert.ok(rl.startedAt);
  const crew = await login('crew@test', 'crew member password');
  assert.equal((await call('GET', '/api/release', undefined, crew)).status, 403);
  const cov = (await call('GET', '/api/coverage', undefined, eric)).body;
  assert.ok(cov.rows.some(r => r.status === 'off'));               // owner sees switched-off feeds with their notes
  assert.equal(cov.summary.liveSources, cov.rows.filter(r => r.status === 'live').length);
  assert.ok(cov.rows.filter(r => r.status === 'live').every(r => r.authorized)); // "live" always means terms recorded
});
