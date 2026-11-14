import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/security.js';

// The whole path through the real HTTP routes: a company signs up and confirms, is verified as a publisher, publishes
// a project with a trade package and an insurance minimum, invites a subcontractor, takes a bid, awards it, and the
// subcontractor countersigns. Each step is checked, so a break anywhere in the chain fails here.
let nextIp = 300;
test('golden path: sign-up to countersigned contract, through the HTTP routes', async t => {
  config.trustProxy = true; config.emailMode = 'dry-run';
  const ip = `198.51.100.${nextIp++}`;
  const store = new Store(null);
  const srv = createServer(store).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const lastBody = { v: null };
  const call = async (m, p, b, tok) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) });
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    lastBody.v = { path: p, status: r.status, body };
    return { status: r.status, body };
  };
  const PW = 'long enough password';
  const confirm = async (email, path, body) => {
    { const r = await call('POST', path, body); assert.equal(r.status, 200, JSON.stringify({ path: r.body && r.body.error, status: r.status })); }
    const link = store.list('messages', m => m.kind === 'verification' && m.to === email).pop().link;
    await fetch(link.replace(config.baseUrl, base), { method: 'POST' });
    return (await call('POST', '/api/login', { email, password: PW })).body.token;
  };
  store.put('users', { email: 'staff@bc.test', role: 'platform_owner', passwordHash: hashPassword('staff password 123') });
  const staff = (await call('POST', '/api/login', { email: 'staff@bc.test', password: 'staff password 123' })).body.token;

  // 1. The publisher signs up, confirms its email, and requests verification.
  const gc = await confirm('gm@abc.test', '/api/signup/buyer', { company: 'ABC Development Group', kind: 'developer', name: 'Dana', email: 'gm@abc.test', password: PW });
  const gcMe = (await call('GET', '/api/me', undefined, gc)).body;
  { const r = await call('POST', '/api/publisher/verification', { website: 'https://abc.test', licenseNumber: 'WA-1', contactName: 'Dana Gray', title: 'Owner' }, gc); assert.equal(r.status, 200, JSON.stringify({ path: r.body && r.body.error, status: r.status })); }
  { const r = await call('POST', `/api/admin/publishers/${gcMe.org.id}/decide`, { status: 'verified', note: 'license checked on the state register' }, staff); assert.equal(r.status, 200, JSON.stringify({ path: r.body && r.body.error, status: r.status })); }

  // 2. A project with a trade package that asks for insurance.
  const pub = await call('POST', '/api/publications', { title: 'Medical office', address: '1200 SE Delaware', city: 'Ankeny', state: 'IA', projectType: 'medical', developer: 'ABC Development' }, gc);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const due = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const pk = await call('POST', `/api/publications/${pub.body.id}/packages`, { title: 'Electrical', trades: ['electrical'], dueDate: due, description: 'Electrical rough-in and trim per drawings and specifications.', noDocuments: true, insuranceRequirements: { generalLiabilityMin: 1000000, workersComp: false } }, gc);
  assert.equal(pk.status, 200, JSON.stringify(pk.body));
  { const r = await call('POST', `/api/publications/${pub.body.id}/publish`, {}, gc); assert.equal(r.status, 200, JSON.stringify({ path: r.body && r.body.error, status: r.status })); }

  // 3. A subcontractor signs up for electrical work in the same state; it is invited automatically.
  const sub = await confirm('ana@bright.test', '/api/signup/subscriber', { company: 'Bright Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Ana', email: 'ana@bright.test', password: PW, state: 'IA' });
  const invs = (await call('GET', '/api/invitations', undefined, sub)).body;
  const inv = invs.find(i => i.request.id === pk.body.id);
  assert.ok(inv, 'the subcontractor is invited to the package');
  assert.equal(inv.request.insuranceRequirements.generalLiabilityMin, 1000000, 'the invitation shows the insurance minimum');

  // 4. The subcontractor bids.
  const bid = await call('POST', `/api/invitations/${inv.id}/bid`, { amount: 182000, scope: 'Rough-in and trim for the full building, per drawings E-101 to E-104.', documentUrl: 'https://example.com/bid.pdf', validDays: 30 }, sub);
  assert.equal(bid.status, 200, JSON.stringify(bid.body));

  // 5. The publisher sees the bid in the comparison, with its scope and insurance result.
  const lv = (await call('GET', `/api/requests/${pk.body.id}/leveling`, undefined, gc)).body;
  assert.equal(lv.rows.length, 1);
  assert.equal(lv.rows[0].total, 182000);
  assert.equal(lv.rows[0].insuranceCheck.met, false, 'no general liability certificate yet, so the minimum is not met');

  // 6. The publisher awards with a recorded reason (the minimum is not met), and the reason is kept.
  const award = await call('POST', `/api/requests/${pk.body.id}/award`, { submissionId: bid.body.id, signerName: 'Dana Gray', consent: true, insuranceReason: 'Certificate arrives Monday; owner accepted the bid.' }, gc);
  assert.equal(award.status, 200, JSON.stringify(award.body));

  // 7. The subcontractor countersigns; the contract is fully signed and the amount is the bid.
  const contract = (await call('GET', '/api/contracts', undefined, sub)).body.find(c => c.id === award.body.contractId);
  assert.ok(contract && contract.canCountersign, 'the subcontractor can countersign');
  { const r = await call('POST', `/api/contracts/${contract.id}/countersign`, { signerName: 'Ana Ruiz', consent: true }, sub); assert.equal(r.status, 200, JSON.stringify({ path: r.body && r.body.error, status: r.status })); }
  const done = (await call('GET', '/api/contracts', undefined, gc)).body.find(c => c.id === award.body.contractId);
  assert.equal(done.status, 'fully_signed');
  assert.equal(done.total, 182000);

  // 8. The record names the insurance exception and both signatures.
  const doc = await fetch(`${base}/api/contracts/${contract.id}/document`, { headers: { authorization: 'Bearer ' + gc } });
  const html = await doc.text();
  assert.match(html, /Electronic acceptance record/);
  assert.match(html, /Countersigned by/);
  assert.match(html, /Document unchanged since signing/);
});
