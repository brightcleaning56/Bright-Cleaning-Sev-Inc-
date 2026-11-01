'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, makeStore, seedBrightClean, ADMIN_KEY } = require('./helpers');
const { createServer } = require('../src/server');
const { createTransport } = require('../src/transport');

async function start() {
  const { env } = makeEnv();
  const { store, config } = makeStore(env);
  const transport = createTransport(config);
  const server = createServer({ store, config, transport });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, config, base, close: () => new Promise((r) => server.close(r)) };
}

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test('the owner console is served with a strict content security policy', async () => {
  const s = await start();
  try {
    const res = await get(s.base, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline.*script|script-src[^;]*unsafe/);
    assert.match(res.text, /<script src="\/app\.js"><\/script>/);
    assert.doesNotMatch(res.text, /<script>[^<]/, 'no inline script blocks');
    assert.equal((await get(s.base, '/app.js')).status, 200);
    assert.equal((await get(s.base, '/app.css')).status, 200);
  } finally {
    await s.close();
  }
});

test('only whitelisted static files are served, so paths outside public/ are not reachable', async () => {
  const s = await start();
  try {
    for (const p of ['/package.json', '/../package.json', '/%2e%2e/package.json', '/src/server.js', '/data/readiness.json']) {
      const res = await get(s.base, p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(res.text, /"name": "buildintel"/);
    }
  } finally {
    await s.close();
  }
});

test('the owner admin key can act on a tenant with x-org-id, and the tenant key still works alone', async () => {
  const s = await start();
  try {
    const { org, apiKey } = seedBrightClean(s.store, {});
    const adminHeaders = { 'x-admin-key': ADMIN_KEY, 'x-org-id': org.id };
    const me = await get(s.base, '/api/me', adminHeaders);
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(me.text).id, org.id);

    const tenantOnly = await get(s.base, '/api/me', { 'x-org-key': apiKey });
    assert.equal(tenantOnly.status, 200);
  } finally {
    await s.close();
  }
});

test('x-org-id without the admin key, or with a bad admin key, is refused', async () => {
  const s = await start();
  try {
    const { org } = seedBrightClean(s.store, {});
    assert.equal((await get(s.base, '/api/me', { 'x-org-id': org.id })).status, 401);
    assert.equal((await get(s.base, '/api/me', { 'x-admin-key': 'wrong', 'x-org-id': org.id })).status, 401);
    assert.equal((await get(s.base, '/api/me', { 'x-admin-key': ADMIN_KEY, 'x-org-id': 'org_missing' })).status, 404);
  } finally {
    await s.close();
  }
});

test('the admin overview returns a tenant with its contacts, bids and audit trail, never the key hash', async () => {
  const s = await start();
  try {
    const { org } = seedBrightClean(s.store, {});
    const res = await get(s.base, `/api/admin/orgs/${org.id}/overview`, { 'x-admin-key': ADMIN_KEY });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.org.id, org.id);
    assert.equal(body.contacts.length, 1);
    assert.ok(Array.isArray(body.audit));
    assert.ok(!res.text.includes('apiKeyHash'), 'key hash never leaves the server');
    assert.equal((await get(s.base, `/api/admin/orgs/${org.id}/overview`)).status, 401);
  } finally {
    await s.close();
  }
});

test('the cross-tenant approval queue works for the owner and returns only pending bids', async () => {
  const s = await start();
  try {
    const { org } = seedBrightClean(s.store, {});
    s.store.insert('bids', {
      orgId: org.id, opportunityId: 'o1', proposalId: 'p1', recipientContactId: null,
      status: 'pending_approval', total: 900, history: [], receipt: null,
    });
    s.store.insert('bids', {
      orgId: org.id, opportunityId: 'o2', proposalId: 'p2', recipientContactId: null,
      status: 'draft', total: 100, history: [], receipt: null,
    });
    const res = await get(s.base, '/api/admin/queue', { 'x-admin-key': ADMIN_KEY });
    assert.equal(res.status, 200, res.text);
    const rows = JSON.parse(res.text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending_approval');
    assert.equal(rows[0].orgId, org.id);
  } finally {
    await s.close();
  }
});

test('the admin tenant list includes no key material', async () => {
  const s = await start();
  try {
    seedBrightClean(s.store, {});
    const res = await get(s.base, '/api/admin/orgs', { 'x-admin-key': ADMIN_KEY });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).length, 1);
    assert.ok(!res.text.includes('apiKeyHash'));
  } finally {
    await s.close();
  }
});

test('CORS allows only the configured console origin and answers preflight', async () => {
  const { env } = makeEnv({ BUILDINTEL_CORS_ORIGINS: 'https://buildintel.netlify.app, https://staging.example.org' });
  const { store, config } = makeStore(env);
  const server = createServer({ store, config, transport: createTransport(config) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(config.corsOrigins, ['https://buildintel.netlify.app', 'https://staging.example.org']);

    const allowed = await fetch(`${base}/api/readiness`, {
      headers: { origin: 'https://buildintel.netlify.app', 'x-admin-key': ADMIN_KEY },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://buildintel.netlify.app');
    assert.match(allowed.headers.get('vary') || '', /Origin/);

    const denied = await fetch(`${base}/api/readiness`, {
      headers: { origin: 'https://evil.example', 'x-admin-key': ADMIN_KEY },
    });
    assert.equal(denied.status, 200, 'the request still succeeds server-side');
    assert.equal(denied.headers.get('access-control-allow-origin'), null, 'the browser is not told to allow it');

    const pre = await fetch(`${base}/api/bids`, {
      method: 'OPTIONS',
      headers: { origin: 'https://buildintel.netlify.app', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-org-id,content-type' },
    });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /x-org-id/);
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('with no CORS origins configured, no cross-origin headers are sent', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/api/readiness`, {
      headers: { origin: 'https://buildintel.netlify.app', 'x-admin-key': ADMIN_KEY },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

test('owner readiness inputs can live on the persistent disk, outside the image', async () => {
  const { env, dir } = makeEnv();
  const file = require('path').join(dir, 'readiness.json');
  require('fs').writeFileSync(file, JSON.stringify({ policiesApprovedBy: 'Test Attorney', policiesApprovedAt: '2026-11-01' }));
  const { config, store } = makeStore({ ...env, BUILDINTEL_READINESS_FILE: file });
  assert.equal(config.readinessFile, file);
  const { evaluateReadiness } = require('../src/readiness');
  const gate = evaluateReadiness({ store, config }).gates.find((g) => g.id === 'policies_approved');
  assert.equal(gate.status, 'pass');
});
