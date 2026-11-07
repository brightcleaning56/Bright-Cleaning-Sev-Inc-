import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { PLATFORM_ROLES } from '../src/admin/rbac.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-admin-'));
const PW = 'correct horse battery 1';
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
async function world(t) {
  const store = new Store(null);
  const bc = store.put('orgs', { slug: 'bc', name: 'Bright Clean', status: 'active', settings: {}, subscription: { plan: 'internal', status: 'active' } });
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development', kind: 'buyer', buyerKind: 'construction_manager', status: 'active', settings: {}, publisher: { status: 'pending', evidence: { website: 'https://abc.example' }, requestedAt: new Date().toISOString() } });
  const sub = store.put('orgs', { slug: 'sp', name: 'Sparky Electric', kind: 'subscriber', trades: ['electrical'], territories: ['IA'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  const user = (email, orgId, extra = {}) => store.put('users', { email, orgId, role: 'owner', passwordHash: hashPassword(PW), ...extra });
  const ids = { owner: user('eric@bc.test', bc.id, { role: 'platform_owner' }).id, staff: user('rev@bc.test', bc.id, { role: 'member' }).id,
    gm: user('gm@abc.test', gc.id).id, gm2: user('pe@abc.test', gc.id, { role: 'member', permissions: ['upload'] }).id, sub: user('own@sparky.test', sub.id).id };
  const srv = createServer(store).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: m === 'GET' || b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const login = async e => (await call('POST', '/api/login', { email: e, password: PW })).body.token;
  return { store, bc, gc, sub, ids, call, login };
}

const ROUTES = [['GET', '/api/admin/overview', 'admin.dashboard.read'], ['GET', '/api/admin/companies', 'admin.company.read'], ['GET', '/api/admin/users', 'admin.user.read'],
  ['GET', '/api/admin/authority', 'admin.publisher.review'], ['GET', '/api/admin/audit', 'admin.audit.read'],
  ['POST', '/api/admin/companies/X/verification-decision', 'admin.company.verify'], ['POST', '/api/admin/companies/X/status', 'admin.company.suspend'],
  ['POST', '/api/admin/users/X/status', 'admin.user.manage'], ['POST', '/api/admin/users/X/revoke-sessions', 'admin.user.manage'], ['POST', '/api/admin/users/X/platform-roles', 'admin.roles.manage']];

test('permission matrix: every admin route × every platform role, plus company users; deny by default, denials audited', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const gmTok = await w.login('gm@abc.test'), subTok = await w.login('own@sparky.test');
  for (const [m, p] of ROUTES) for (const tok of [gmTok, subTok]) assert.equal((await w.call(m, p, {}, tok)).status, 403, `company user on ${m} ${p}`);
  let checked = 0;
  for (const role of Object.keys(PLATFORM_ROLES).filter(r => r !== 'platform_owner')) {
    const u = w.store.get('users', w.ids.staff); u.platformRoles = [role]; w.store.put('users', u);
    const tok = await w.login('rev@bc.test');
    for (const [m, p, perm] of ROUTES) {
      const r = await w.call(m, p, {}, tok);
      const allowed = PLATFORM_ROLES[role].permissions.includes(perm);
      if (allowed) assert.notEqual(r.status, 403, `${role} should reach ${m} ${p}`); else assert.equal(r.status, 403, `${role} must be denied ${m} ${p}`);
      checked++;
    }
  }
  assert.equal(checked, 8 * ROUTES.length);
  const denied = w.store.data.audit.filter(a => a.action === 'admin.denied');
  assert.ok(denied.length >= 20 && denied.every(a => a.detail.outcome === 'denied' && a.detail.permission && a.detail.requestId));
  assert.ok((await w.call('GET', '/api/admin/overview', undefined, owner)).status === 200);
});

test('workflow 1: role grants need step-up; reviewers cannot grant roles; only an owner grants platform owner', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const grant = (tok, role) => w.call('POST', `/api/admin/users/${w.ids.staff}/platform-roles`, { role, grant: true, reason: 'joined verification team' }, tok);
  assert.equal((await grant(owner, 'verification_reviewer')).status, 428);                       // step-up required
  assert.equal((await w.call('POST', '/api/admin/step-up', { password: 'wrong password' }, owner)).status, 401);
  assert.equal((await w.call('POST', '/api/admin/step-up', { password: PW }, owner)).status, 200);
  const g = await grant(owner, 'verification_reviewer'); assert.equal(g.status, 200); assert.deepEqual(g.body.user.platformRoles, ['verification_reviewer']);
  assert.equal((await grant(owner, 'verification_reviewer')).status, 409);                       // already has it: refused, not re-audited
  assert.equal((await w.call('POST', `/api/admin/users/${w.ids.staff}/platform-roles`, { role: 'billing_admin', grant: false, reason: 'cleanup' }, owner)).status, 409);
  const rev = await w.login('rev@bc.test');
  assert.equal((await w.call('POST', `/api/admin/users/${w.ids.gm}/platform-roles`, { role: 'support_agent', grant: true, reason: 'test' }, rev)).status, 403);
  const u = w.store.get('users', w.ids.staff); u.platformRoles = ['platform_admin']; w.store.put('users', u);       // a platform admin…
  const adm = await w.login('rev@bc.test');
  assert.equal((await w.call('POST', `/api/admin/users/${w.ids.gm}/platform-roles`, { role: 'platform_owner', grant: true, reason: 'x' }, adm)).status, 403); // …lacks roles.manage entirely
  const ev = w.store.data.audit.find(a => a.action === 'admin.roles.grant');
  assert.deepEqual([ev.actor, ev.detail.before.platformRoles, ev.detail.after.platformRoles, ev.detail.reason], ['eric@bc.test', [], ['verification_reviewer'], 'joined verification team']);
});

test('workflow 2: request more information → company resubmits → approve; status and audit history persist', async (t) => {
  const w = await world(t);
  const u = w.store.get('users', w.ids.staff); u.platformRoles = ['verification_reviewer']; w.store.put('users', u);
  const rev = await w.login('rev@bc.test'), gm = await w.login('gm@abc.test');
  const decide = (decision, reason) => w.call('POST', `/api/admin/companies/${w.gc.id}/verification-decision`, { decision, reason }, rev);
  assert.equal((await decide('approve', '')).status, 400);                                       // reason required
  assert.equal((await decide('request_info', 'Website does not list the company; send a license number')).body.company.verification, 'more_info_requested');
  assert.equal((await w.call('GET', '/api/publisher', undefined, gm)).body.publisher.status, 'more_info_requested');
  assert.equal((await w.call('POST', '/api/publisher/verification', { website: 'https://abc.example', licenseNumber: 'IA-C-7781' }, gm)).body.status, 'pending');
  assert.equal((await decide('approve', 'Iowa contractor license IA-C-7781 checked on state register')).body.company.verification, 'verified');
  const d = (await w.call('GET', `/api/admin/companies/${w.gc.id}`, undefined, rev)).body;
  assert.equal(d.verificationDetail.status, 'verified'); assert.match(d.verificationDetail.note, /IA-C-7781/);
  assert.deepEqual(d.activity.filter(a => a.action === 'admin.company.verification').map(a => a.detail.after.status), ['verified', 'more_info_requested']);
});

test('workflows 3 + 5: suspension revokes sessions and blocks the company; reactivation restores it; session revocation works', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test'), gm = await w.login('gm@abc.test'), pe = await w.login('pe@abc.test');
  await w.call('POST', '/api/admin/step-up', { password: PW }, owner);
  assert.equal((await w.call('POST', `/api/admin/companies/${w.bc.id}/status`, { status: 'suspended', reason: 'test the platform company' }, owner)).status, 409);
  const s = await w.call('POST', `/api/admin/companies/${w.gc.id}/status`, { status: 'suspended', reason: 'Impersonation report under review' }, owner);
  assert.equal(s.status, 200); assert.equal(s.body.sessionsRevoked, 2);
  assert.equal((await w.call('GET', '/api/publisher', undefined, gm)).status, 401);                // old sessions dead
  const relog = await w.call('POST', '/api/login', { email: 'gm@abc.test', password: PW });
  assert.equal(relog.status, 403); assert.match(relog.body.error, /suspended/);
  assert.equal((await w.call('POST', `/api/admin/companies/${w.gc.id}/status`, { status: 'active', reason: 'Report resolved: legitimate company' }, owner)).status, 200);
  const gm2 = await w.login('gm@abc.test'); assert.equal((await w.call('GET', '/api/publisher', undefined, gm2)).status, 200);
  assert.deepEqual(w.store.get('orgs', w.gc.id).restrictions.map(r => r.type), ['suspension', 'reinstatement']);
  // workflow 5: revoke one user's sessions
  const subTok = await w.login('own@sparky.test');
  assert.equal((await w.call('POST', `/api/admin/users/${w.ids.sub}/revoke-sessions`, { reason: 'Reported lost laptop' }, owner)).body.sessionsRevoked, 1);
  assert.equal((await w.call('GET', '/api/org/users', undefined, subTok)).status, 401);
  void pe;
});

