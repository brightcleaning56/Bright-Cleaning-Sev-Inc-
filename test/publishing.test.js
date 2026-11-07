import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { backfillCore } from '../src/core.js';
import { saveDocument } from '../src/documents.js';
import { entitlementsFor, leadAccessFrom, seatCheck } from '../src/entitlements.js';
import { createPublication, addPackage, checklist, publish, setStatus, coverage, decideVerification, marketStatus, quickPublish, can } from '../src/publishing.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-pub-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n% plans\n%%EOF');
function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const owner = { email: 'gm@abc.test', role: 'owner', orgId: gc.id };
  const sub = (slug, trades, extra = {}) => store.put('orgs', { slug, name: slug, kind: 'subscriber', trades, territories: ['IA'], status: 'active', settings: {}, legal: { name: slug + ' LLC' }, subscription: { plan: 'local', status: 'active' }, ...extra });
  return { store, gc, owner, elec: sub('sparky', ['electrical']), elec2: sub('volt', ['electrical']), clean: sub('brightclean', ['cleaning']), clean2: sub('shine', ['cleaning']) };
}
const PROJECT = { title: 'Delaware Medical Office Building', address: '1200 SE Delaware Ave', city: 'Ankeny', state: 'IA', projectType: 'medical', description: 'New 120,000 SF medical office building', estValue: 48500000 };
const PKG = (title, trades, extra = {}) => ({ title, trades, dueDate: D(21), projectType: 'medical', description: `${title}: complete scope per drawings and specifications`, ...extra });

test('one catalog: legacy plans map onto it; publishers publish but do not get discovery; free gets invitations only; expired trial blocks', () => {
  assert.equal(entitlementsFor({ subscription: { plan: 'national', status: 'active' } }).plan, 'growth');
  assert.equal(leadAccessFrom({ subscription: { plan: 'national', status: 'active' }, territories: ['IA'] }).states.length, 51);
  assert.equal(entitlementsFor({ kind: 'buyer' }).plan, 'publisher_basic');
  assert.match(leadAccessFrom({ kind: 'buyer' }).reason, /publisher accounts publish/);
  assert.match(leadAccessFrom({ kind: 'subscriber', subscription: { plan: 'free' } }).reason, /invitations only/);
  assert.match(leadAccessFrom({ subscription: { plan: 'trial', status: 'trialing', trialEndsAt: D(-1) } }).reason, /trial ended/);
  assert.match(entitlementsFor({ subscription: { plan: 'professional', status: 'canceled' } }).reason, /canceled/);
});

test('publishing needs a verified company, permission, and evidence when acting for the owner', () => {
  const w = world();
  assert.equal(can({ role: 'member' }, 'publish'), false); assert.equal(can({ role: 'member', permissions: ['publish'] }, 'publish'), true);
  assert.equal(createPublication(w.store, w.gc, { email: 'est@abc.test', role: 'member' }, PROJECT).code, 403);
  assert.match(createPublication(w.store, w.gc, w.owner, { ...PROJECT, relationship: 'architect_for_owner' }).error, /authorization/);
  const p = createPublication(w.store, w.gc, w.owner, PROJECT).publication;
  assert.equal(p.authority.relationship, 'developer');
  addPackage(w.store, w.gc, w.owner, p.id, PKG('Electrical', ['electrical']));
  const c = checklist(w.store, w.gc, p);
  assert.equal(c.ready, false); assert.equal(c.items.find(i => i.key === 'verified').ok, false);
  assert.match(publish(w.store, w.gc, w.owner, p.id).error, /Company verified as a publisher/);
  assert.match(decideVerification(w.store, { email: 's' }, w.gc.id, { status: 'verified' }).error, /record how it was checked/);
});

