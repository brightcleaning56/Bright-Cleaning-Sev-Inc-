import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { createRequest } from '../src/marketplace.js';
import { backfillCore, splitLinks, mergeProjects, linkBidRequestTo, pickProjects } from '../src/core.js';
import { searchProjects, projectDetail, trackProject, commandCenter, mapPoints, anchorPermitId } from '../src/leads.js';
import { compareReads } from '../src/parity.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const SEA = { id: 'sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'https://data.seattle.gov' };
const permit = (id, address, extra = {}) => ({ permitId: id, address, permitType: 'New', description: 'New commercial office building', issuedDate: D(-5), status: 'Issued', valuation: '1000000', lat: 47.6, lng: -122.33, ...extra });
const ON = { coreReads: 'on' }, OFF = { coreReads: 'off' };
const all = new URLSearchParams({ includeClosed: 'true' });
function world() {
  const store = new Store(null);
  ingestPermits(store, SEA, [permit('S1', '400 Pine St', { valuation: '48500000', contractor: 'Sellen Construction' }), permit('S2', '400 Pine Street', { description: 'TI floors 2-5', permitType: 'Addition/Alteration', valuation: '300000' }), permit('S3', '12 Mercer St', { valuation: '150000' })]);
  backfillCore(store);
  const org = store.put('orgs', { slug: 'sub', name: 'Emerald', kind: 'subscriber', trades: ['glazing'], territories: ['WA'], status: 'active', settings: {}, legal: { name: 'Emerald LLC' }, subscription: { plan: 'local', status: 'active' } });
  return { store, org };
}

test('switch off: unchanged (permit ids, address grouping); switch on: same projects, permanent ids, anchor permits', () => {
  const { store, org } = world();
  const off = searchProjects(store, org, all, { ...OFF, pageSize: 50, sort: 'value' });
  const on = searchProjects(store, org, all, { ...ON, pageSize: 50, sort: 'value' });
  assert.ok(off.results.every(r => !r.id.startsWith('BI-')));
  assert.ok(on.results.every(r => /^BI-/.test(r.id) && r.anchorPermitId));
  assert.deepEqual(on.results.map(r => [r.permitCount, r.combinedValue]), off.results.map(r => [r.permitCount, r.combinedValue]));
  assert.equal(compareReads(store, org).ok, true);
  assert.equal(compareReads(store, org).groups.identical, 2);
});

test('profile by project id: permits of the project (not just the address), core phases, anchor; old permit links still work', () => {
  const { store, org } = world();
  const pine = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S1')[0].id).projectId;
  const mercer = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S3')[0].id).projectId;
  mergeProjects(store, pine, mercer, 'admin');                         // e.g. one campus with two street addresses
  const d = projectDetail(store, org, pine).project;
  assert.equal(d.id, pine); assert.equal(d.sitePermits.length, 2);       // includes the Mercer St permit now
  assert.ok(d.projectPhases.length >= 1);
  assert.equal(projectDetail(store, org, mercer).project.id, pine);      // merged-away id still resolves
  const viaPermit = projectDetail(store, org, store.list('permits', p => p.permitId === 'S3')[0].id, ON).project;
  assert.equal(viaPermit.projectId, pine);                                // a permit link from an old alert email maps to the project
  const r = compareReads(store, org);
  assert.deepEqual([r.ok, r.groups.joined], [true, 1]);                   // parity reports the join, nothing lost
});

test('parity detects splits; still OK because no permit is lost', () => {
  const { store, org } = world();
  const pid = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S1')[0].id).projectId;
  splitLinks(store, pid, ['permit:' + store.list('permits', p => p.permitId === 'S2')[0].id], 'admin');
  const r = compareReads(store, org);
  assert.deepEqual([r.ok, r.groups.split, r.groups.before, r.groups.after], [true, 1, 2, 3]);
});

test('anchor permit is stable: a larger permit joining later does not move tracking or estimates', () => {
  const { store, org } = world();
  const pid = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S3')[0].id).projectId;
  const anchor = anchorPermitId(store, pid);
  assert.equal(trackProject(store, org, { email: 'a' }, pid, { stage: 'watching' }).ok, true);
  ingestPermits(store, SEA, [permit('S9', '12 Mercer Street', { valuation: '90000000', description: 'New 30-story office tower', permitType: 'New', issuedDate: D(-1) })]);
  backfillCore(store);
  assert.equal(anchorPermitId(store, pid), anchor);
  assert.equal(store.tlist('tracked', org.id)[0].permitId, anchor);
  assert.equal(searchProjects(store, org, all, ON).results.find(r => r.id === pid).permitCount, 2);
});