test('workflow 6: project-specific authority is approved separately from company verification', async (t) => {
  const w = await world(t);
  const { decideVerification, createPublication, addPackage, publish } = await import('../src/publishing.js');
  decideVerification(w.store, { email: 's' }, w.gc.id, { status: 'verified', note: 'license checked' });
  const gmUser = { ...w.store.get('users', w.ids.gm) };
  const p = createPublication(w.store, w.gc, gmUser, { title: 'Clinic', address: '1 A St', city: 'Ankeny', state: 'IA', projectType: 'medical', authorizationEvidence: 'Owner letter dated Oct 1' }).publication;
  assert.equal(p.authority.relationship, 'construction_manager');
  const pk = addPackage(w.store, w.gc, gmUser, p.id, { title: 'Electrical', trades: ['electrical'], dueDate: D(20), description: 'Complete electrical scope per drawings' }).package;
  const r = w.store.get('bidRequests', pk.id); r.noDocuments = true; w.store.put('bidRequests', r);
  assert.match(publish(w.store, w.gc, gmUser, p.id).error, /waiting for BUILDINTEL review/);      // verified company is not enough
  const u = w.store.get('users', w.ids.staff); u.platformRoles = ['verification_reviewer']; w.store.put('users', u);
  const rev = await w.login('rev@bc.test');
  const q = await w.call('GET', '/api/admin/authority', undefined, rev);   // no sort given: default applies
  assert.equal(q.body.items[0].review, 'pending');
  assert.equal((await w.call('POST', `/api/admin/authority/${p.id}/decision`, { decision: 'approved', reason: 'Called owner; letter confirmed' }, rev)).status, 200);
  assert.equal(publish(w.store, w.gc, gmUser, p.id).ok, true);
});

