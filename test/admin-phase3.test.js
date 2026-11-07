import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { ingestPermits } from '../src/permits.js';
import { backfillCore, linkBidRequestTo, linkDocument } from '../src/core.js';
import { createRequest, submitBid } from '../src/marketplace.js';
import { saveDocument, viewLink } from '../src/documents.js';
import { PLATFORM_ROLES } from '../src/admin/rbac.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-adm3-'));
const PW = 'correct horse battery 1';
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
async function world(t) {
  const store = new Store(null);
  const bc = store.put('orgs', { slug: 'bc', name: 'Bright Clean', status: 'active', settings: {}, subscription: { plan: 'internal', status: 'active' } });
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {}, publisher: { status: 'verified' } });
  const sub = store.put('orgs', { slug: 'sp', name: 'Sparky Electric', kind: 'subscriber', trades: ['electrical'], territories: ['WA'], status: 'active', settings: {}, legal: { name: 'Sparky LLC' }, subscription: { plan: 'local', status: 'active' } });
  const user = (email, orgId, extra = {}) => store.put('users', { email, orgId, role: 'owner', passwordHash: hashPassword(PW), ...extra });
  const ids = { owner: user('eric@bc.test', bc.id, { role: 'platform_owner' }).id, staff: user('ops@bc.test', bc.id, { role: 'member' }).id, gm: user('gm@abc.test', gc.id).id, sub: user('own@sparky.test', sub.id).id };
  // Two projects for one building: one city record omits the street type ("100 Pine"), so they don't auto-join.
  ingestPermits(store, { id: 'sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'u' }, [
    { permitId: 'S1', address: '100 Pine St', permitType: 'New', description: 'New commercial office building', issuedDate: D(-5), status: 'Issued', valuation: '9000000' },
    { permitId: 'S2', address: '100 Pine', permitType: 'New', description: 'New commercial office building B', issuedDate: D(-4), status: 'Issued', valuation: '4000000' }]);
  backfillCore(store);
  const pA = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S1')[0].id).projectId;
  const pB = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S2')[0].id).projectId;
  const { request } = createRequest(store, gc, { email: 'gm@abc.test' }, { title: 'Bldg B electrical', address: '100 Pine', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['electrical'], dueDate: D(10) });
  linkBidRequestTo(store, request, pB);
  const doc = saveDocument(store, gc, { email: 'gm@abc.test' }, request.id, { name: 'E1.01 Power Plan.pdf', buffer: Buffer.from('%PDF-1.4\n% plan\n%%EOF') }).document;
  linkDocument(store, store.get('documents', doc.id));                                     // as the upload route does
  const inv = store.list('invitations', i => i.requestId === request.id && i.sellerOrgId === sub.id)[0];
  const bid = submitBid(store, sub, { email: 'own@sparky.test' }, inv.id, { amount: '182500', scope: 'Electrical per E-series drawings, Division 26.' }).submission;
  const srv = createServer(store).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: m === 'GET' || b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const login = async e => (await call('POST', '/api/login', { email: e, password: PW })).body.token;
  return { store, gc, sub, ids, pA, pB, request, doc, bid, base, call, login };
}

const ROUTES = [['GET', '/api/admin/projects', 'admin.project.read'], ['GET', '/api/admin/duplicates', 'admin.project.read'], ['POST', '/api/admin/projects/X/resolve', 'admin.project.correct'],
  ['POST', '/api/admin/projects-merge', 'admin.project.merge'], ['POST', '/api/admin/projects/X/split', 'admin.project.merge'], ['POST', '/api/admin/review/X/resolve', 'admin.project.correct'],
  ['GET', '/api/admin/packages', 'admin.bid.read'], ['POST', '/api/admin/packages/X/access', 'admin.document.access.revoke'], ['GET', '/api/admin/documents', 'admin.bid.read'],
  ['POST', '/api/admin/documents/X/quarantine', 'admin.document.access.revoke'], ['GET', '/api/admin/markets', 'admin.dashboard.read']];

test('phase 3 permission matrix: every new route × every platform role; company users always denied', async (t) => {
  const w = await world(t);
  const gm = await w.login('gm@abc.test');
  for (const [m, p] of ROUTES) assert.equal((await w.call(m, p, {}, gm)).status, 403, `company user on ${m} ${p}`);
  for (const role of Object.keys(PLATFORM_ROLES).filter(r => r !== 'platform_owner')) {
    const u = w.store.get('users', w.ids.staff); u.platformRoles = [role]; w.store.put('users', u);
    const tok = await w.login('ops@bc.test');
    for (const [m, p, perm] of ROUTES) { const st = (await w.call(m, p, {}, tok)).status, ok = PLATFORM_ROLES[role].permissions.includes(perm);
      if (ok) assert.notEqual(st, 403, `${role} → ${m} ${p}`); else assert.equal(st, 403, `${role} must be denied ${m} ${p}`); }
  }
});

