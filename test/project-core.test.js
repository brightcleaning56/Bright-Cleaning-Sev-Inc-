import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { createRequest, submitBid, awardRequest } from '../src/marketplace.js';
import { saveDocument } from '../src/documents.js';
import { backfillCore, linkPermit, coreView, searchCoreMemory, mergeProjects, splitLinks, resolveReview, resolveProjectId, linkBidRequest, linkAward, recomputePhase } from '../src/core.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-core-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const SEA = { id: 'sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'https://data.seattle.gov' };
const ID = /^BI-[2-9A-HJ-NP-Z]{8}$/;
const permit = (id, address, extra = {}) => ({ permitId: id, address, permitType: 'New', description: 'New commercial office building', issuedDate: D(-5), status: 'Issued', valuation: '9000000', ...extra });
const sub = store => store.put('orgs', { slug: 's', name: 'Emerald', kind: 'subscriber', trades: ['glazing'], territories: ['WA'], status: 'active', settings: {}, legal: { name: 'Emerald LLC' }, subscription: { plan: 'local', status: 'active' } });

test('incremental linking only touches changed records; a full re-scan finds nothing missed', () => {
  const store = new Store(null);
  ingestPermits(store, SEA, [permit('S1', '400 Pine St'), permit('S4', '12 Mercer St')]);
  assert.equal(backfillCore(store).mode, 'full');                                   // first run in a process is full
  // The cursor is inclusive ("changed at or after the last run"), so a record written in the same millisecond is re-checked
  // rather than missed. Re-checking is harmless (linking is idempotent); what matters is nothing new is created or missed.
  const quiet = backfillCore(store); assert.deepEqual([quiet.mode, quiet.newProjects, quiet.newLinks], ['incremental', 0, 0]);
  assert.ok(quiet.permits <= 2);
  ingestPermits(store, SEA, [permit('S9', '77 Union St')]);
  const inc = backfillCore(store); assert.ok(inc.permits >= 1); assert.equal(inc.newProjects, 1);
  const all = backfillCore(store, { full: true }); assert.deepEqual([all.newProjects, all.newLinks], [0, 0]);
});

