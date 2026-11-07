import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { syncLicenses, syncLegistar, licenseFor } from '../src/enrichment.js';
import { projectDetail, contractors, contractorDetail, planningSignals, trackProject, collectAlerts, saveSearch } from '../src/leads.js';
import { sendLeadAlerts } from '../src/digest.js';

const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const SEA = { id: 'src_sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'https://data.seattle.gov' };
const LIC = { id: 'src_lni', key: 'wa-lni-licenses', state: 'WA', rateLimitPerMin: 1e6, adapterConfig: { domain: 'data.wa.gov', dataset: 'm8qx-ubtq', nameField: 'businessname',
  fields: { licenseNumber: 'contractorlicensenumber', businessName: 'businessname', status: 'statuscode', type: 'contractorlicensetypecodedesc', phone: 'phonenumber',
    address: 'address1', city: 'city', zip: 'zip', expiresAt: 'licenseexpirationdate', principal: 'primaryprincipalname', specialties: ['specialtycode1desc'] } } };

function world() {
  const store = new Store(null);
  ingestPermits(store, SEA, [
    { permitId: 'S1', address: '400 Pine St', permitType: 'New', description: 'New commercial office building', issuedDate: D(-10), status: 'Issued', valuation: '9000000', contractor: 'Sellen Construction Co Inc' },
    { permitId: 'S2', address: '900 Union St', permitType: 'Addition/Alteration', description: 'Tenant improvement, office', issuedDate: D(-5), status: 'Issued', valuation: '300000', contractor: 'Sellen Construction Co Inc' },
    { permitId: 'S3', address: '12 Mercer St', permitType: 'Addition/Alteration', description: 'Restaurant tenant finish', appliedDate: D(-3), status: 'In Review', valuation: '150000', contractor: 'Unknown Builders LLC' },
  ]);
  const org = store.put('orgs', { slug: 'sub', name: 'Emerald Glass', kind: 'subscriber', status: 'active', territories: ['WA'], settings: {}, subscription: { plan: 'local', status: 'active' } });
  return { store, org, user: { email: 'o@x.test', id: 'u' } };
}

test('license sync: looks up only names on permits, in one batched query, prefers the active license, records misses', async () => {
  const { store } = world();
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return { ok: true, json: async () => [
    { businessname: 'SELLEN CONSTRUCTION CO INC', contractorlicensenumber: 'SELLECC123AB', statuscode: 'EXPIRED', licenseexpirationdate: '2020-01-01' },
    { businessname: 'SELLEN CONSTRUCTION CO INC', contractorlicensenumber: 'SELLECC999ZZ', statuscode: 'ACTIVE', contractorlicensetypecodedesc: 'CONSTRUCTION CONTRACTOR', phonenumber: '2066821000', address1: '600 Westlake Ave', city: 'Seattle', zip: '98109', licenseexpirationdate: '2027-05-01', specialtycode1desc: 'GENERAL' },
  ] }; };
  const r = await syncLicenses(store, LIC, { fetchImpl });
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('$where'), "starts_with(upper(businessname), 'SELLEN CONSTRUCTION') OR starts_with(upper(businessname), 'UNKNOWN BUILDERS')");
  assert.deepEqual([r.looked, r.found, r.notFound], [2, 1, 1]);
  const l = licenseFor(store, 'WA', 'Sellen Construction Co. Inc');
  assert.equal(l.licenseNumber, 'SELLECC999ZZ'); assert.equal(l.active, true); assert.deepEqual(l.specialties, ['GENERAL']);
  assert.equal(licenseFor(store, 'WA', 'Unknown Builders LLC'), null);
  urls.length = 0; await syncLicenses(store, LIC, { fetchImpl }); assert.equal(urls.length, 0); // re-checked at most weekly
  await assert.rejects(syncLicenses(store, { ...LIC, adapterConfig: { ...LIC.adapterConfig, nameField: '' } }), /field map not set/);
});

