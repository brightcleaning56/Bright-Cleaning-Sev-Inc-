import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/security.js';
import { publisherSummary, createPublication, addPackage, decideVerification } from '../src/publishing.js';

let nextIp = 240;
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
  return { store, call, base };
}

test('the command center counts a publisher\'s projects and packages, and lists the next deadlines', () => {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const other = store.put('orgs', { slug: 'other', name: 'Other', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const owner = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id });
  decideVerification(store, { email: 'staff' }, gc.id, { status: 'verified', note: 'checked' });
  const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  const PROJECT = { title: 'Clinic', address: '1200 SE Delaware Ave', city: 'Ankeny', state: 'IA', projectType: 'medical', description: 'New 120,000 SF medical office building', estValue: 48500000 };
  const p1 = createPublication(store, gc, owner, PROJECT).publication;
  createPublication(store, gc, owner, { ...PROJECT, title: 'Second' });
  const pk0 = addPackage(store, gc, owner, p1.id, { title: 'Electrical', trades: ['electrical'], dueDate: D(5), projectType: 'medical', description: 'Electrical: complete scope per drawings and specifications', noDocuments: true }).package;
  // A package counts as open once it has been released; the draft publication itself is not published here.
  const pk = store.put('bidRequests', { ...store.get('bidRequests', pk0.id), status: 'open' });
  const later = store.put('bidRequests', { buyerOrgId: gc.id, title: 'Far away', status: 'open', dueDate: D(60), trades: ['electrical'], addenda: [], addendumCount: 0 });
  store.put('invitations', { requestId: pk.id, buyerOrgId: gc.id, sellerOrgId: 'sub-1', intent: 'undecided' });
  store.put('submissions', { requestId: pk.id, sellerOrgId: 'sub-1', total: 1000 });
  const s = publisherSummary(store, gc);
  assert.equal(s.projects.total, 2);
  assert.equal(s.projects.draft, 2);
  assert.equal(s.activePackages, 2, 'every open package counts, including the one due in 60 days');
  assert.equal(s.invitationsSent, 1);
  assert.equal(s.bidsReceived, 1);
  assert.equal(s.awardsPending, 1, 'an open package with a bid is waiting for an award');
  assert.deepEqual(s.upcomingDeadlines.map(d => d.title), ['Electrical'], 'deadlines within two weeks only');
  assert.equal(publisherSummary(store, other).projects.total, 0, 'another company sees none of these');
  assert.equal(later.status, 'open');
});

test('an unconfirmed account can ask for the confirmation email again, a limited number of times', async t => {
  const { store, call } = await setup(t);
  const r = await call('POST', '/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam@ryan.test', password: 'long enough password' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = (await call('POST', '/api/login', { email: 'sam@ryan.test', password: 'long enough password' })).body.token;
  assert.ok(token, 'an unconfirmed account can still sign in');
  const again = await call('POST', '/api/account/resend-verification', {}, token);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(store.list('messages', m => m.kind === 'verification' && m.to === 'sam@ryan.test').length, 2, 'a second confirmation message is logged');
  for (let i = 0; i < 4; i++) await call('POST', '/api/account/resend-verification', {}, token);
  const limited = await call('POST', '/api/account/resend-verification', {}, token);
  assert.equal(limited.status, 429);
});

test('a confirmed account has nothing to resend', async t => {
  const { store, call } = await setup(t);
  const org = store.put('orgs', { slug: 'x', name: 'X', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  store.put('users', { email: 'ok@x.test', role: 'owner', orgId: org.id, passwordHash: hashPassword('long enough password') });
  const tok = (await call('POST', '/api/login', { email: 'ok@x.test', password: 'long enough password' })).body.token;
  assert.equal((await call('POST', '/api/account/resend-verification', {}, tok)).status, 409);
});
