import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/security.js';

let nextIp = 180;
const docHtml = (s, tok) => fetch(`${s.base}/api/contracts/${s.contract.id}/document`, { headers: { authorization: 'Bearer ' + tok } }).then(r => r.text());
async function awarded(t) {
  config.trustProxy = true;
  const ip = `203.0.113.${nextIp++}`;
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
  const PW = 'long enough password';
  const onboard = async (path, body) => {
    assert.equal((await call('POST', path, body)).status, 200);
    const link = store.list('messages', m => m.kind === 'verification' && m.to === body.email).pop().link;
    await fetch(link.replace(config.baseUrl, base), { method: 'POST' });
    return (await call('POST', '/api/login', { email: body.email, password: body.password })).body.token;
  };
  store.put('users', { email: 'staff@bc.test', role: 'platform_owner', passwordHash: hashPassword('staff password 123') });
  const staffTok = (await call('POST', '/api/login', { email: 'staff@bc.test', password: 'staff password 123' })).body.token;
  const subTok = await onboard('/api/signup/subscriber', { company: 'Bright Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Ana', email: 'ana@bright.test', password: PW, state: 'WA' });
  const otherTok = await onboard('/api/signup/subscriber', { company: 'Pipe Co', segment: 'subcontractor', trades: ['plumbing'], name: 'Pat', email: 'pat@pipe.test', password: PW, state: 'WA' });
  const gcTok = await onboard('/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam@ryan.test', password: PW });
  const gcMe = (await call('GET', '/api/me', undefined, gcTok)).body;
  await call('POST', '/api/publisher/verification', { licenseNumber: 'WA-1' }, gcTok);
  await call('POST', `/api/admin/publishers/${gcMe.org.id}/decide`, { status: 'verified', note: 'checked' }, staffTok);
  const future = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const req = await call('POST', '/api/requests', { title: 'Office lighting retrofit', address: '100 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['electrical'], dueDate: future }, gcTok);
  const inv = store.list('invitations', i => i.requestId === req.body.id)[0];
  const bid = await call('POST', `/api/invitations/${inv.id}/bid`, { amount: 12500, scope: 'Rough-in and trim for all four floors.' }, subTok);
  assert.equal(bid.status, 200, JSON.stringify(bid.body));
  const award = await call('POST', `/api/requests/${req.body.id}/award`, { submissionId: bid.body.id, signerName: 'Sam Ryan', consent: true }, gcTok);
  assert.equal(award.status, 200, JSON.stringify(award.body));
  const contract = store.list('contracts', c => c.requestId === req.body.id)[0];
  return { call, subTok, otherTok, gcTok, contract, store, base };
}

test('the awarded company countersigns and the contract becomes fully signed', async t => {
  const s = await awarded(t);
  let list = (await s.call('GET', '/api/contracts', undefined, s.subTok)).body;
  assert.equal(list[0].canCountersign, true, 'the provider can countersign');
  assert.equal(list[0].countersigned, false);
  const sign = await s.call('POST', `/api/contracts/${s.contract.id}/countersign`, { signerName: 'Ana Ruiz', consent: true }, s.subTok);
  assert.equal(sign.status, 200, JSON.stringify(sign.body));
  assert.equal(sign.body.status, 'fully_signed');
  list = (await s.call('GET', '/api/contracts', undefined, s.subTok)).body;
  assert.equal(list[0].countersigned, true);
  assert.equal(list[0].canCountersign, false);
  const doc = await docHtml(s, s.subTok);
  assert.match(doc, /Countersigned by/);
  assert.match(doc, /Ana Ruiz/);
  assert.match(doc, /Document unchanged since signing/, 'the proposal itself is unchanged');
});

test('only the provider can countersign, once, with its own consent', async t => {
  const s = await awarded(t);
  const asBuyer = await s.call('POST', `/api/contracts/${s.contract.id}/countersign`, { signerName: 'Sam Ryan', consent: true }, s.gcTok);
  assert.equal(asBuyer.status, 404, 'the customer cannot countersign for the provider');
  const asOther = await s.call('POST', `/api/contracts/${s.contract.id}/countersign`, { signerName: 'Pat Other', consent: true }, s.otherTok);
  assert.equal(asOther.status, 404, 'another company cannot countersign it');
  assert.equal((await s.call('POST', `/api/contracts/${s.contract.id}/countersign`, { signerName: 'Ana Ruiz', consent: false }, s.subTok)).status, 400, 'consent is required');
  assert.equal((await s.call('POST', `/api/contracts/${s.contract.id}/countersign`, { signerName: 'A', consent: true }, s.subTok)).status, 400, 'a full name is required');
  assert.equal((await s.call('POST', `/api/contracts/${s.contract.id}/countersign`, { signerName: 'Ana Ruiz', consent: true }, s.subTok)).status, 200);
  assert.equal((await s.call('POST', `/api/contracts/${s.contract.id}/countersign`, { signerName: 'Ana Ruiz', consent: true }, s.subTok)).status, 409, 'cannot sign twice');
});

test('before countersignature the document says it is awaiting the provider', async t => {
  const s = await awarded(t);
  const doc = await docHtml(s, s.gcTok);
  assert.match(doc, /awaiting the provider/);
  assert.doesNotMatch(doc, /Countersigned by/);
});