test('license shows on project contacts and contractor pages; phone only with contact access', async () => {
  const { store, org } = world();
  await syncLicenses(store, LIC, { fetchImpl: async () => ({ ok: true, json: async () => [{ businessname: 'SELLEN CONSTRUCTION CO INC', contractorlicensenumber: 'L1', statuscode: 'ACTIVE', phonenumber: '2065550100' }] }) });
  const s1 = store.list('permits', p => p.permitId === 'S1')[0];
  const gc = projectDetail(store, org, s1.id).project.contacts.find(c => /General contractor/.test(c.role));
  assert.equal(gc.license.number, 'L1'); assert.equal(gc.license.active, true); assert.equal(gc.license.phone, '2065550100');
  const list = contractors(store, org, new URLSearchParams(''));
  const sellen = list.results.find(c => /Sellen/.test(c.name));
  assert.equal(sellen.permits, 2); assert.equal(sellen.sites, 2); assert.equal(sellen.reportedValue, 9300000); assert.equal(sellen.license.number, 'L1');
  assert.equal(list.results[0].name, 'Sellen Construction Co Inc'); // busiest first
  const d = contractorDetail(store, org, sellen.key);
  assert.equal(d.contractor.projects.length, 2); assert.equal(d.contractor.license.phone, '2065550100');
  org.territories = ['OR'];
  assert.equal(contractorDetail(store, org, sellen.key).code, 404); // territory gate
});

test('Legistar: keeps land-use items only, links to the official record', async () => {
  const store = new Store(null);
  const src = { id: 'leg', state: 'WA', city: 'Seattle', rateLimitPerMin: 1e6, adapterConfig: { client: 'seattle', daysBack: 120 } };
  let url;
  const r = await syncLegistar(store, src, { fetchImpl: async u => { url = u; return { ok: true, json: async () => [
    { MatterId: 1, MatterGuid: 'g1', MatterFile: 'CF 314500', MatterTypeName: 'Council Land Use Action', MatterTitle: 'Application to rezone 2.1 acres at 4500 Fauntleroy Way SW', MatterIntroDate: '2026-10-01T00:00:00' },
    { MatterId: 2, MatterGuid: 'g2', MatterFile: 'CB 121000', MatterTypeName: 'Council Bill (CB)', MatterTitle: 'Relating to the parks budget', MatterIntroDate: '2026-10-02T00:00:00' },
  ] }; } });
  assert.match(decodeURIComponent(url), /webapi\.legistar\.com\/v1\/seattle\/matters/);
  assert.deepEqual([r.received, r.landUse], [2, 1]);
  const sig = store.list('signals')[0];
  assert.equal(sig.url, 'https://seattle.legistar.com/LegislationDetail.aspx?ID=1&GUID=g1');
  const org = { id: 'o', kind: 'subscriber', status: 'active', territories: ['WA'], subscription: { plan: 'local', status: 'active' } };
  assert.equal(planningSignals(store, org, new URLSearchParams('q=rezone')).total, 1);
  assert.equal(planningSignals(store, { ...org, territories: ['TX'] }, new URLSearchParams('')).total, 0);
});

test('stage changes: alert wording shows from → to; tracked projects notify once per change', async () => {
  const { store, org, user } = world();
  store.put('users', { email: 'owner@emerald.test', role: 'owner', orgId: org.id });
  const s3 = store.list('permits', p => p.permitId === 'S3')[0];
  await new Promise(r => setTimeout(r, 5));
  saveSearch(store, org, user, { name: 'all WA', filters: { state: 'WA' } });
  trackProject(store, org, user, s3.id, { stage: 'bidding' });
  const t = store.tlist('tracked', org.id)[0]; t.createdAt = new Date(Date.now() - 60e3).toISOString(); store.tput('tracked', org.id, t);
  await new Promise(r => setTimeout(r, 5));
  ingestPermits(store, SEA, [{ permitId: 'S3', address: '12 Mercer St', permitType: 'Addition/Alteration', description: 'Restaurant tenant finish', appliedDate: D(-3), issuedDate: D(0), status: 'Issued', valuation: '150000', contractor: 'Unknown Builders LLC' }]);
  const hit = collectAlerts(store, org)[0].hits.find(h => h.permitId === 'S3');
  assert.equal(hit.why, 'stage changed: applied → issued');
  config.emailMode = 'dry-run'; config.platformFrom = 'alerts@buildintel.test';
  const first = await sendLeadAlerts(store, { force: true });
  assert.ok(first.some(x => x.stageChanges === 1));
  assert.match(store.list('messages', m => m.kind === 'stage_alert')[0].preview, /applied → issued \(you marked it "bidding"\)/);
  const second = await sendLeadAlerts(store, { force: true });
  assert.ok(!second.some(x => x.stageChanges));
  config.platformFrom = '';
});

test('freshness: every result carries when it was last checked against the city record', () => {
  const { store, org } = world();
  const r = projectDetail(store, org, store.list('permits')[0].id).project;
  assert.ok(Date.parse(r.lastVerifiedAt) > Date.now() - 60e3); assert.ok('sourceLastSync' in r);
});