test('workflow 7: likely duplicates found; merge preview; merge needs step-up; package and bid untouched; old id resolves', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const dup = (await w.call('GET', '/api/admin/duplicates', undefined, owner)).body.items.find(x => x.type === 'likely_duplicate');
  assert.deepEqual(dup.projects.map(p => p.id).sort(), [w.pA, w.pB].sort());
  const pv = (await w.call('GET', `/api/admin/merge-preview?keep=${w.pA}&drop=${w.pB}`, undefined, owner)).body;
  assert.deepEqual([pv.moves.permits, pv.moves.packages, pv.moves.documents], [1, 1, 1]);
  const before = { ...w.store.get('submissions', w.bid.id) };
  const m = () => w.call('POST', '/api/admin/projects-merge', { keepId: w.pA, dropId: w.pB, reason: 'Same building: Bldg B is part of 100 Pine St campus' }, owner);
  assert.equal((await m()).status, 428);
  await w.call('POST', '/api/admin/step-up', { password: PW }, owner);
  assert.equal((await m()).status, 200);
  const d = (await w.call('GET', `/api/admin/projects/${w.pB}`, undefined, owner)).body;     // merged-away id
  assert.equal(d.id, w.pA); assert.ok(d.aliases.includes(w.pB)); assert.deepEqual([d.permits.length, d.packages.length], [2, 1]);
  assert.deepEqual(w.store.get('submissions', w.bid.id), before);                            // bid record unchanged
  assert.equal(w.store.get('projectLinks', 'bid_request:' + w.request.id).projectId, w.pA);
  assert.equal(w.store.data.audit.filter(a => a.action === 'admin.project.merge').length, 1);
});

test('workflow 8: corrections keep the original value and never touch source permits; status changes need a reason', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const permitBefore = JSON.stringify(w.store.list('permits', p => p.permitId === 'S1')[0]);
  const fix = b => w.call('POST', `/api/admin/projects/${w.pA}/resolve`, b, owner);
  assert.equal((await fix({ action: 'correct', field: 'address', value: 'x', reason: 'wrong field' })).status, 400);   // only typed fields
  const r = await fix({ action: 'correct', field: 'name', value: 'Pine Street Office Campus', reason: 'Name from the developer site plan' });
  assert.equal(r.status, 200);
  assert.equal((await fix({ action: 'correct', field: 'name', value: 'Pine Street Office Campus', reason: 'again please' })).status, 409);
  const d = (await w.call('GET', `/api/admin/projects/${w.pA}`, undefined, owner)).body;
  assert.equal(d.name, 'Pine Street Office Campus'); assert.equal(d.corrections[0].from, 'New commercial office building'); assert.equal(d.corrections[0].by, 'eric@bc.test');
  assert.equal(JSON.stringify(w.store.list('permits', p => p.permitId === 'S1')[0]), permitBefore);   // source record untouched
  assert.equal((await fix({ action: 'status', status: 'invalid', reason: '' })).status, 400);
  assert.equal((await fix({ action: 'status', status: 'stale', reason: 'Permit withdrawn per city portal' })).body.project.status, 'stale');
  const ev = w.store.data.audit.find(a => a.action === 'admin.project.correct');
  assert.deepEqual([ev.detail.before.name, ev.detail.after.name], ['New commercial office building', 'Pine Street Office Campus']);
});

test('workflow 9: bid oversight shows originals (amount, time, receipt) and has no way to change them', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const before = JSON.stringify(w.store.get('submissions', w.bid.id));
  const pk = (await w.call('GET', `/api/admin/packages/${w.request.id}`, undefined, owner)).body;
  assert.equal(pk.submissions[0].amount, 182500); assert.equal(pk.submissions[0].late, false); assert.ok(pk.submissions[0].receipt);
  for (const [m, p] of [['PATCH', `/api/admin/packages/${w.request.id}`], ['POST', `/api/admin/packages/${w.request.id}/submissions`], ['DELETE', `/api/admin/packages/${w.request.id}`], ['PATCH', `/api/admin/submissions/${w.bid.id}`]])
    assert.equal((await w.call(m, p, { amount: 1 }, owner)).status, 404, `${m} ${p} must not exist`);
  assert.equal(JSON.stringify(w.store.get('submissions', w.bid.id)), before);
});

test('workflow 10: revoking access kills a link issued earlier; restore works; quarantine blocks everyone', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const oldLink = viewLink(w.store, w.sub, { id: w.ids.sub }, w.doc.id).url;               // issued before revocation
  assert.equal((await fetch(w.base + oldLink)).status, 200);
  await w.call('POST', '/api/admin/step-up', { password: PW }, owner);
  const rv = await w.call('POST', `/api/admin/packages/${w.request.id}/access`, { orgId: w.sub.id, revoke: true, reason: 'Bidder disputed NDA terms' }, owner);
  assert.equal(rv.status, 200);
  assert.notEqual((await fetch(w.base + oldLink)).status, 200);                             // old link refused immediately
  assert.equal(viewLink(w.store, w.sub, { id: w.ids.sub }, w.doc.id).code, 404);             // and no new link
  assert.equal((await w.call('POST', `/api/admin/packages/${w.request.id}/access`, { orgId: w.gc.id, revoke: true, reason: 'cut off the publisher' }, owner)).status, 409);
  const det = (await w.call('GET', `/api/admin/documents/${w.doc.id}`, undefined, owner)).body;
  assert.ok(det.canView.some(x => x.orgId === w.sub.id && /REVOKED/.test(x.basis)));
  await w.call('POST', `/api/admin/packages/${w.request.id}/access`, { orgId: w.sub.id, revoke: false, reason: 'NDA signed' }, owner);
  assert.equal((await fetch(w.base + viewLink(w.store, w.sub, { id: w.ids.sub }, w.doc.id).url)).status, 200);
  const q = await w.call('POST', `/api/admin/documents/${w.doc.id}/quarantine`, { quarantine: true, reason: 'Suspicious embedded content reported' }, owner);
  assert.equal(q.body.document.state, 'quarantined');
  assert.equal(viewLink(w.store, w.gc, { id: w.ids.gm }, w.doc.id).code, 404);               // even the publisher
  assert.deepEqual(w.store.data.audit.filter(a => a.action.startsWith('admin.document')).map(a => a.action), ['admin.document.access.revoke', 'admin.document.access.restore', 'admin.document.quarantine']);
});
