import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/security.js';

let nextIp = 210;
async function setup(t, deps = {}) {
  config.trustProxy = true;
  const ip = `198.51.100.${nextIp++}`;
  const store = new Store(null);
  const srv = createServer(store, deps).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) });
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const PW = 'long enough password';
  const onboard = async (path, body) => {
    assert.equal((await call('POST', path, body)).status, 200);
    const link = store.list('messages', m => m.kind === 'verification' && m.to === body.email).pop().link;
    await fetch(link.replace(config.baseUrl, base), { method: 'POST' });
    return (await call('POST', '/api/login', { email: body.email, password: body.password })).body.token;
  };
  store.put('users', { email: 'staff@bc.test', role: 'platform_owner', passwordHash: hashPassword('staff password 123') });
  const staffTok = (await call('POST', '/api/login', { email: 'staff@bc.test', password: 'staff password 123' })).body.token;
  const winTok = await onboard('/api/signup/subscriber', { company: 'Bright Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Ana', email: 'ana@bright.test', password: PW, state: 'WA' });
  const loseTok = await onboard('/api/signup/subscriber', { company: 'Lux Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Lee', email: 'lee@lux.test', password: PW, state: 'WA' });
  const gcTok = await onboard('/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam@ryan.test', password: PW });
  const gcMe = (await call('GET', '/api/me', undefined, gcTok)).body;
  await call('POST', '/api/publisher/verification', { licenseNumber: 'WA-1' }, gcTok);
  await call('POST', `/api/admin/publishers/${gcMe.org.id}/decide`, { status: 'verified', note: 'checked' }, staffTok);
  const future = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const req = await call('POST', '/api/requests', { title: 'Office lighting retrofit', address: '100 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['electrical'], dueDate: future }, gcTok);
  const invs = store.list('invitations', i => i.requestId === req.body.id);
  const bidOf = async (tok, amount) => {
    const inv = invs.find(i => store.get('orgs', i.sellerOrgId).name === (tok === winTok ? 'Bright Electric' : 'Lux Electric'));
    const r = await call('POST', `/api/invitations/${inv.id}/bid`, { amount, scope: 'Rough-in and trim for all four floors.' }, tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const winBid = await bidOf(winTok, 12500);
  await bidOf(loseTok, 14000);
  return { store, call, gcTok, winTok, loseTok, winBid, requestId: req.body.id, base };
}

test('the awarded company is told to countersign, and the others are told they were not selected', async t => {
  const s = await setup(t);
  const award = await s.call('POST', `/api/requests/${s.requestId}/award`, { submissionId: s.winBid.id, signerName: 'Sam Ryan', consent: true }, s.gcTok);
  assert.equal(award.status, 200, JSON.stringify(award.body));
  await new Promise(r => setTimeout(r, 50));
  const winMsg = s.store.list('messages', m => m.kind === 'award_notice');
  const regret = s.store.list('messages', m => m.kind === 'regret_notice');
  assert.equal(winMsg.length, 1, 'one award notice to the winner');
  assert.match(winMsg[0].preview, /countersign/);
  assert.equal(regret.length, 1, 'one regret to the company not selected');
  assert.match(regret[0].preview, /not selected/);
  assert.equal(regret[0].to, 'lee@lux.test');
  assert.equal(winMsg[0].to, 'ana@bright.test');
});

test('a failed email does not undo the award', async t => {
  const failing = async () => { throw new Error('mail service unavailable'); };
  const s = await setup(t, { fetchImpl: failing });
  const award = await s.call('POST', `/api/requests/${s.requestId}/award`, { submissionId: s.winBid.id, signerName: 'Sam Ryan', consent: true }, s.gcTok);
  assert.equal(award.status, 200, 'the award succeeds even when mail fails');
  const req = s.store.get('bidRequests', s.requestId);
  assert.equal(req.status, 'awarded');
});
