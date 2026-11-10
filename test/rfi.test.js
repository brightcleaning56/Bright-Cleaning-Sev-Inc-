import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/security.js';

let nextIp = 240;
async function setup(t) {
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
  const PW = 'long enough password';
  const onboard = async (path, body) => {
    assert.equal((await call('POST', path, body)).status, 200);
    const link = store.list('messages', m => m.kind === 'verification' && m.to === body.email).pop().link;
    await fetch(link.replace(config.baseUrl, base), { method: 'POST' });
    return (await call('POST', '/api/login', { email: body.email, password: body.password })).body.token;
  };
  store.put('users', { email: 'staff@bc.test', role: 'platform_owner', passwordHash: hashPassword('staff password 123') });
  const staffTok = (await call('POST', '/api/login', { email: 'staff@bc.test', password: 'staff password 123' })).body.token;
  const askTok = await onboard('/api/signup/subscriber', { company: 'Bright Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Ana', email: 'ana@bright.test', password: PW, state: 'WA' });
  const peerTok = await onboard('/api/signup/subscriber', { company: 'Lux Electric', segment: 'subcontractor', trades: ['electrical'], name: 'Lee', email: 'lee@lux.test', password: PW, state: 'WA' });
  const outsiderTok = await onboard('/api/signup/subscriber', { company: 'Pipe Co', segment: 'subcontractor', trades: ['plumbing'], name: 'Pat', email: 'pat@pipe.test', password: PW, state: 'WA' });
  const gcTok = await onboard('/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam@ryan.test', password: PW });
  const gcMe = (await call('GET', '/api/me', undefined, gcTok)).body;
  await call('POST', '/api/publisher/verification', { licenseNumber: 'WA-1' }, gcTok);
  await call('POST', `/api/admin/publishers/${gcMe.org.id}/decide`, { status: 'verified', note: 'checked' }, staffTok);
  const future = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const req = await call('POST', '/api/requests', { title: 'Office lighting retrofit', address: '100 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['electrical'], dueDate: future }, gcTok);
  return { store, call, askTok, peerTok, outsiderTok, gcTok, requestId: req.body.id };
}

test('an invited company asks; the GC answers; every invited company sees the answer, not the asker', async t => {
  const s = await setup(t);
  const asked = await s.call('POST', `/api/requests/${s.requestId}/questions`, { question: 'Is the lighting fixture schedule in addendum 2 or the base set?' }, s.askTok);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const qid = asked.body.id;
  assert.equal((await s.call('POST', `/api/requests/${s.requestId}/questions/${qid}/answer`, { answer: 'The base set, sheet E2.01.' }, s.gcTok)).status, 200);
  const gcView = (await s.call('GET', `/api/requests/${s.requestId}/questions`, undefined, s.gcTok)).body;
  assert.equal(gcView[0].askedByName, 'Bright Electric', 'the GC sees who asked');
  const peerView = (await s.call('GET', `/api/requests/${s.requestId}/questions`, undefined, s.peerTok)).body;
  assert.equal(peerView[0].answer, 'The base set, sheet E2.01.', 'other invited companies see the answer');
  assert.equal(peerView[0].askedByName, 'Another invited company', 'and not the asker');
  const askerView = (await s.call('GET', `/api/requests/${s.requestId}/questions`, undefined, s.askTok)).body;
  assert.equal(askerView[0].mine, true);
});

test('companies that are not invited cannot ask or read questions; empty and short questions are refused', async t => {
  const s = await setup(t);
  assert.equal((await s.call('POST', `/api/requests/${s.requestId}/questions`, { question: 'Can we bid plumbing?' }, s.outsiderTok)).status, 403);
  assert.equal((await s.call('GET', `/api/requests/${s.requestId}/questions`, undefined, s.outsiderTok)).status, 404);
  assert.equal((await s.call('POST', `/api/requests/${s.requestId}/questions`, { question: 'short' }, s.askTok)).status, 400);
});

test('questions close with the package, and the answer must be given by the GC for this package', async t => {
  const s = await setup(t);
  const asked = await s.call('POST', `/api/requests/${s.requestId}/questions`, { question: 'Who is the electrical engineer of record?' }, s.askTok);
  const r = s.store.get('bidRequests', s.requestId); r.status = 'closed'; s.store.put('bidRequests', r);
  assert.equal((await s.call('POST', `/api/requests/${s.requestId}/questions`, { question: 'Another question after closing?' }, s.askTok)).status, 409);
  assert.equal((await s.call('POST', `/api/requests/${s.requestId}/questions/${asked.body.id}/answer`, { answer: 'Jane Doe, PE' }, s.peerTok)).status, 404, 'a bidder cannot answer (not found, so the package is not revealed)');
});
