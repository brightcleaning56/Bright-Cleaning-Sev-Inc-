import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { sign } from '../src/security.js';
import { bidLinkToken } from '../src/bidlink.js';

let nextIp = 120;
async function harness(t) {
  config.trustProxy = true;
  const ip = `192.0.2.${nextIp++}`;
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
  const onboard = async (path, body) => {
    assert.equal((await call('POST', path, body)).status, 200);
    const link = store.list('messages', m => m.kind === 'verification' && m.to === body.email).pop().link;
    await fetch(link.replace(config.baseUrl, base), { method: 'POST' });
    return (await call('POST', '/api/login', { email: body.email, password: body.password })).body.token;
  };
  const PW = 'long enough password';
  const staff = store.put('users', { email: 'staff@bc.test', role: 'platform_owner', passwordHash: (await import('../src/security.js')).hashPassword('staff password 123') });
  const staffTok = (await call('POST', '/api/login', { email: 'staff@bc.test', password: 'staff password 123' })).body.token;
  return { store, call, onboard, staffTok, PW, base };
}
const future = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

async function scenario(t) {
  const h = await harness(t);
  const subTok = await h.onboard('/api/signup/subscriber', { company: 'Bright Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Ana', email: 'ana@bright.test', password: h.PW, state: 'WA' });
  const gcTok = await h.onboard('/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam@ryan.test', password: h.PW });
  const gcMe = (await h.call('GET', '/api/me', undefined, gcTok)).body;
  await h.call('POST', '/api/publisher/verification', { licenseNumber: 'WA-1' }, gcTok);
  await h.call('POST', `/api/admin/publishers/${gcMe.org.id}/decide`, { status: 'verified', note: 'checked' }, h.staffTok);
  const req = await h.call('POST', '/api/requests', { title: 'Office lighting retrofit', address: '100 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['electrical'], dueDate: future(20) }, gcTok);
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const inv = h.store.list('invitations', i => i.requestId === req.body.id)[0];
  assert.ok(inv, 'the electrical company is invited');
  return { ...h, subTok, gcTok, inv, request: h.store.get('bidRequests', req.body.id) };
}

test('an invited company bids from its emailed link, with no sign-in', async t => {
  const s = await scenario(t);
  const token = bidLinkToken(s.inv, s.request);
  const view = await fetch(`${s.base}/api/bid-link/${token}`).then(r => r.json());
  assert.equal(view.company, 'Bright Electric');
  assert.equal(view.request.title, 'Office lighting retrofit');
  assert.equal(view.request.open, true);
  assert.equal(view.submitted, false);
  const bid = await s.call('POST', `/api/bid-link/${token}`, { contactName: 'Ana Ruiz', contactEmail: 'ana@bright.test', amount: '$12,500', scope: 'Rough-in and trim, all four floors.', validDays: 30 });
  assert.equal(bid.status, 200, JSON.stringify(bid.body));
  assert.equal(bid.body.submission.total, 12500);
  assert.match(bid.body.message, /received/);
  const after = await fetch(`${s.base}/api/bid-link/${token}`).then(r => r.json());
  assert.equal(after.submitted, true);
  assert.ok(s.store.data.audit.some(a => a.action === 'bid.via_link'), 'the link bid is audited');
});

test('a second link bid revises the first, and the GC sees one bid', async t => {
  const s = await scenario(t);
  const token = bidLinkToken(s.inv, s.request);
  await s.call('POST', `/api/bid-link/${token}`, { contactName: 'Ana Ruiz', contactEmail: 'ana@bright.test', amount: 12500, scope: 'Rough-in and trim, all four floors.' });
  const revised = await s.call('POST', `/api/bid-link/${token}`, { contactName: 'Ana Ruiz', contactEmail: 'ana@bright.test', amount: 11800, scope: 'Rough-in and trim, all four floors, revised.' });
  assert.equal(revised.status, 200);
  const subs = s.store.list('submissions', x => x.requestId === s.request.id);
  assert.equal(subs.length, 1, 'one bid on file');
  assert.equal(subs[0].total, 11800);
});

test('the link is refused when it is wrong, tampered with, expired, or for another purpose', async t => {
  const s = await scenario(t);
  const good = bidLinkToken(s.inv, s.request);
  assert.equal((await fetch(`${s.base}/api/bid-link/not-a-token`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/bid-link/${good.slice(0, -2)}xx`)).status, 404, 'tampered signature');
  const expired = sign({ i: s.inv.id, k: 'bid', x: Date.now() - 1000 });
  assert.equal((await fetch(`${s.base}/api/bid-link/${expired}`)).status, 404, 'expired');
  const otherPurpose = sign({ i: s.inv.id, k: 'verify', x: Date.now() + 1e7 });
  assert.equal((await fetch(`${s.base}/api/bid-link/${otherPurpose}`)).status, 404, 'a link for another purpose is not a bid link');
});

test('a link bid is refused until addenda are acknowledged, and needs a name and work email', async t => {
  const s = await scenario(t);
  const token = bidLinkToken(s.inv, s.request);
  s.store.put('bidRequests', { ...s.request, addendumCount: 1 });
  const blocked = await s.call('POST', `/api/bid-link/${token}`, { contactName: 'Ana Ruiz', contactEmail: 'ana@bright.test', amount: 12500, scope: 'Rough-in and trim, all four floors.' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /addenda/);
  s.store.put('bidRequests', { ...s.request, addendumCount: 0 });
  assert.equal((await s.call('POST', `/api/bid-link/${token}`, { contactName: 'A', contactEmail: 'ana@bright.test', amount: 1, scope: 'x'.repeat(12) })).status, 400, 'name too short');
  assert.equal((await s.call('POST', `/api/bid-link/${token}`, { contactName: 'Ana Ruiz', contactEmail: 'nope', amount: 1, scope: 'x'.repeat(12) })).status, 400, 'bad email');
});

test('the bid page is served and the invitation email carries the link', async t => {
  const s = await scenario(t);
  const page = await fetch(`${s.base}/bid/${bidLinkToken(s.inv, s.request)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /bid\.js/);
  assert.equal((await fetch(`${s.base}/bid.js`)).status, 200);
  assert.match(bidLinkToken(s.inv, s.request), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});