test('planning-only project: profile from the core record; following needs a permit (clear message)', () => {
  const { store, org } = world();
  store.put('signals', { id: 'lu:9', kind: 'land_use_application', state: 'WA', city: 'Seattle', address: '1501 4th Ave', title: 'Land use: 24-story office tower', url: 'https://seattle.gov/lu/9', sourceId: 'lu' });
  backfillCore(store);
  const pid = store.get('projectLinks', 'land_use:lu:9').projectId;
  const d = projectDetail(store, org, pid).project;
  assert.deepEqual([d.id, d.phase, d.anchorPermitId, d.sourceUrl], [pid, 'planning', null, 'https://seattle.gov/lu/9']);
  assert.match(trackProject(store, org, { email: 'a' }, pid).error, /once a building permit is linked/);
  const tex = store.put('orgs', { slug: 'tx', kind: 'subscriber', territories: ['TX'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  assert.equal(projectDetail(store, tex, pid).code, 404);                 // territory still enforced
});

test('map and command center count projects when on, sites when off', () => {
  const { store, org } = world();
  const pine = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S1')[0].id).projectId;
  const mercer = store.get('projectLinks', 'permit:' + store.list('permits', p => p.permitId === 'S3')[0].id).projectId;
  mergeProjects(store, pine, mercer, 'admin');
  assert.deepEqual([commandCenter(store, org, OFF).kpis.activeSites, commandCenter(store, org, ON).kpis.activeSites], [2, 1]);
  assert.deepEqual([mapPoints(store, org, new URLSearchParams(''), OFF).total, mapPoints(store, org, new URLSearchParams(''), ON).total], [2, 1]);
  assert.equal(mapPoints(store, org, new URLSearchParams(''), ON).points[0].id, pine);
});

test('GC picks the project: confirmed link even when the address differs; state and existence checked', async (t) => {
  const { store } = world();
  const pine = store.list('projects').find(p => /pine/i.test(p.address)).id;
  assert.equal(pickProjects(store, { state: 'WA', q: 'pin' }).length, 1);
  assert.equal(pickProjects(store, { state: 'WA', q: 'pi' }).length, 0);  // needs 3+ characters
  assert.equal(pickProjects(store, { state: 'TX', q: 'pine' }).length, 0);
  const gc = store.put('orgs', { slug: 'gc', name: 'Sellen Construction', kind: 'buyer', buyerKind: 'general_contractor', status: 'active', settings: {}, publisher: { status: 'verified' } });
  store.put('users', { email: 'pm@sellen.test', role: 'owner', orgId: gc.id, passwordHash: hashPassword('gc password 1234'), emailVerifiedAt: new Date().toISOString() });
  const srv = createServer(store).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tok = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pm@sellen.test', password: 'gc password 1234' }) })).json()).token;
  const post = b => fetch(base + '/api/requests', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ title: 'Building B curtain wall', address: '1600 7th Ave', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['glazing'], dueDate: D(12), ...b }) });
  const ok = await post({ projectId: pine }); const body = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(body)); assert.equal(body.projectId, pine);
  assert.deepEqual([store.get('projectLinks', 'bid_request:' + body.id).method, store.get('projectLinks', 'bid_request:' + body.id).confidence], ['chosen by GC', 'confirmed']);
  assert.equal((await post({ projectId: pine, state: 'TX' })).status, 400);  // project in another state
  assert.equal((await post({ projectId: 'BI-NOPE2345' })).status, 400);
  const other = createRequest(store, gc, { email: 'pm' }, { title: 'x', address: '1 Nowhere Rd', city: 'Austin', state: 'TX', projectType: 'office', trades: ['glazing'], dueDate: D(5) }).request;
  assert.match(linkBidRequestTo(store, other, pine).error, /different state/);
});

test('anchor order does not depend on the clock: links made in the same millisecond keep creation order', () => {
  const store = new Store(null);
  const realNow = Date.now; Date.now = () => 1790000000000;                  // freeze the clock: every timestamp identical
  try {
    for (let i = 0; i < 20; i++) {
      ingestPermits(store, SEA, [permit('F' + i, `${500 + i} Oak St`), permit('G' + i, `${500 + i} Oak Street`, { description: 'Later TI', permitType: 'Addition/Alteration', valuation: '99000000' })]);
    }
    backfillCore(store);
  } finally { Date.now = realNow; }
  for (let i = 0; i < 20; i++) {
    const first = store.list('permits', p => p.permitId === 'F' + i)[0].id;
    const pid = store.get('projectLinks', 'permit:' + first).projectId;
    assert.equal(anchorPermitId(store, pid), first, `project ${i}`);
  }
});