test('license matching: short names, punctuation and suffixes match; two different active companies do not; blanket permits ignored', async () => {
  const store = new Store(null);
  ingestPermits(store, SEA, [
    { permitId: 'M1', address: '1 A St', permitType: 'Addition/Alteration', description: 'Commercial reroof', issuedDate: D(-2), status: 'Issued', valuation: '50000', contractor: 'Centimark' },
    { permitId: 'M2', address: '2 A St', permitType: 'Addition/Alteration', description: 'Office tenant improvement', issuedDate: D(-2), status: 'Issued', valuation: '90000', contractor: 'Scott Wall Construction, Inc.' },
    { permitId: 'M3', address: '3 A St', permitType: 'Addition/Alteration', description: 'Office tenant improvement', issuedDate: D(-2), status: 'Issued', valuation: '90000', contractor: 'Pacific' },
    { permitId: 'M4', address: '4 A St', permitType: 'Addition/Alteration', description: 'Office tenant improvement', issuedDate: D(-2), status: 'Issued', valuation: '90000', contractor: 'BLANKET: WELLS FARGO BUILDING' },
  ]);
  assert.equal(store.list('permits', p => p.permitId === 'M4')[0].contractorOnPermit, null);
  let where;
  const rows = [
    { businessname: 'CENTIMARK CORPORATION', contractorlicensenumber: 'CENTIC*123', statuscode: 'ACTIVE' },
    { businessname: 'SCOTT WALL CONSTRUCTION INC', contractorlicensenumber: 'SCOTTWC1', statuscode: 'ACTIVE' },
    { businessname: 'PACIFIC INC', contractorlicensenumber: 'PACIFI1', statuscode: 'ACTIVE' },
    { businessname: 'PACIFIC LLC', contractorlicensenumber: 'PACIFI2', statuscode: 'ACTIVE' },
  ];
  const r = await syncLicenses(store, LIC, { fetchImpl: async u => { where = new URL(u).searchParams.get('$where'); return { ok: true, json: async () => rows }; } });
  assert.ok(where.includes("starts_with(upper(businessname), 'CENTIMARK')") && where.includes("'SCOTT WALL CONSTRUCTION'"));
  assert.ok(!where.includes('BLANKET'));
  assert.equal(licenseFor(store, 'WA', 'Centimark').licenseNumber, 'CENTIC*123');
  assert.equal(licenseFor(store, 'WA', 'Scott Wall Construction, Inc.').licenseNumber, 'SCOTTWC1');
  assert.equal(licenseFor(store, 'WA', 'Pacific'), null); // two different active companies: no guess
  assert.equal(r.found, 2);
});

test('pulls: one at a time; run-now answers immediately; a stuck pull is overridden by the watchdog', async () => {
  const { runCycleGuarded, cycleStatus } = await import('../src/autopilot.js');
  const store = new Store(null);
  let release; const gate = new Promise(r => { release = r; });
  const slowFetch = async () => { await gate; return { ok: true, json: async () => [] }; };
  const src = store.put('sources', { key: 'slow', adapter: 'socrata', enabled: true, method: 'api', name: 'n', agency: 'a', url: 'u', termsUrl: 't',
    adapterConfig: { domain: 'd', dataset: 'x', dateField: 'issue_date', fields: { permitId: 'id' } },
    authorization: { commercialReuse: true, redistribution: true, reviewedBy: 'r', reviewedAt: 'd', evidence: 'e' }, rateLimitPerMin: 1e6 });
  const first = runCycleGuarded(store, { fetchImpl: slowFetch });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(cycleStatus().running, true);
  assert.match((await runCycleGuarded(store, { fetchImpl: slowFetch })).skipped, /already running/);
  release(); await first;
  assert.equal(cycleStatus().running, false);
  // watchdog: a pull marked as running for longer than the limit no longer blocks
  let release2; const gate2 = new Promise(r => { release2 = r; });
  const stuck = runCycleGuarded(store, { fetchImpl: async () => { await gate2; return { ok: true, json: async () => [] }; } });
  await new Promise(r => setTimeout(r, 10));
  const forced = await runCycleGuarded(store, { fetchImpl: async () => ({ ok: true, json: async () => [] }) }, { maxMinutes: 0 });
  assert.ok(!forced.skipped);
  release2(); await stuck;
});

