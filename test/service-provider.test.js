// A service provider (janitorial, window and post-construction cleaning) signs up, is invited to a cleaning package
// that a general contractor posts, bids on it, and sees its bid. Covers the path the browser checks did not.
import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/security.js';
import { createPublication, addPackage, decideVerification } from '../src/publishing.js';
import { openPackageInvites, submitBid } from '../src/marketplace.js';

let nextIp = 210;
async function setup(t) {
  config.trustProxy = true;
  const ip = `198.51.100.${nextIp++}`;
  const store = new Store(null);
  const srv = createServer(store).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) });
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  return { store, call };
}

test('a service provider must choose the services it provides at sign-up', async t => {
  const { call } = await setup(t);
  const base = { company: 'Clean Sweep Co', name: 'Pat', email: 'pat@sweep.test', state: 'WA', password: 'long enough password', segment: 'service_provider' };
  const none = await call('POST', '/api/signup/subscriber', { ...base });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /services/);
  const ok = await call('POST', '/api/signup/subscriber', { ...base, services: ['janitorial', 'windows'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('a service provider is invited to a cleaning package, bids on it, and sees the bid', async t => {
  const { store, call } = await setup(t);
  // The provider signs up through the real route, then is verified and active, as staff would leave it.
  const su = await call('POST', '/api/signup/subscriber', { company: 'Clean Sweep Co', name: 'Pat', email: 'pat@sweep.test', state: 'WA', password: 'long enough password', segment: 'service_provider', services: ['janitorial', 'windows'] });
  assert.equal(su.status, 200);
  const spUser = store.list('users', u => u.email === 'pat@sweep.test')[0];
  const sp = store.get('orgs', spUser.orgId);
  store.put('orgs', { ...sp, status: 'active' });
  const token = (await call('POST', '/api/login', { email: 'pat@sweep.test', password: 'long enough password' })).body.token;
  assert.ok(token);
  assert.ok(sp.trades.includes('cleaning'), 'cleaning is added to what a service provider does');

  // The general contractor posts a janitorial package for a store (12,000 SF, four visits a month).
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const owner = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id, passwordHash: hashPassword('long enough password') });
  decideVerification(store, { email: 'staff' }, gc.id, { status: 'verified', note: 'checked' });
  const pub = createPublication(store, gc, owner, { title: 'Pike Street store', address: '700 Pike St', city: 'Seattle', state: 'WA', projectType: 'retail', description: 'Retail store, 12,000 SF' }).publication;
  const pk = addPackage(store, gc, owner, pub.id, { title: 'Janitorial', services: ['janitorial'], squareFeet: 12000, frequencyPerMonth: 4, projectType: 'retail',
    dueDate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10), description: 'Nightly janitorial service for a 12,000 SF retail store', noDocuments: true }).package;
  const req = store.put('bidRequests', { ...store.get('bidRequests', pk.id), status: 'open' });
  openPackageInvites(store, req);

  const invites = store.list('invitations', i => i.requestId === req.id && i.sellerOrgId === sp.id);
  assert.equal(invites.length, 1, 'the cleaning package reaches the provider automatically');

  const mine = await call('GET', '/api/invitations', null, token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.some(i => i.request?.title === 'Janitorial'), 'the provider sees the invitation');

  const bid = submitBid(store, sp, spUser, invites[0].id, { amount: '3600', scope: 'Nightly janitorial for the sales floor, restrooms and back of house.', validDays: 30 });
  assert.equal(bid.ok, true, JSON.stringify(bid));
  const after = await call('GET', '/api/invitations', null, token);
  const row = after.body.find(i => i.request?.title === 'Janitorial');
  assert.equal(row.myBid.total, 3600, 'the provider sees its own bid on the invitation');
});