test('full lifecycle: draft (invisible) → checklist → publish → invite-only vs eligible → can-bid answers → coverage → close/reopen/archive', () => {
  const w = world();
  decideVerification(w.store, { email: 'staff' }, w.gc.id, { status: 'verified', note: 'state business registration checked' });
  const p = createPublication(w.store, w.gc, w.owner, PROJECT).publication;
  const elecPkg = addPackage(w.store, w.gc, w.owner, p.id, PKG('Electrical', ['electrical'])).package;
  const cleanPkg = addPackage(w.store, w.gc, w.owner, p.id, PKG('Final cleaning', ['cleaning'], { distribution: 'invite_only', description: 'short' })).package;
  assert.equal(w.store.list('invitations').length, 0);                          // drafts invite nobody
  const c1 = checklist(w.store, w.gc, p);
  assert.match(c1.items.find(i => i.key === 'pkg:' + cleanPkg.id).detail, /scope needs a description.*invite-only package has no invitees.*no documents/);
  // fix: documents, scope, invitee list
  saveDocument(w.store, w.gc, w.owner, elecPkg.id, { name: 'E1.01 Power Plan.pdf', buffer: PDF });
  saveDocument(w.store, w.gc, w.owner, cleanPkg.id, { name: 'A6.1 Finish Schedule.pdf', buffer: Buffer.from('%PDF-1.4\n% finishes\n%%EOF') });
  const cp = w.store.get('bidRequests', cleanPkg.id); cp.description = 'Final construction clean of all floors, glass and fixtures'; cp.invitees = [w.clean.id]; w.store.put('bidRequests', cp);
  assert.equal(checklist(w.store, w.gc, p).ready, true);
  const r = publish(w.store, w.gc, w.owner, p.id);
  assert.equal(r.ok, true); assert.equal(r.packagesOpened, 2);
  const invitedTo = id => w.store.list('invitations', i => i.requestId === id).map(i => w.store.get('orgs', i.sellerOrgId).slug).sort();
  assert.deepEqual(invitedTo(elecPkg.id), ['sparky', 'volt']);                   // eligible: every matching electrician
  assert.deepEqual(invitedTo(cleanPkg.id), ['brightclean']);                     // invite-only: just the list, not "shine"
  const pid = w.store.get('publications', p.id).projectId;
  assert.ok(/^BI-/.test(pid)); assert.equal(w.store.get('projects', pid).phase, 'bidding');
  const ms = marketStatus(w.store, pid, w.clean2);
  assert.deepEqual([ms.status, ms.canBid], ['open_for_bids', false]); assert.match(ms.explanation, /isn't invited/);
  assert.equal(marketStatus(w.store, pid, w.clean).canBid, true);
  const cov = coverage(w.store, w.gc, p.id);
  assert.deepEqual([cov.totals.packages, cov.totals.invited, cov.totals.bids], [2, 3, 0]);
  assert.equal(setStatus(w.store, w.gc, w.owner, p.id, 'archived').code, 409);   // must close first
  setStatus(w.store, w.gc, w.owner, p.id, 'closed');
  assert.equal(marketStatus(w.store, pid, w.clean).status, 'bidding_closed');
  setStatus(w.store, w.gc, w.owner, p.id, 'published');
  assert.equal(marketStatus(w.store, pid, w.clean).status, 'open_for_bids');
  setStatus(w.store, w.gc, w.owner, p.id, 'closed'); assert.equal(setStatus(w.store, w.gc, w.owner, p.id, 'archived').ok, true);
  assert.deepEqual(w.store.get('publications', p.id).statusHistory.map(h => h.status), ['draft', 'published', 'closed', 'published', 'closed', 'archived']);
});

test('a discovered permit is never a bid opportunity; a draft is visible only to its publisher', () => {
  const w = world();
  ingestPermits(w.store, { id: 's', jurisdiction: 'ank', city: 'Ankeny', state: 'IA', url: 'u' }, [{ permitId: 'P1', address: '1200 SE Delaware Ave', permitType: 'Commercial New', description: 'New medical office building', issuedDate: D(-3), status: 'Issued', valuation: '48500000' }]);
  backfillCore(w.store);
  const pid = w.store.list('projects')[0].id;
  assert.deepEqual([marketStatus(w.store, pid, w.elec).status, marketStatus(w.store, pid, w.elec).canBid], ['discovered', false]);
  decideVerification(w.store, { email: 'staff' }, w.gc.id, { status: 'verified', note: 'checked' });
  createPublication(w.store, w.gc, w.owner, { ...PROJECT, projectId: pid });
  assert.equal(marketStatus(w.store, pid, w.gc).status, 'pre_bid');               // the publisher sees its draft
  assert.equal(marketStatus(w.store, pid, w.elec).status, 'discovered');          // bidders don't
});

test('publisher plan limits active projects (Basic: 3); one-step post follows the same rules', () => {
  const w = world();
  assert.match(quickPublish(w.store, w.gc, w.owner, { ...PROJECT, ...PKG('Roofing', ['roofing']) }).error, /verified/);
  assert.equal(w.store.list('publications').length, 0);                          // nothing left behind on refusal
  decideVerification(w.store, { email: 'staff' }, w.gc.id, { status: 'verified', note: 'checked' });
  for (let i = 0; i < 3; i++) assert.equal(quickPublish(w.store, w.gc, w.owner, { ...PROJECT, title: 'Project ' + i, ...PKG('Roofing ' + i, ['roofing']) }).ok, true);
  assert.match(quickPublish(w.store, w.gc, w.owner, { ...PROJECT, title: 'Project 4', ...PKG('Roofing 4', ['roofing']) }).error, /Plan allows another active project.*3 of 3/);
  w.gc.subscription = { plan: 'publisher_pro', status: 'active' }; w.store.put('orgs', w.gc);
  assert.equal(quickPublish(w.store, w.gc, w.owner, { ...PROJECT, title: 'Project 4', ...PKG('Roofing 4', ['roofing']) }).ok, true);
});

test('HTTP: seats are enforced; permissions control publish, upload and award', async (t) => {
  const w = world();
  decideVerification(w.store, { email: 'staff' }, w.gc.id, { status: 'verified', note: 'checked' });
  w.store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: w.gc.id, passwordHash: hashPassword('owner password 123') });
  const srv = createServer(w.store).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const login = async (e, pw) => (await call('POST', '/api/login', { email: e, password: pw })).body.token;
  const gm = await login('gm@abc.test', 'owner password 123');
  assert.equal((await call('POST', '/api/org/users', { email: 'est@abc.test', password: 'estimator pass 123', role: 'member', permissions: ['upload'] }, gm)).status, 200);
  assert.equal((await call('POST', '/api/org/users', { email: 'pm@abc.test', password: 'pm password 1234', role: 'member' }, gm)).status, 200);
  const third = await call('POST', '/api/org/users', { email: 'x@abc.test', password: 'another pass 123', role: 'member' }, gm);
  assert.equal(third.status, 402); assert.match(third.body.error, /seat limit reached \(3 of 3/);   // Publisher Basic: 3 seats
  const est = await login('est@abc.test', 'estimator pass 123');
  assert.equal((await call('POST', '/api/publications', PROJECT, est)).status, 403);              // upload-only member can't publish
  const pub = (await call('POST', '/api/publications', PROJECT, gm)).body;
  const pk = (await call('POST', `/api/publications/${pub.id}/packages`, PKG('Electrical', ['electrical']), gm)).body;
  const up = await fetch(`${base}/api/requests/${pk.id}/documents?name=E1.pdf`, { method: 'POST', headers: { authorization: 'Bearer ' + est, 'content-type': 'application/pdf' }, body: PDF });
  assert.equal(up.status, 200);                                                                   // upload permission works
  assert.equal((await call('POST', `/api/publications/${pub.id}/publish`, {}, est)).status, 403);
  const pubd = await call('POST', `/api/publications/${pub.id}/publish`, {}, gm);
  assert.equal(pubd.status, 200, JSON.stringify(pubd.body)); assert.equal(pubd.body.invited, 2);
  assert.equal((await call('POST', `/api/requests/${pk.id}/award`, { submissionId: 'x', signerName: 'E', consent: true }, est)).status, 403); // no award permission
  const sub = (await call('GET', '/api/subscription', undefined, gm)).body;
  assert.deepEqual([sub.entitlements.plan, sub.usage.seatsUsed, sub.usage.activePublications], ['publisher_basic', 3, 1]);
  assert.ok(sub.catalog.every(c => c.line === 'publisher'));
});