test('council filter: real Seattle appointments and citywide code changes are excluded; site-specific items kept; stale items removed', async () => {
  const { isSiteSpecificLandUse } = await import('../src/enrichment.js');
  assert.equal(isSiteSpecificLandUse('Appointment (Appt) Appointment of Sarah E. Champ as member, Design Review Board, for a term to August 31, 2027.'), false);
  assert.equal(isSiteSpecificLandUse('Ordinance (Ord) An ordinance relating to land use and zoning; adjusting the definition of recreational vehicle'), false);
  assert.equal(isSiteSpecificLandUse('Council Bill (CB) An ordinance relating to land use and zoning; amending Sections 23.47A.004 and 23.50.012'), false);
  assert.equal(isSiteSpecificLandUse('Council Land Use Action: Application to rezone 2.1 acres at 4500 Fauntleroy Way SW from NC2-40 to NC3-75'), true);
  assert.equal(isSiteSpecificLandUse('Petition for street vacation of the alley in Block 12, Denny Triangle'), true);
  const store = new Store(null);
  const src = { id: 'leg', state: 'WA', city: 'Seattle', rateLimitPerMin: 1e6, adapterConfig: { client: 'seattle' } };
  store.put('signals', { id: 'seattle:99', sourceId: 'leg', state: 'WA', title: 'Appointment of X, Design Review Board' });
  const r = await syncLegistar(store, src, { fetchImpl: async () => ({ ok: true, json: async () => [
    { MatterId: 1, MatterGuid: 'g', MatterTypeName: 'Clerk File (CF)', MatterTitle: 'Application of Acme LLC to rezone property located at 1200 Rainier Ave S', MatterIntroDate: '2026-10-01' },
  ] }) });
  assert.deepEqual([r.landUse, r.removed], [1, 1]);
  assert.deepEqual(store.list('signals').map(s => s.id), ['seattle:1']);
});

test('land-use applications feed: rolling window, address required, links to the record', async () => {
  const { syncLandUseSignals } = await import('../src/enrichment.js');
  const store = new Store(null);
  const src = { id: 'lu', key: 'seattle-land-use', state: 'WA', city: 'Seattle', rateLimitPerMin: 1e6, adapterConfig: { domain: 'data.seattle.gov', dataset: 'ht3q-kdvx', windowDays: 180,
    windowFields: ['applieddate'], fields: { id: 'permitnum', address: 'originaladdress1', description: 'description', type: 'permittypedesc', status: 'statuscurrent', appliedDate: 'applieddate', link: 'link' } } };
  let url;
  const r = await syncLandUseSignals(store, src, { fetchImpl: async u => { url = u; return { ok: true, json: async () => [
    { permitnum: '3041234-LU', originaladdress1: '1501 4TH AVE', description: 'Land Use Application to allow a 24-story office building with ground-level retail', permittypedesc: 'Full Design Review', statuscurrent: 'Reviews In Process', applieddate: '2026-09-15T00:00:00.000', link: { url: 'https://services.seattle.gov/portal/customization/user/PermitDetails?id=3041234-LU' } },
    { permitnum: '3041299-LU', description: 'No address', applieddate: '2026-09-20' },
  ] }; } });
  assert.match(new URL(url).searchParams.get('$where'), /^\(applieddate > '\d{4}-\d\d-\d\dT[\d:]{8}'\)$/);
  assert.deepEqual([r.received, r.kept], [2, 1]);
  const s = store.list('signals')[0];
  assert.equal(s.address, '1501 4TH AVE'); assert.equal(s.kind, 'land_use_application'); assert.match(s.url, /PermitDetails/);
  await assert.rejects(syncLandUseSignals(store, { ...src, adapterConfig: { ...src.adapterConfig, fields: {} } }), /field map not set/);
});

test('attribution: Chicago carries its required disclaimer; only enabled sources are listed publicly', async () => {
  const { seedSources, CHICAGO_DISCLAIMER } = await import('../src/sources/registry.js');
  const store = new Store(null); seedSources(store);
  const chi = store.list('sources', s => s.key === 'chicago-il')[0];
  assert.equal(chi.attribution, CHICAGO_DISCLAIMER);
  assert.match(chi.attribution, /^This site provides applications using data that has been modified for use from its original source, www\.cityofchicago\.org/);
  assert.match(chi.notes, /indemnity/);
  const { createServer } = await import('../src/server.js');
  const srv = createServer(store).listen(0); await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await (await fetch(base + '/api/attributions')).json()).length, 0);
  chi.enabled = true; store.put('sources', chi);
  const a = await (await fetch(base + '/api/attributions')).json();
  assert.equal(a[0].disclaimer, CHICAGO_DISCLAIMER);
  srv.close();
});