test('workflow 15 + redaction: auditors search but cannot change the audit log; no password ever lands in it', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  await w.call('POST', '/api/admin/step-up', { password: PW }, owner);
  await w.call('POST', `/api/admin/users/${w.ids.staff}/platform-roles`, { role: 'security_auditor', grant: true, reason: 'quarterly audit', password: PW, token: 'abc' }, owner);
  const aud = await w.login('rev@bc.test');
  const r = await w.call('GET', '/api/admin/audit?action=admin.roles&limit=5', undefined, aud);
  assert.equal(r.status, 200); assert.equal(r.body.items[0].action, 'admin.roles.grant'); assert.ok(r.body.items[0].detail.requestId);
  for (const m of ['PATCH', 'DELETE', 'PUT']) assert.equal((await w.call(m, '/api/admin/audit', {}, owner)).status, 404);   // no way to edit or delete
  assert.equal((await w.call('POST', `/api/admin/companies/${w.gc.id}/status`, { status: 'suspended', reason: 'auditor attempt' }, aud)).status, 403);
  assert.ok(!JSON.stringify(w.store.data.audit).includes(PW));
});

test('pagination and dashboard: limit capped, sort allow-listed, numbers match records, unavailable metrics say why', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  for (let i = 0; i < 120; i++) w.store.put('orgs', { slug: 'x' + i, name: 'Co ' + String(i).padStart(3, '0'), kind: 'subscriber', status: 'active', settings: {}, subscription: { plan: 'free' } });
  const p1 = (await w.call('GET', '/api/admin/companies?limit=500&sort=name', undefined, owner)).body;
  assert.equal(p1.items.length, 100); assert.equal(p1.total, 123); assert.equal(p1.nextCursor, '100');
  const p2 = (await w.call('GET', `/api/admin/companies?limit=100&sort=name&cursor=${p1.nextCursor}`, undefined, owner)).body;
  assert.equal(p2.items.length, 23); assert.equal(p2.nextCursor, null);
  assert.equal((await w.call('GET', '/api/admin/companies?sort=password', undefined, owner)).status, 400);
  assert.equal((await w.call('GET', '/api/admin/companies?sort=constructor', undefined, owner)).status, 400);   // no prototype keys
  assert.equal((await w.call('GET', '/api/admin/users', undefined, owner)).body.sort, 'email');                 // default sort when none given
  const ov = (await w.call('GET', '/api/admin/overview', undefined, owner)).body;
  const card = k => ov.sections.flatMap(s => s.cards).find(c => c.key === k);
  assert.deepEqual([card('companies').value, card('publishers_pending').value, card('users').value], [123, 1, 5]);
  assert.equal(card('mrr').value, null); assert.match(card('mrr').unavailable, /Stripe not connected/);
  assert.ok(ov.sections.flatMap(s => s.cards).every(c => c.formula || c.unavailable));
});

test('audit search runs in PostgreSQL: filters by action, actor, target, request id; paginates; newest first', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const { PgStore } = await import('../src/pgstore.js');
  const { auditSearch } = await import('../src/admin/service.js');
  const s = await new PgStore(process.env.TEST_DATABASE_URL, { listen: false }).init();
  try {
    await s.pool.query('TRUNCATE audit');
    for (let i = 0; i < 30; i++) s.audit({ actor: i % 2 ? 'eric@bc.test' : 'rev@bc.test', action: i % 3 ? 'admin.company.verification' : 'admin.user.disable', target: 'org' + (i % 5), detail: { requestId: 'req-' + i, outcome: 'success' } });
    await s.flushed();
    const q = o => auditSearch(s, new URLSearchParams(o));
    assert.equal((await q({ action: 'admin.user' })).total, 10);
    assert.equal((await q({ actor: 'rev@', action: 'admin.user' })).total, 5);
    assert.equal((await q({ requestId: 'req-7' })).items[0].target, 'org2');
    const p1 = await q({ limit: '20' }); assert.deepEqual([p1.items.length, p1.nextCursor, p1.engine], [20, '20', 'postgres']);
    assert.equal(p1.items[0].detail.requestId, 'req-29');                                   // newest first
    assert.equal((await q({ limit: '20', cursor: '20' })).items.length, 10);
  } finally { await s.close(); }
});
