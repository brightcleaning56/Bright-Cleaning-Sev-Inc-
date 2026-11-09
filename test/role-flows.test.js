import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';

let nextIp = 60;
async function harness(t) {
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
  // A BUILDINTEL platform owner, who decides publisher verification in Super Admin.
  const { hashPassword } = await import('../src/security.js');
  store.put('users', { email: 'staff@bc.test', role: 'platform_owner', passwordHash: hashPassword('staff password 123'), orgId: null });
  const staffTok = (await call('POST', '/api/login', { email: 'staff@bc.test', password: 'staff password 123' })).body.token;
  // Sign up, confirm the email the way the button in the message does, then sign in.
  const onboard = async (path, body) => {
    const s = await call('POST', path, body);
    assert.equal(s.status, 200, `${path}: ${JSON.stringify(s.body)}`);
    const link = store.list('messages', m => m.kind === 'verification' && m.to === body.email).pop()?.link;
    assert.ok(link, 'a confirmation link was sent');
    await fetch(link.replace(config.baseUrl, base), { method: 'POST' });
    const login = await call('POST', '/api/login', { email: body.email, password: body.password });
    assert.equal(login.status, 200, `sign in after confirming: ${JSON.stringify(login.body)}`);
    return login.body.token;
  };
  // Posting needs a verified publisher: the company requests it, staff decide it.
  const verify = async (tok) => {
    const me = (await call('GET', '/api/me', undefined, tok)).body;
    assert.equal((await call('POST', '/api/publisher/verification', { licenseNumber: 'LIC-' + me.org.id.slice(-4) }, tok)).status, 200);
    const d = await call('POST', `/api/admin/publishers/${me.org.id}/decide`, { status: 'verified', note: 'license checked on the state register' }, staffTok);
    assert.equal(d.status, 200, JSON.stringify(d.body));
  };
  return { store, call, onboard, verify };
}
const future = () => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const PW = 'long enough password';

test('subcontractor: signs up, confirms, signs in, and is invited to a matching request only', async t => {
  const { call, onboard, verify } = await harness(t);
  const subTok = await onboard('/api/signup/subscriber', { company: 'Bright Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Ana', email: 'ana@bright.test', password: PW, state: 'WA' });
  const plumbTok = await onboard('/api/signup/subscriber', { company: 'Pipe Co', segment: 'subcontractor', trades: ['plumbing'], name: 'Pat', email: 'pat@pipe.test', password: PW, state: 'WA' });
  const gcTok = await onboard('/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam@ryan.test', password: PW });
  await verify(gcTok);
  const me = (await call('GET', '/api/me', undefined, subTok)).body;
  assert.equal(me.org.segment, 'subcontractor');
  assert.equal(me.org.status, 'active', 'confirmed company is active');
  const base = { title: 'Office lighting retrofit', address: '100 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['electrical'], dueDate: future() };
  const req = await call('POST', '/api/requests', base, gcTok);
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const invited = (await call('GET', '/api/invitations', undefined, subTok)).body;
  assert.ok(invited.some(i => i.request.id === req.body.request?.id || i.request.title === 'Office lighting retrofit'), 'electrical company is invited');
  const notInvited = (await call('GET', '/api/invitations', undefined, plumbTok)).body;
  assert.ok(!notInvited.some(i => i.request.title === 'Office lighting retrofit'), 'plumbing company is not invited to electrical work');
});

test('service provider: signs up with services, confirms, and is invited to cleaning work from an owner', async t => {
  const { call, onboard, verify } = await harness(t);
  const svcTok = await onboard('/api/signup/subscriber', { company: 'Clear Pane', segment: 'service_provider', services: ['post_construction', 'windows'], name: 'Lee', email: 'lee@clear.test', password: PW, state: 'IA' });
  const ownerTok = await onboard('/api/signup/buyer', { company: 'Prairie Holdings', kind: 'owner', name: 'Dana', email: 'dana@prairie.test', password: PW });
  await verify(ownerTok);
  assert.equal((await call('GET', '/api/me', undefined, svcTok)).body.org.segment, 'service_provider');
  const req = await call('POST', '/api/requests', { title: 'Post-construction clean, clinic', address: '12 Main', city: 'Ames', state: 'IA', projectType: 'medical', services: ['post_construction'], squareFeet: 12000, dueDate: future() }, ownerTok);
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const invited = (await call('GET', '/api/invitations', undefined, svcTok)).body;
  assert.ok(invited.some(i => i.request.title === 'Post-construction clean, clinic'), 'cleaning company is invited to cleaning work');
  const me = (await call('GET', '/api/me', undefined, ownerTok)).body;
  assert.equal(me.org.buyerKind, 'owner');
});

test('general contractor and owner: each sees only their own requests and can post', async t => {
  const { call, onboard, verify } = await harness(t);
  const gcTok = await onboard('/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam2@ryan.test', password: PW });
  await verify(gcTok);
  const ownerTok = await onboard('/api/signup/buyer', { company: 'Oak Owners', kind: 'owner', name: 'Ola', email: 'ola@oak.test', password: PW });
  await verify(ownerTok);
  const gcReq = await call('POST', '/api/requests', { title: 'GC package', address: '1 A St', city: 'Boise', state: 'ID', projectType: 'office', trades: ['drywall'], dueDate: future() }, gcTok);
  assert.equal(gcReq.status, 200);
  const ownerList = (await call('GET', '/api/requests', undefined, ownerTok)).body;
  assert.ok(!ownerList.some(r => r.title === 'GC package'), 'owner does not see the GC package');
  const gcList = (await call('GET', '/api/requests', undefined, gcTok)).body;
  assert.ok(gcList.some(r => r.title === 'GC package'), 'GC sees its own package');
});

test('a construction manager posting for an owner must show the owner authorization and see it reviewed', async t => {
  const { call, onboard, verify } = await harness(t);
  const cmTok = await onboard('/api/signup/buyer', { company: 'Ryan CM', kind: 'construction_manager', name: 'Cy', email: 'cy@ryan.test', password: PW });
  await verify(cmTok);
  const base = { title: 'CM package', address: '5 Elm', city: 'Boise', state: 'ID', projectType: 'office', trades: ['drywall'], dueDate: future() };
  const noAuth = await call('POST', '/api/requests', base, cmTok);
  assert.equal(noAuth.status, 400);
  assert.match(noAuth.body.error, /owner/, 'asks for the owner authorization');
  const ok = await call('POST', '/api/requests', { ...base, authorizationEvidence: 'Owner letter dated 2026-10-01' }, cmTok);
  assert.equal(ok.status, 409, 'the owner authorization must be reviewed by BUILDINTEL before the package goes out');
  assert.match(ok.body.error, /waiting for BUILDINTEL review/);
});
