'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, makeStore, seedBrightClean, ADMIN_KEY, BRIGHT_CLEAN_INPUT } = require('./helpers');
const { createServer, unsubscribeUrl } = require('../src/server');
const { createTransport } = require('../src/transport');
const { runCycle } = require('../src/autopilot');
const { unsubscribe, unsubscribeToken } = require('../src/service');

async function start() {
  const { env, dir } = makeEnv();
  const { store, config } = makeStore(env);
  const transport = createTransport(config);
  const server = createServer({ store, config, transport });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { store, config, transport, base, close, dir };
}

async function call(base, method, path, { key, admin, body, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h['x-org-key'] = key;
  if (admin) h['x-admin-key'] = admin;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text };
}

test('health is public and admin routes reject a missing or wrong key', async () => {
  const s = await start();
  try {
    assert.equal((await call(s.base, 'GET', '/health')).status, 200);
    assert.equal((await call(s.base, 'POST', '/api/orgs', { body: BRIGHT_CLEAN_INPUT })).status, 401);
    assert.equal((await call(s.base, 'POST', '/api/orgs', { admin: 'wrong-key', body: BRIGHT_CLEAN_INPUT })).status, 401);
    assert.equal((await call(s.base, 'GET', '/api/nope')).status, 404);
    // The path exists with POST only, so GET is a method error, not a missing route.
    assert.equal((await call(s.base, 'GET', '/api/orgs')).status, 405);
  } finally {
    await s.close();
  }
});

test('an organisation key only sees its own data; the other tenant gets 404 or an empty list', async () => {
  const s = await start();
  try {
    const a = seedBrightClean(s.store, {});
    const other = await call(s.base, 'POST', '/api/orgs', {
      admin: ADMIN_KEY, body: { ...BRIGHT_CLEAN_INPUT, name: 'Other Cleaning Co', legalName: 'Other Cleaning Co' },
    });
    assert.equal(other.status, 201);
    const otherKey = other.json.apiKey;

    await runCycle({ store: s.store, config: s.config, transport: s.transport, now: new Date('2026-11-01T12:00:00Z') });
    const aBids = await call(s.base, 'GET', '/api/bids', { key: a.apiKey });
    assert.ok(aBids.json.length > 0, 'tenant A has bids');
    const bidId = aBids.json[0].id;

    const otherBids = await call(s.base, 'GET', '/api/bids', { key: otherKey });
    assert.deepEqual(otherBids.json, []);
    const crossApprove = await call(s.base, 'POST', `/api/bids/${bidId}/approve`, { key: otherKey });
    assert.equal(crossApprove.status, 404, 'tenant B cannot touch tenant A bid');
    const crossWithdraw = await call(s.base, 'POST', `/api/bids/${bidId}/withdraw`, { key: otherKey });
    assert.equal(crossWithdraw.status, 404);
    const crossAudit = await call(s.base, 'GET', '/api/audit', { key: otherKey });
    assert.ok(crossAudit.json.every((e) => e.orgId !== a.org.id));
  } finally {
    await s.close();
  }
});

test('an organisation built from the unfilled template is refused', async () => {
  const s = await start();
  try {
    const template = require('fs').readFileSync(require('path').resolve(__dirname, '..', 'data', 'examples', 'brightclean.org.example.json'), 'utf8');
    const { _comment, ...body } = JSON.parse(template);
    const res = await call(s.base, 'POST', '/api/orgs', { admin: ADMIN_KEY, body });
    assert.equal(res.status, 400);
    assert.ok(res.json.details.some((d) => /REPLACE/.test(d)));
    assert.equal(s.store.list('orgs', null).length, 0, 'no tenant was created');
  } finally {
    await s.close();
  }
});

test('the API key is shown once and only its hash is stored', async () => {
  const s = await start();
  try {
    const created = await call(s.base, 'POST', '/api/orgs', { admin: ADMIN_KEY, body: BRIGHT_CLEAN_INPUT });
    const org = s.store.list('orgs', null)[0];
    assert.equal(org.apiKey, undefined);
    assert.ok(org.apiKeyHash && org.apiKeyHash.length === 64);
    assert.ok(!JSON.stringify(s.store.list('orgs', null)).includes(created.json.apiKey));
    const me = await call(s.base, 'GET', '/api/me', { key: created.json.apiKey });
    assert.equal(me.status, 200);
    assert.equal(me.json.apiKeyHash, undefined, 'hash is never returned');
  } finally {
    await s.close();
  }
});

test('invalid organisation and invalid estimate inputs return 400 with reasons', async () => {
  const s = await start();
  try {
    const bad = await call(s.base, 'POST', '/api/orgs', { admin: ADMIN_KEY, body: { name: 'x' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.details.some((d) => /postalAddress/.test(d)));
    const created = seedBrightClean(s.store, {});
    const est = await call(s.base, 'POST', '/api/estimates', {
      key: created.apiKey, body: { squareFeet: -5, productionRate: 1000, laborRate: 30 },
    });
    assert.equal(est.status, 400);
    const ok = await call(s.base, 'POST', '/api/estimates', {
      key: created.apiKey, body: { squareFeet: 10000, productionRate: 2000, laborRate: 40, burdenPct: 0.2, supervisionPct: 0.1, overheadPct: 0.1, marginPct: 0.25, materialsPerSqFt: 0.05, equipmentPerDay: 100, days: 2 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.total, 1413.87);
  } finally {
    await s.close();
  }
});

test('unsubscribe requires a valid HMAC token and then blocks the address', async () => {
  const s = await start();
  try {
    const created = seedBrightClean(s.store, {});
    const email = 'estimator@demo-gc.example';
    assert.equal((await call(s.base, 'GET', `/api/unsubscribe?email=${email}&token=bad`)).status, 400);
    const url = unsubscribeUrl(s.config, email);
    assert.ok(url.startsWith('http://buildintel.test/api/unsubscribe?'));
    const token = new URL(url).searchParams.get('token');
    assert.equal(token, unsubscribeToken(s.config.unsubscribeSecret, email));
    const path = `/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
    const res = await call(s.base, 'GET', path);
    assert.equal(res.status, 200);
    assert.match(res.text, /unsubscribed/i);
    const contact = s.store.list('contacts', created.org.id)[0];
    assert.equal(contact.status, 'opted_out');
  } finally {
    await s.close();
  }
});

test('the go-live gate reports NO-GO until every owner input is provided', async () => {
  const s = await start();
  try {
    const res = await call(s.base, 'GET', '/api/readiness', { admin: ADMIN_KEY });
    assert.equal(res.status, 200);
    assert.equal(res.json.goLive, false);
    const failing = res.json.gates.filter((g) => g.status !== 'pass').map((g) => g.id);
    assert.ok(failing.includes('authorized_sources'));
    assert.ok(failing.includes('policies_approved'));
    assert.ok(failing.includes('live_email'));
    assert.ok(failing.includes('payments'));
  } finally {
    await s.close();
  }
});
