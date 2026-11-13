import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/security.js';

// Regression: inviting a company by name on an open package returned "internal error" (the invite function was not
// imported by the server). This goes through the real route.
let nextIp = 250;
test('a publisher can invite a company by name to an open package, and the invitation is recorded', async t => {
  config.trustProxy = true;
  const ip = `198.51.100.${nextIp++}`;
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const sub = store.put('orgs', { slug: 'sub', name: 'Bright Electric', kind: 'subscriber', status: 'active', trades: ['electrical'], territories: ['WA'], settings: {} });
  store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id, passwordHash: hashPassword('long enough password') });
  const pkg = store.put('bidRequests', { buyerOrgId: gc.id, publicationId: 'pub_x', title: 'Electrical', status: 'open', trades: ['electrical'], state: 'WA', dueDate: '2030-01-01', addenda: [], addendumCount: 0, invitees: [] });
  const srv = createServer(store).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const tok = (await call('POST', '/api/login', { email: 'gm@abc.test', password: 'long enough password' })).body.token;
  const r = await call('PATCH', `/api/packages/${pkg.id}`, { invitees: [sub.id] }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.list('invitations', i => i.requestId === pkg.id && i.sellerOrgId === sub.id).length, 1, 'the company is invited');
  const again = await call('PATCH', `/api/packages/${pkg.id}`, { invitees: [sub.id] }, tok);
  assert.equal(again.status, 200);
  assert.equal(store.list('invitations', i => i.requestId === pkg.id && i.sellerOrgId === sub.id).length, 1, 'inviting twice does not duplicate');
});
