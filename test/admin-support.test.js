import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { createCase, addNote, setStatus, assign, caseDetail, customerView, listCases } from '../src/admin/support.js';

const PW = 'correct horse battery 1';
const ctx = { user: { email: 'agent@bc.test' }, requestId: 'req-1' };
const reason = 'customer asked about a late invoice';

function fixture() {
  const store = new Store(null);
  const co = store.put('orgs', { slug: 'sp', name: 'Sparky Electric', status: 'active', subscription: { plan: 'local' } });
  const other = store.put('orgs', { slug: 'other', name: 'Other Co', status: 'active', subscription: { plan: 'local' } });
  return { store, co, other };
}

test('a case needs a real company, a subject of 5+ characters, and a known priority', () => {
  const { store, co } = fixture();
  assert.equal(createCase(store, ctx, { companyId: 'nope', subject: 'Hello there' }).code, 404);
  assert.equal(createCase(store, ctx, { companyId: co.id, subject: 'Hi' }).code, 400);
  assert.equal(createCase(store, ctx, { companyId: co.id, subject: 'Hello there', priority: 'urgent' }).code, 400);
  assert.equal(createCase(store, ctx, { companyId: co.id, subject: 'Hello there' }).ok, true);
});

test('internal notes never reach the company; customer notes do', () => {
  const { store, co } = fixture();
  const { case: c } = createCase(store, ctx, { companyId: co.id, subject: 'Billing question', body: 'We will look into it.' });
  addNote(store, ctx, c.id, { visibility: 'internal', body: 'Suspect a duplicate charge.' });
  addNote(store, ctx, c.id, { visibility: 'customer', body: 'Please send the receipt.' });
  const view = customerView(store, c.id, co.id).case;
  const bodies = view.notes.map(n => n.body);
  assert.deepEqual(bodies, ['We will look into it.', 'Please send the receipt.']);
  assert.ok(!JSON.stringify(view).includes('duplicate charge'), 'internal text never leaves the server');
  assert.equal(view.history, undefined, 'history is staff-only');
  assert.equal(caseDetail(store, c.id).case.notes.length, 3, 'staff see every note');
});

test('a company cannot open another company’s case', () => {
  const { store, co, other } = fixture();
  const { case: c } = createCase(store, ctx, { companyId: co.id, subject: 'Our case' });
  assert.equal(customerView(store, c.id, other.id).code, 404);
});

test('status moves follow the transition rules and need a reason', () => {
  const { store, co } = fixture();
  const { case: c } = createCase(store, ctx, { companyId: co.id, subject: 'Status test' });
  assert.equal(setStatus(store, ctx, c.id, { status: 'open', reason }).code, 409, 'same status refused');
  assert.equal(setStatus(store, ctx, c.id, { status: 'resolved', reason: 'no' }).code, 400, 'short reason refused');
  assert.equal(setStatus(store, ctx, c.id, { status: 'resolved', reason }).ok, true);
  assert.equal(setStatus(store, ctx, c.id, { status: 'waiting_customer', reason }).code, 409, 'resolved cannot go back to waiting');
  assert.equal(setStatus(store, ctx, c.id, { status: 'closed', reason }).ok, true);
  assert.equal(setStatus(store, ctx, c.id, { status: 'open', reason }).code, 409, 'closed is final');
});

test('every change is audited with actor, target and outcome', () => {
  const { store, co } = fixture();
  const { case: c } = createCase(store, ctx, { companyId: co.id, subject: 'Audit test' });
  addNote(store, ctx, c.id, { visibility: 'internal', body: 'note' });
  setStatus(store, ctx, c.id, { status: 'waiting_customer', reason });
  assign(store, ctx, c.id, { assignee: 'Sam' });
  const actions = store.data.audit.filter(e => e.target === c.id).map(e => e.action);
  for (const a of ['admin.support.create', 'admin.support.note', 'admin.support.status', 'admin.support.assign']) assert.ok(actions.includes(a), a);
});

test('the list filters by status and the detail shows history', () => {
  const { store, co } = fixture();
  const a = createCase(store, ctx, { companyId: co.id, subject: 'Open one' }).case;
  const b = createCase(store, ctx, { companyId: co.id, subject: 'Closed one' }).case;
  setStatus(store, ctx, b.id, { status: 'resolved', reason });
  const open = listCases(store, new URLSearchParams('status=open'));
  assert.deepEqual(open.items.map(x => x.id), [a.id]);
  assert.ok(caseDetail(store, b.id).case.history.some(h => h.action.startsWith('status.')));
});

test('over HTTP: only support staff can manage cases; a company sees only its own, customer-visible view', async t => {
  const store = new Store(null);
  const bc = store.put('orgs', { slug: 'bc', name: 'Bright Clean', status: 'active', settings: {}, subscription: { plan: 'internal', status: 'active' } });
  const co = store.put('orgs', { slug: 'sp', name: 'Sparky Electric', status: 'active', subscription: { plan: 'local' } });
  store.put('users', { email: 'agent@bc.test', orgId: bc.id, role: 'member', platformRoles: ['support_agent'], passwordHash: hashPassword(PW) });
  store.put('users', { email: 'owner@sp.test', orgId: co.id, role: 'owner', passwordHash: hashPassword(PW) });
  const srv = createServer(store).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async email => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).json()).token;
  const agent = await login('agent@bc.test'), customer = await login('owner@sp.test');
  const H = tok => ({ 'content-type': 'application/json', authorization: 'Bearer ' + tok });
  const made = await fetch(base + '/api/admin/support', { method: 'POST', headers: H(agent), body: JSON.stringify({ companyId: co.id, subject: 'Panel not energizing', body: 'Visible note' }) });
  assert.equal(made.status, 200, await made.clone().text());
  const c = await made.json();
  await fetch(base + `/api/admin/support/${c.id}/notes`, { method: 'POST', headers: H(agent), body: JSON.stringify({ visibility: 'internal', body: 'Internal: check breaker' }) });
  const mine = await fetch(base + `/api/my/support/${c.id}`, { headers: H(customer) });
  assert.equal(mine.status, 200);
  const text = await mine.text();
  assert.ok(text.includes('Visible note') && !text.includes('check breaker'), 'company sees customer notes only');
  assert.equal((await fetch(base + '/api/admin/support', { headers: H(customer) })).status, 403, 'company cannot use the staff list');
  assert.equal((await fetch(base + '/api/admin/support')).status, 401, 'anonymous refused');
});