test('one permanent project per development: address variants and suites join; IDs are stable and readable', () => {
  const store = new Store(null);
  ingestPermits(store, SEA, [permit('S1', '400 Pine St'), permit('S2', '400 Pine Street', { description: 'Tenant improvement, office' }), permit('S3', '400 PINE ST Suite 200', { description: 'Tenant improvement suite 200' }), permit('S4', '12 Mercer St')]);
  const r = backfillCore(store);
  assert.equal(r.projects, 2); assert.equal(r.permits, 4);
  const ids = store.list('projects').map(p => p.id); assert.ok(ids.every(i => ID.test(i)));
  const again = backfillCore(store);
  assert.deepEqual([again.newProjects, again.newLinks], [0, 0]);                 // idempotent
  const pine = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S1')[0].id).projectId;
  ingestPermits(store, SEA, [permit('S1', '400 Pine St', { description: 'Revised: new 6-story office building' })]);
  backfillCore(store);
  assert.equal(store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S1')[0].id).projectId, pine); // same ID after changes
});

test('lifecycle: land-use filing creates a planning project; bid request and permits move it forward with history', () => {
  const store = new Store(null);
  store.put('signals', { id: 'lu:1', kind: 'land_use_application', state: 'WA', city: 'Seattle', address: '1501 4th Ave', title: 'Land use application: 24-story office tower', url: 'https://seattle.gov/x', sourceId: 'lu' });
  backfillCore(store);
  const pid = store.get('projectLinks', 'land_use:lu:1').projectId;
  assert.equal(store.get('projects', pid).phase, 'planning');
  const gc = store.put('orgs', { slug: 'gc', name: 'Acme GC', kind: 'buyer', buyerKind: 'general_contractor', status: 'active' });
  const { request } = createRequest(store, gc, { email: 'pm' }, { title: 'Tower — curtain wall', address: '1501 4th Avenue', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['glazing'], dueDate: D(20) });
  linkBidRequest(store, request); recomputePhase(store, pid);
  assert.equal(store.get('projectLinks', 'bid_request:' + request.id).projectId, pid);
  assert.equal(store.get('projects', pid).phase, 'bidding');
  ingestPermits(store, SEA, [permit('T1', '1501 4th Ave', { status: 'Issued' })]);
  backfillCore(store);
  assert.equal(store.get('projects', pid).phase, 'construction');
  const hist = store.list('projectPhases', h => h.projectId === pid).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(hist.map(h => h.phase), ['planning', 'bidding', 'construction']);
  assert.equal(hist.filter(h => !h.endedAt).length, 1);                           // only the current phase is open
});

test('company relationships carry source, method, verification and dates', async () => {
  const store = new Store(null);
  ingestPermits(store, SEA, [permit('S1', '400 Pine St', { contractor: 'Sellen Construction Co Inc', owner: 'Pine St Development LLC', architect: 'Carter & Reeves', sourceUrl: 'https://data.seattle.gov/r/S1' })]);
  backfillCore(store);
  const pid = store.list('projects')[0].id;
  const gcRow = store.list('projectCompanies', c => c.projectId === pid && c.role === 'general_contractor')[0];
  assert.deepEqual([gcRow.name, gcRow.verified, gcRow.method, gcRow.sourceKind, gcRow.sourceRef, gcRow.sourceUrl], ['Sellen Construction Co Inc', false, 'named on permit', 'permit', 'S1', 'https://data.seattle.gov/r/S1']);
  const first = gcRow.firstSeenAt; await new Promise(r => setTimeout(r, 5));
  ingestPermits(store, SEA, [permit('S1', '400 Pine St', { contractor: 'Sellen Construction Co Inc', owner: 'Pine St Development LLC', architect: 'Carter & Reeves', sourceUrl: 'https://data.seattle.gov/r/S1' })]); // the city record is re-pulled
  backfillCore(store);                                                                // incremental: only re-pulled records are re-linked
  const again = store.get('projectCompanies', gcRow.id);
  assert.equal(again.firstSeenAt, first); assert.ok(again.lastSeenAt > first);
  assert.deepEqual(store.list('projectCompanies', c => c.projectId === pid).map(c => c.role).sort(), ['architect', 'general_contractor', 'owner']);
  // GC posts from its own account (verified), a bidder is awarded (verified), drawings link through the bid request
  const gc = store.put('orgs', { slug: 'gc', name: 'Sellen Construction', kind: 'buyer', buyerKind: 'general_contractor', status: 'active' });
  const s = sub(store); const user = { email: 'est@em.test' };
  const { request } = createRequest(store, gc, { email: 'pm' }, { title: 'Glazing', address: '400 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['glazing'], dueDate: D(9) });
  saveDocument(store, gc, { email: 'pm' }, request.id, { name: 'A2.1 Plan.pdf', buffer: Buffer.from('%PDF-1.4 x') });
  backfillCore(store);
  const inv = store.list('invitations', i => i.sellerOrgId === s.id)[0];
  const b = submitBid(store, s, user, inv.id, { amount: '250000', scope: 'Curtain wall and storefront per A-series.' });
  const aw = awardRequest(store, gc, { email: 'pm' }, request.id, b.submission.id, { signerName: 'Pat', consent: true, ip: '1.1.1.1' });
  linkAward(store, store.get('contracts', aw.contractId));
  const roles = store.list('projectCompanies', c => c.projectId === pid).map(c => [c.role, c.verified, c.method]);
  assert.ok(roles.some(([r, v, m]) => r === 'general_contractor' && v && /own account/.test(m)));   // verification credited to the account, not the permit
  const gcEv = store.list('projectCompanies', c => c.projectId === pid && c.role === 'general_contractor')[0].evidence;
  assert.deepEqual(gcEv.map(e => [e.kind, e.verified]), [['permit', false], ['bid_request', true]]); // both sources kept
  assert.ok(roles.some(([r, v, m]) => r === 'trade_contractor' && v && m === 'signed award'));
  assert.equal(store.list('projectLinks', l => l.projectId === pid && l.kind === 'document').length, 1);
  assert.equal(store.list('projectLinks', l => l.projectId === pid && l.kind === 'contract').length, 1);
});

test('ambiguous matches go to review, never guessed; merge keeps the surviving ID and old IDs still resolve; split', () => {
  const store = new Store(null);
  ingestPermits(store, SEA, [permit('A1', '9 Elm St'), permit('A2', '9 Elm St', { description: 'Retail TI' })]);
  backfillCore(store);
  const p1 = store.list('projects')[0].id;
  const s = splitLinks(store, p1, ['permit:' + store.list('permits', p => p.permitId === 'A2')[0].id], 'admin');
  assert.ok(ID.test(s.projectId));
  assert.equal(splitLinks(store, p1, store.list('projectLinks', l => l.projectId === p1).map(l => l.id), 'admin').code, 400); // can't split everything
  ingestPermits(store, SEA, [permit('A3', '9 Elm Street', { description: 'Commercial reroof', permitType: 'Roof', issuedDate: D(-1), valuation: '80000' })]);
  const r = backfillCore(store);
  assert.equal(r.ambiguous, 1);
  const item = store.list('reviewQueue', x => x.status === 'open')[0];
  assert.deepEqual(item.candidates.sort(), [p1, s.projectId].sort());
  assert.equal(store.get('projectLinks', item.id), null);                                    // not linked by guess
  assert.equal(resolveReview(store, item.id, 'BI-NOTACAND', 'admin').code, 400);
  assert.equal(resolveReview(store, item.id, s.projectId, 'admin').ok, true);
  assert.equal(store.get('projectLinks', item.id).method, 'chosen in review');
  const m = mergeProjects(store, p1, s.projectId, 'admin');
  assert.equal(m.ok, true);
  assert.equal(store.get('projects', s.projectId), null);
  assert.equal(resolveProjectId(store, s.projectId), p1);                                     // old ID still works
  assert.equal(store.list('projectLinks', l => l.projectId === p1).length, 3);
  assert.equal(backfillCore(store).ambiguous, 0);                                             // merged: no more ambiguity
});

test('visibility: territory for permits; bid packages and drawings only for the GC and invited companies', () => {
  const store = new Store(null);
  ingestPermits(store, SEA, [permit('S1', '400 Pine St')]);
  const gc = store.put('orgs', { slug: 'gc', name: 'Acme GC', kind: 'buyer', buyerKind: 'general_contractor', status: 'active' });
  const s = sub(store);
  const roofer = store.put('orgs', { slug: 'r', name: 'Roofer', kind: 'subscriber', trades: ['roofing'], territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  const texan = store.put('orgs', { slug: 't', name: 'Tex', kind: 'subscriber', trades: ['glazing'], territories: ['TX'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  const { request } = createRequest(store, gc, { email: 'pm' }, { title: 'Glazing', address: '400 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['glazing'], dueDate: D(9) });
  saveDocument(store, gc, { email: 'pm' }, request.id, { name: 'A2.1 Plan.pdf', buffer: Buffer.from('%PDF-1.4 y') });
  backfillCore(store);
  const pid = store.list('projects')[0].id;
  const mine = coreView(store, s, pid).project;
  assert.deepEqual([mine.counts.permits, mine.counts.bidPackages, mine.counts.documents], [1, 1, 1]);
  const other = coreView(store, roofer, pid).project;                                          // in territory, not invited
  assert.deepEqual([other.counts.permits, other.counts.bidPackages, other.counts.documents], [1, 0, 0]);
  assert.equal(coreView(store, texan, pid).code, 404);                                         // outside territory
  assert.equal(coreView(store, gc, pid).project.counts.bidPackages, 1);                        // the GC sees its own package
});

test('database-style search in memory: filters, order, territory', () => {
  const store = new Store(null);
  ingestPermits(store, SEA, [permit('S1', '400 Pine St', { valuation: '48500000' }), permit('S2', '12 Mercer St', { valuation: '150000', description: 'Retail tenant improvement' })]);
  ingestPermits(store, { id: 'aus', jurisdiction: 'aus', city: 'Austin', state: 'TX', url: 'u' }, [permit('T1', '1 Congress Ave', { valuation: '5000000' })]);
  backfillCore(store);
  assert.deepEqual(searchCoreMemory(store, { states: ['WA'] }).map(r => r.estValue), [48500000, 150000]);
  assert.equal(searchCoreMemory(store, { states: ['WA'], q: 'mercer' }).length, 1);
  assert.equal(searchCoreMemory(store, { states: null, minValue: 1000000 }).length, 2);
});

// ---------------- PostgreSQL: relational tables, same-transaction dual-write, reconcile, SQL = memory ----------------
const url = process.env.TEST_DATABASE_URL;
test('postgres core: schema v2 tables, transactional dual-write, reconcile, SQL search matches, merge, re-sync', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { PgStore } = await import('../src/pgstore.js');
  const { reconcileCore, searchCoreSql } = await import('../src/coredb.js');
  const reset = await new PgStore(url).init();
  await reset.pool.query('TRUNCATE records, audit, bi_projects, bi_project_links, bi_project_companies, bi_project_phases, bi_project_aliases'); await reset.pool.end();
  const pg = await new PgStore(url).init();
  ingestPermits(pg, SEA, [permit('S1', '400 Pine St', { valuation: '48500000', contractor: 'Sellen Construction' }), permit('S2', '400 Pine Street', { description: 'TI' }), permit('S3', '12 Mercer St', { valuation: '150000' })]);
  ingestPermits(pg, { id: 'aus', jurisdiction: 'aus', city: 'Austin', state: 'TX', url: 'u' }, [permit('T1', '1 Congress Ave', { valuation: '5000000' })]);
  backfillCore(pg); pg.save(); await pg.flushed();
  assert.equal(pg.lastFlushError, null);
  const rec = await reconcileCore(pg.pool, pg);
  assert.equal(rec.ok, true, JSON.stringify(rec.tables)); assert.equal(rec.schemaVersion, 4);
  assert.equal(rec.tables.projects.table, 3);
  for (const args of [{ states: ['WA'] }, { states: null }, { states: ['WA'], q: 'mercer' }, { states: null, minValue: 1000000 }])
    assert.deepEqual((await searchCoreSql(pg.pool, args)).map(r => r.id), searchCoreMemory(pg, args).map(r => r.id), JSON.stringify(args));
  const [a, b] = pg.list('projects', p => p.state === 'WA').map(p => p.id);
  mergeProjects(pg, a, b, 'admin'); pg.save(); await pg.flushed();
  assert.equal((await pg.pool.query('SELECT count(*)::int n FROM bi_projects WHERE id = $1', [b])).rows[0].n, 0);
  assert.equal((await pg.pool.query('SELECT project_id FROM bi_project_aliases WHERE alias_id = $1', [b])).rows[0].project_id, a);
  assert.equal((await reconcileCore(pg.pool, pg)).ok, true);
  const again = await new PgStore(url).init();                                               // reload: identical
  assert.equal(again.checksum(), pg.checksum());
  await again.pool.query('TRUNCATE bi_projects'); await again.pool.end();                    // relational table lost
  const healed = await new PgStore(url).init();                                              // init re-copies from records
  assert.equal((await reconcileCore(healed.pool, healed)).tables.projects.table, 2);
  await Promise.all([pg.pool.end(), healed.pool.end()]);
});

test('linking scales linearly (regression: phase recompute was quadratic — 67 s at 10,000 permits)', () => {
  const time = n => {
    const store = new Store(null); const rows = [];
    for (let i = 0; i < n; i++) rows.push({ permitId: 'P' + i, address: `${1000 + i} Pine St`, permitType: 'New', description: 'New commercial office building ' + i, issuedDate: D(-3), status: 'Issued', valuation: '500000' });
    ingestPermits(store, SEA, rows);
    const t = process.hrtime.bigint(); backfillCore(store); return Number(process.hrtime.bigint() - t) / 1e6;
  };
  time(500);                                   // warm up
  // Best of three per size: other test files run in parallel, so a single timing can be disturbed by CPU contention.
  const best = n => Math.min(time(n), time(n), time(n));
  const small = best(2000), big = best(8000);  // 4× the data
  assert.ok(big / small < 9, `4× data took ${(big / small).toFixed(1)}× as long (quadratic would be ~16×)`);
});