test('AI credits come from the plan (never above the platform cap); Free has none', async () => {
  const { aiAllowance } = await import('../src/entitlements.js');
  assert.deepEqual([aiAllowance({ kind: 'subscriber', subscription: { plan: 'free' } }), aiAllowance({ subscription: { plan: 'local', status: 'active' } }), aiAllowance({ subscription: { plan: 'growth', status: 'active' } }), aiAllowance({ kind: 'buyer' })], [0, 5, 50, 5]);
  const { analyzeDocument } = await import('../src/ai.js');
  const prev = config.anthropicKey; config.anthropicKey = 'k';
  const r = await analyzeDocument(new Store(null), { id: 'o', kind: 'subscriber', subscription: { plan: 'free' } }, { email: 'a' }, 'doc');
  config.anthropicKey = prev;
  assert.equal(r.code, 404);                                     // (unknown document is checked first)
});

test('coverage states the document situation explicitly: uploaded (with revision), intentionally none, or missing — plus blockers', () => {
  const w = world();
  decideVerification(w.store, { email: 'staff' }, w.gc.id, { status: 'verified', note: 'checked' });
  const p = createPublication(w.store, w.gc, w.owner, PROJECT).publication;
  const a = addPackage(w.store, w.gc, w.owner, p.id, PKG('Electrical', ['electrical'])).package;
  const b = addPackage(w.store, w.gc, w.owner, p.id, PKG('Cleaning', ['cleaning'], { distribution: 'invite_only' })).package;
  const c = addPackage(w.store, w.gc, w.owner, p.id, PKG('Roofing', ['roofing'])).package;
  saveDocument(w.store, w.gc, w.owner, a.id, { name: 'E1.01 Power Plan.pdf', buffer: PDF });
  const rb = w.store.get('bidRequests', b.id); rb.noDocuments = true; rb.invitees = [w.clean.id]; w.store.put('bidRequests', rb);
  const byTitle = Object.fromEntries(coverage(w.store, w.gc, p.id).packages.map(k => [k.title, k]));
  assert.deepEqual([byTitle.Electrical.documentsState, byTitle.Electrical.currentRevision], ['uploaded', 'Original']);
  assert.deepEqual([byTitle.Cleaning.documentsState, byTitle.Cleaning.inviteeCount, byTitle.Cleaning.blockers], ['intentionally_none', 1, null]);
  assert.equal(byTitle.Roofing.documentsState, 'missing'); assert.match(byTitle.Roofing.blockers, /no documents/);
});
