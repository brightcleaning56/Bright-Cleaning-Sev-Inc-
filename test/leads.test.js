import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { leadAccess } from '../src/billing.js';
import { timeline, stageOf, searchProjects, projectDetail, saveSearch, collectAlerts, exportCsv, trackProject } from '../src/leads.js';
import { sendLeadAlerts } from '../src/digest.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { normName } from '../src/domain.js';
import { seedSources } from '../src/sources/registry.js';

const DAYS = d => new Date(Date.now() + d * 864e5).toISOString();
const SRC = (state, city) => ({ id: 'src_' + state, jurisdiction: city.toLowerCase(), city, state, url: 'https://data.example.gov' });

function leadWorld() {
  const store = new Store(null);
  ingestPermits(store, SRC('IA', 'Ankeny'), [
    { permitId: 'A-1', address: '100 SW Oralabor Rd', permitType: 'Commercial New', description: 'New medical office building', issuedDate: DAYS(-20).slice(0, 10), status: 'Issued', valuation: '6,500,000', squareFeet: '32000', contractor: 'Ryan Companies US Inc' },
    { permitId: 'A-2', address: '2 N Ankeny Blvd', permitType: 'Commercial Alteration', description: 'Retail tenant finish', appliedDate: DAYS(-3).slice(0, 10), status: 'In Review', valuation: '180000' },
  ]);
  ingestPermits(store, SRC('TX', 'Austin'), [
    { permitId: 'T-1', address: '500 Congress Ave', permitType: 'Commercial New', description: 'New office tower', issuedDate: DAYS(-60).slice(0, 10), status: 'Issued', valuation: '48000000', squareFeet: '410000', contractor: 'Hensel Phelps' },
  ]);
  const org = store.put('orgs', { slug: 'sub', name: 'Midwest Electric', kind: 'subscriber', status: 'active', territories: ['IA'], settings: {},
    subscription: { plan: 'trial', status: 'trialing', trialEndsAt: DAYS(10) } });
  const user = { email: 'owner@midwest.test', id: 'u1' };
  const co = store.put('companies', { name: 'Ryan Companies', normName: normName('Ryan Companies US Inc'), website: 'https://ryan.test' });
  store.put('contacts', { companyId: co.id, name: 'Iowa Estimating', role: 'Estimating', email: 'bids-ia@ryan.test', status: 'source_confirmed', evidenceUrl: 'https://ryan.test/subs' });
  return { store, org, user };
}

test('plans: trial works until it ends; territory list limited by plan; national sees every state', () => {
  const { org } = leadWorld();
  assert.deepEqual(leadAccess(org).states, ['IA']);
  assert.equal(leadAccess({ ...org, subscription: { plan: 'trial', status: 'trialing', trialEndsAt: DAYS(-1) } }).ok, false);
  assert.equal(leadAccess({ ...org, territories: ['IA', 'TX', 'NE', 'MO'], subscription: { plan: 'regional', status: 'active' } }).states.length, 3);
  assert.equal(leadAccess({ ...org, subscription: { plan: 'national', status: 'active' } }).states.length, 51);
  assert.equal(leadAccess({ ...org, subscription: { plan: 'local', status: 'past_due' } }).ok, false);
});

test('stage tracking: status changes are recorded with timestamps', () => {
  const { store } = leadWorld();
  ingestPermits(store, SRC('IA', 'Ankeny'), [{ permitId: 'A-2', address: '2 N Ankeny Blvd', permitType: 'Commercial Alteration', description: 'Retail tenant finish', appliedDate: DAYS(-3).slice(0, 10), issuedDate: DAYS(0).slice(0, 10), status: 'Issued', valuation: '180000' }]);
  const p = store.list('permits', x => x.permitId === 'A-2')[0];
  assert.deepEqual(p.statusHistory.map(h => h.status), ['applied', 'issued']);
});

test('timeline: labeled estimate, larger jobs run longer, final cleaning comes last', () => {
  const small = timeline({ permitDate: '2026-01-01', status: 'issued', valuation: 150000, projectType: 'retail' });
  const big = timeline({ permitDate: '2026-01-01', status: 'issued', valuation: 30e6, projectType: 'office' });
  assert.equal(small.basis, 'estimate');
  assert.ok(big.durationMonths > small.durationMonths);
  const clean = big.trades.find(t => /cleaning/.test(t.trade));
  assert.ok(big.trades.filter(t => !/janitorial/.test(t.trade)).every(t => t.from <= clean.from));
  assert.equal(timeline({ status: 'issued' }), null); // no date, no made-up timeline
});

test('search: territory gate, filters, sorting; nothing outside paid states leaks', () => {
  const { store, org } = leadWorld();
  const all = searchProjects(store, org, new URLSearchParams(''));
  assert.deepEqual(all.results.map(r => r.permitId).sort(), ['A-1', 'A-2']); // Austin hidden: not in territory
  assert.equal(searchProjects(store, org, new URLSearchParams('state=TX')).total, 0);
  assert.deepEqual(searchProjects(store, org, new URLSearchParams('minValue=1000000')).results.map(r => r.permitId), ['A-1']);
  assert.deepEqual(searchProjects(store, org, new URLSearchParams('q=medical office')).results.map(r => r.permitId), ['A-1']);
  assert.deepEqual(searchProjects(store, org, new URLSearchParams('stage=applied')).results.map(r => r.permitId), ['A-2']);
  assert.equal(searchProjects(store, org, new URLSearchParams('hasContact=true')).total, 1);
  org.subscription = { plan: 'national', status: 'active' };
  assert.equal(searchProjects(store, org, new URLSearchParams(''), { sort: 'value' }).results[0].permitId, 'T-1');
});

test('project detail: verified contacts with evidence, suppressed people hidden, other territories 404', () => {
  const { store, org } = leadWorld();
  const a1 = store.list('permits', p => p.permitId === 'A-1')[0];
  const d = projectDetail(store, org, a1.id);
  assert.equal(d.ok, true);
  const gc = d.project.contacts.find(c => /General contractor/.test(c.role));
  assert.equal(gc.people[0].email, 'bids-ia@ryan.test'); assert.equal(gc.people[0].verified, true);
  assert.match(d.project.contractorNote, /not always the awarded/);
  assert.equal(stageOf(a1), 'under_construction');
  store.suppressEverywhere('bids-ia@ryan.test', 'x', 'y');
  assert.equal(projectDetail(store, org, a1.id).project.contacts[0].people.length, 0);
  const t1 = store.list('permits', p => p.permitId === 'T-1')[0];
  assert.equal(projectDetail(store, org, t1.id).code, 404);
});

test('saved searches: plan limit, alerts only for new or changed projects, one email per day', async () => {
  const { store, org, user } = leadWorld();
  for (let i = 0; i < 3; i++) assert.equal(saveSearch(store, org, user, { name: 's' + i, filters: { state: 'IA' } }).ok, true);
  assert.match(saveSearch(store, org, user, { name: 'too many', filters: {} }).error, /3 saved searches/);
  assert.equal(collectAlerts(store, org)[0].hits.length, 0); // nothing new since saving
  await new Promise(r => setTimeout(r, 5));
  ingestPermits(store, SRC('IA', 'Ankeny'), [{ permitId: 'A-3', address: '9 E 1st St', permitType: 'Commercial New', description: 'New warehouse', issuedDate: DAYS(0).slice(0, 10), status: 'Issued', valuation: '2100000' }]);
  const hits = collectAlerts(store, org)[0].hits;
  assert.deepEqual(hits.map(h => [h.permitId, h.why]), [['A-3', 'new']]);
  config.emailMode = 'dry-run'; config.platformFrom = 'alerts@buildintel.test';
  for (const s of store.tlist('savedSearches', org.id)) { s.lastRunAt = DAYS(-2); store.tput('savedSearches', org.id, s); }
  const sent = await sendLeadAlerts(store);
  assert.equal(sent.length, 3); assert.ok(sent.every(x => x.hits >= 1));
  assert.match(store.list('messages', m => m.kind === 'lead_alert')[0].preview, /New warehouse/);
  assert.equal((await sendLeadAlerts(store)).length, 0); // already ran today
  config.platformFrom = '';
});

test('export: blocked on trial, limited and correctly escaped on paid plans', () => {
  const { store, org } = leadWorld();
  assert.equal(exportCsv(store, org, new URLSearchParams('')).code, 402);
  org.subscription = { plan: 'local', status: 'active' };
  const r = exportCsv(store, org, new URLSearchParams(''));
  assert.equal(r.rows, 2); assert.match(r.csv.split('\n')[0], /^permitId,title,address/);
  org.exportUsage = { [new Date().toISOString().slice(0, 7)]: 499 };
  const r2 = exportCsv(store, org, new URLSearchParams(''));
  assert.equal(r2.rows, 1); assert.equal(r2.truncated, true);
});

test('tracking: stage + notes, only for projects in territory', () => {
  const { store, org, user } = leadWorld();
  const a1 = store.list('permits', p => p.permitId === 'A-1')[0];
  assert.equal(trackProject(store, org, user, a1.id, { stage: 'contacted', note: 'Called Ryan estimating' }).ok, true);
  assert.equal(searchProjects(store, org, new URLSearchParams('q=medical')).results[0].tracked, 'contacted');
  const t1 = store.list('permits', p => p.permitId === 'T-1')[0];
  assert.equal(trackProject(store, org, user, t1.id, {}).ok, false);
});

test('HTTP: subscriber signup → verify → search; buyers and unverified accounts blocked; probe flags bad field maps', async (t) => {
  const { store } = leadWorld();
  seedSources(store);
  const austin = store.list('sources', s => s.key === 'austin-tx')[0];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ rowsUpdatedAt: 1793500000, columns: ['permit_number', 'issue_date', 'original_address1', 'description'].map(fieldName => ({ fieldName })) }) });
  const srv = createServer(store, { fetchImpl }).listen(0); await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) }); const tx = await r.text(); try { return { status: r.status, body: JSON.parse(tx) }; } catch { return { status: r.status, body: tx, headers: r.headers }; } };
  assert.equal((await call('POST', '/api/signup/subscriber', { company: 'Prairie Roofing', segment: 'subcontractor', trades: ['roofing'], name: 'Jo', email: 'jo@prairie.test', password: 'long enough password', state: 'ZZ' })).status, 400);
  assert.equal((await call('POST', '/api/signup/subscriber', { company: 'Prairie Roofing', segment: 'subcontractor', trades: ['roofing'], name: 'Jo', email: 'jo@prairie.test', password: 'long enough password', state: 'IA' })).status, 200);
  const tok = (await call('POST', '/api/login', { email: 'jo@prairie.test', password: 'long enough password' })).body.token;
  assert.equal((await call('GET', '/api/projects', undefined, tok)).status, 403); // must confirm email first
  const link = store.list('messages', m => m.kind === 'verification').pop().link;
  await fetch(link.replace(config.baseUrl, base), { method: 'POST' }); // the confirmation button posts
  const res = await call('GET', '/api/projects?city=ankeny', undefined, tok);
  assert.equal(res.status, 200); assert.equal(res.body.total, 2);
  const detail = await call('GET', '/api/projects/' + res.body.results.find(r => r.permitId === 'A-1').id, undefined, tok);
  assert.ok(detail.body.timeline.trades.length > 5);
  assert.equal((await call('PATCH', '/api/territories', { states: ['IA', 'TX'] }, tok)).status, 400); // trial = 1 state
  assert.equal((await call('POST', '/api/searches', { name: 'Ankeny new builds', filters: { city: 'ankeny', stage: 'issued' } }, tok)).status, 200);
  assert.equal((await call('GET', '/api/projects/export', undefined, tok)).status, 402);

  const buyer = store.put('orgs', { slug: 'b', name: 'GC', kind: 'buyer', status: 'active', settings: {} });
  store.put('users', { email: 'gc@x.test', role: 'owner', orgId: buyer.id, passwordHash: hashPassword('buyer password 12') });
  const btok = (await call('POST', '/api/login', { email: 'gc@x.test', password: 'buyer password 12' })).body.token;
  assert.equal((await call('GET', '/api/projects', undefined, btok)).status, 403);

  store.put('users', { email: 'eric@x.test', role: 'platform_owner', orgId: buyer.id, passwordHash: hashPassword('platform owner pw') });
  const ptok = (await call('POST', '/api/login', { email: 'eric@x.test', password: 'platform owner pw' })).body.token;
  const probe = await call('POST', `/api/sources/${austin.id}/probe`, {}, ptok);
  assert.ok(probe.body.columns.includes('permit_number'));
  assert.ok(probe.body.mappedFieldsMissing.some(m => m.startsWith('contractor')));
});

test('timeline: interior jobs skip site work and structure; new builds keep them', () => {
  const ti = timeline({ permitDate: '2026-01-01', status: 'issued', valuation: 900000, permitType: 'Commercial Alteration', description: 'Retail tenant finish' });
  assert.equal(ti.scope, 'interior'); assert.ok(!ti.trades.some(t => /Site work|Structure/.test(t.trade)));
  const tn = timeline({ permitDate: '2026-01-01', status: 'issued', valuation: 9e6, permitType: 'Commercial New', description: 'New office building' });
  assert.equal(tn.scope, 'new construction'); assert.ok(tn.trades.some(t => /Site work/.test(t.trade)));
});

test('Chicago-style contacts: roles picked by type, never by position', async () => {
  const { contactRoles } = await import('../src/sources/adapters.js');
  const slots = { prefix: 'contact_', count: 15, typeSuffix: '_type', nameSuffix: '_name', roles: { contractor: 'GENERAL CONTRACTOR', owner: 'OWNER', architect: 'ARCHITECT' } };
  assert.deepEqual(contactRoles({ contact_1_type: 'OWNER AS GENERAL CONTRACTOR', contact_1_name: 'X', contact_2_type: 'ARCHITECT', contact_2_name: 'Studio A',
    contact_3_type: 'CONTRACTOR-GENERAL CONTRACTOR', contact_3_name: 'Pepper Construction' }, slots).architect, 'Studio A');
  const r = contactRoles({ contact_1_type: 'OWNER', contact_1_name: 'Fulton LLC', contact_2_type: 'CONTRACTOR-GENERAL CONTRACTOR', contact_2_name: 'Pepper Construction' }, slots);
  assert.equal(r.contractor, 'Pepper Construction'); assert.equal(r.owner, 'Fulton LLC');
});

test('probe reads the official schema, license and freshness; array fields checked per column', async () => {
  const { probeSocrata } = await import('../src/sources/adapters.js');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ rowsUpdatedAt: 1793500000, license: { name: 'Public Domain' }, columns: ['permit_', 'street_number', 'street_name', 'contact_1_type', 'contact_1_name'].map(fieldName => ({ fieldName })) }) });
  const r = await probeSocrata({ domain: 'x', dataset: 'y', fields: { permitId: 'permit_', address: ['street_number', 'street_direction', 'street_name'] },
    contactSlots: { prefix: 'contact_', typeSuffix: '_type', nameSuffix: '_name' } }, { fetchImpl });
  assert.deepEqual(r.mappedFieldsMissing, ['address -> street_direction']);
  assert.equal(r.license, 'Public Domain'); assert.ok(r.lastUpdated.startsWith('2026'));
});

test('catalog corrections reach disabled sources only; live sources are left alone', () => {
  const s = new Store(null); seedSources(s);
  const chi = s.list('sources', x => x.key === 'chicago-il')[0];
  chi.adapterConfig.fields.contractor = 'contact_1_name'; s.put('sources', chi);
  seedSources(s);
  assert.equal(s.get('sources', chi.id).adapterConfig.fields.contractor, undefined);
  const live = s.get('sources', chi.id); live.enabled = true; live.adapterConfig.custom = 1; s.put('sources', live);
  seedSources(s);
  assert.equal(s.get('sources', chi.id).adapterConfig.custom, 1);
});

test('ArcGIS adapter: commercial filter at the source, epoch dates converted, per-record source link, incremental since', async () => {
  const { arcgis, probeArcgis } = await import('../src/sources/adapters.js');
  const calls = [];
  const fetchImpl = async url => { calls.push(url);
    if (url.includes('/query?')) return { ok: true, json: async () => ({ features: [{ attributes: { PermitNumber: 'BLD-2026-1', PermitType: 'Commercial', WorkType: 'New Building', Status: 'Issued', Value: 4200000, IssueDate: Date.UTC(2026, 9, 20), Display: '250 Marquette Ave', ApplicantName: 'Mortenson', Latitude: 44.97, Longitude: -93.26 } }] }) };
    return { ok: true, json: async () => ({ fields: ['PermitNumber', 'PermitType', 'WorkType', 'Status', 'Value', 'IssueDate', 'Display', 'ApplicantName'].map(name => ({ name })), editingInfo: { lastEditDate: Date.UTC(2026, 10, 1) } }) };
  };
  const src = { id: 'mpls', rateLimitPerMin: 100000, adapterConfig: { serviceUrl: 'https://svc/CCS_Permits/FeatureServer', layer: 0, where: "PermitType = 'Commercial'", dateField: 'IssueDate',
    fields: { permitId: 'PermitNumber', permitType: 'PermitType', status: 'Status', valuation: 'Value', issuedDate: 'IssueDate', address: 'Display', contractor: 'ApplicantName', description: 'WorkType' } } };
  const rows = await arcgis(src, { since: '2026-10-01T00:00:00Z', fetchImpl });
  assert.equal(rows[0].issuedDate, '2026-10-20T00:00:00.000Z');
  assert.equal(rows[0].contractor, 'Mortenson');
  assert.equal(new URL(calls[0]).searchParams.get('where'), "PermitType = 'Commercial' AND IssueDate > DATE '2026-10-01'");
  assert.match(decodeURIComponent(rows[0].sourceUrl), /PermitNumber='BLD-2026-1'/);
  const pr = await probeArcgis(src.adapterConfig, { fetchImpl });
  assert.deepEqual(pr.mappedFieldsMissing, []); assert.ok(pr.lastUpdated.startsWith('2026-11-01'));
});

test('sources with no field map can never be switched on', async () => {
  const { canCollect } = await import('../src/sources/registry.js');
  const s = new Store(null); seedSources(s);
  const sp = s.list('sources', x => x.key === 'saint-paul-mn')[0];
  Object.assign(sp, { enabled: true, authorization: { commercialReuse: true, redistribution: true, reviewedBy: 'x', reviewedAt: 'y', evidence: 'z' } });
  assert.equal(canCollect(sp), false);
});

test('internal company plan sees every state (regression: plan limit overwrote the state list)', () => {
  const { store, org } = leadWorld();
  org.subscription = { plan: 'internal', status: 'active' };
  const a = leadAccess(org);
  assert.ok(Array.isArray(a.states)); assert.equal(a.states.length, 51);
  assert.equal(searchProjects(store, org, new URLSearchParams('')).total, 3);
  for (const plan of ['trial', 'local', 'regional', 'national'])
    assert.ok(Array.isArray(leadAccess({ ...org, territories: ['IA'], subscription: { plan, status: 'active', trialEndsAt: DAYS(5) } }).states), plan);
});

test('occupancy classification: code groups case-sensitive, words case-insensitive, single-family excluded', async () => {
  const { classifyOccupancy, normalizePermit } = await import('../src/permits.js');
  assert.equal(classifyOccupancy('B - Business'), 'office');
  assert.equal(classifyOccupancy('Mercantile'), 'retail');
  assert.equal(classifyOccupancy('S-1 Moderate-hazard storage'), 'warehouse');
  assert.equal(classifyOccupancy('Multifamily'), 'multifamily');
  assert.equal(classifyOccupancy('Plan b revision'), null); // lowercase "b" is not the Business group
  assert.equal(classifyOccupancy('Commercial'), null);      // too generic: fall back to description
  const src = { id: 's', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'u' };
  assert.equal(normalizePermit({ permitId: 'X', address: 'a', permitType: 'Building', description: 'new building', occupancy: 'Single Family/Duplex' }, src).commercial, false);
  assert.equal(normalizePermit({ permitId: 'Y', address: 'a', permitType: 'Building', description: 'tenant improvement', occupancy: 'Industrial' }, src).projectType, 'industrial');
});

test('default search hides completed/expired; includeClosed or an explicit stage shows them; detail always opens', () => {
  const { store, org } = leadWorld();
  ingestPermits(store, SRC('IA', 'Ankeny'), [{ permitId: 'A-9', address: '9 Done St', permitType: 'Commercial New', description: 'New office', issuedDate: DAYS(-400).slice(0, 10), status: 'Final', valuation: '1000000' }]);
  const done = store.list('permits', p => p.permitId === 'A-9')[0];
  assert.ok(!searchProjects(store, org, new URLSearchParams('')).results.some(r => r.permitId === 'A-9'));
  assert.ok(searchProjects(store, org, new URLSearchParams('includeClosed=true')).results.some(r => r.permitId === 'A-9'));
  assert.ok(searchProjects(store, org, new URLSearchParams('stage=finaled')).results.some(r => r.permitId === 'A-9'));
  assert.equal(projectDetail(store, org, done.id).ok, true);
});

test('Socrata sync: oldest change first, pages forward, source filter applied, backfill window on first run', async () => {
  const { socrata } = await import('../src/sources/adapters.js');
  const urls = [];
  const page = n => Array.from({ length: n }, (_, i) => ({ ':updated_at': `2026-11-02T03:${String(i % 60).padStart(2, '0')}:00.000Z`, permitnum: 'P' + i, applieddate: '2026-11-01', originaladdress1: i + ' Pine St' }));
  const fetchImpl = async u => { urls.push(u); return { ok: true, json: async () => (urls.length === 1 ? page(1000) : page(7)) }; };
  const src = { id: 'sea', rateLimitPerMin: 1e6, adapterConfig: { domain: 'data.seattle.gov', dataset: 'x', dateField: 'issueddate', where: "permitclassmapped = 'Commercial'", fields: { permitId: 'permitnum', appliedDate: 'applieddate', address: 'originaladdress1' } } };
  const rows = await socrata(src, { since: '2026-11-01T00:00:00.000Z', fetchImpl });
  assert.equal(rows.length, 1007); assert.equal(urls.length, 2);
  const q = new URL(urls[1]).searchParams;
  assert.equal(q.get('$select'), ':*,*'); assert.equal(q.get('$order'), ':updated_at ASC, :id ASC'); assert.equal(q.get('$offset'), '1000');
  assert.equal(q.get('$where'), ":updated_at > '2026-11-01T00:00:00.000' AND permitclassmapped = 'Commercial'");
  urls.length = 0; await socrata(src, { fetchImpl: async u => { urls.push(u); return { ok: true, json: async () => [] }; } });
  const first = new URL(urls[0]).searchParams.get('$where').match(/'([^']+)'/)[1];
  assert.ok(Math.abs(Date.parse(first) - (Date.now() - 120 * 864e5)) < 864e5); // ~120-day backfill
});

test('value/sqft take the first filled column; zeros skipped', async () => {
  const { socrata } = await import('../src/sources/adapters.js');
  const src = { id: 'aus', rateLimitPerMin: 1e6, adapterConfig: { domain: 'd', dataset: 'x', dateField: 'issue_date',
    fields: { permitId: 'permit_number', address: 'a', valuation: { any: ['total_job_valuation', 'building_valuation_remodel'] }, squareFeet: { any: ['total_new_add_sqft', 'remodel_repair_sqft'] } } } };
  const rows = await socrata(src, { fetchImpl: async () => ({ ok: true, json: async () => [{ permit_number: '1', a: 'x', total_job_valuation: '0', building_valuation_remodel: '250000', remodel_repair_sqft: '4200' }] }) });
  assert.equal(rows[0].valuation, '250000'); assert.equal(rows[0].squareFeet, '4200');
});

test('houses are filtered by Seattle wording, and stored records that turn out residential are downgraded', () => {
  const s = new Store(null); const src = { id: 'sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'u' };
  ingestPermits(s, src, [{ permitId: 'H1', address: '1 Elm', permitType: 'Addition/Alteration', description: 'Construct interior alterations to commercial office', issuedDate: '2026-10-01' }]);
  assert.equal(s.list('permits')[0].commercial, true);
  const r = ingestPermits(s, src, [{ permitId: 'H1', address: '1 Elm', permitType: 'Addition/Alteration', description: 'Construct alterations to existing one family residence', issuedDate: '2026-10-01' }]);
  assert.equal(r.downgraded, 1); assert.equal(s.list('permits')[0].commercial, false);
  ingestPermits(s, src, [{ permitId: 'H2', address: '2 Elm', permitType: 'New', description: 'Allow housing for one new detached dwelling unit', issuedDate: '2026-10-01' }]);
  assert.equal(s.list('permits', p => p.permitId === 'H2').length, 0);
});

test('resync archives a source\'s records (hidden from search) and they come back if re-pulled', async () => {
  const { store, org } = leadWorld();
  org.subscription = { plan: 'national', status: 'active' };
  const before = searchProjects(store, org, new URLSearchParams('state=IA')).total;
  for (const p of store.list('permits', p => p.sourceId === 'src_IA')) { p.archived = true; store.put('permits', p); }
  assert.equal(searchProjects(store, org, new URLSearchParams('state=IA')).total, 0);
  ingestPermits(store, SRC('IA', 'Ankeny'), [{ permitId: 'A-1', address: '100 SW Oralabor Rd', permitType: 'Commercial New', description: 'New medical office building', issuedDate: DAYS(-20).slice(0, 10), status: 'Issued', valuation: '6500000' }]);
  assert.equal(searchProjects(store, org, new URLSearchParams('state=IA')).total, 1);
  assert.ok(before >= 1);
});

test('probe can list a column\'s real values, server-side', async () => {
  const { probeSocrata } = await import('../src/sources/adapters.js');
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return { ok: true, json: async () => (u.includes('/resource/') ? [{ permitclassmapped: 'Commercial', n: '812' }, { permitclassmapped: 'Residential', n: '4100' }] : { columns: [{ fieldName: 'permitclassmapped' }] }) }; };
  const r = await probeSocrata({ domain: 'd', dataset: 'x', fields: {} }, { fetchImpl, distinct: 'permitclassmapped' });
  assert.deepEqual(r.values, [{ value: 'Commercial', count: 812 }, { value: 'Residential', count: 4100 }]);
  await assert.rejects(probeSocrata({ domain: 'd', dataset: 'x', fields: {} }, { fetchImpl, distinct: 'x; drop' }), /bad column/);
});

test('window sync: re-pulls recently issued/applied permits, ignores portal-wide rewrites, no cursor', async () => {
  const { socrata } = await import('../src/sources/adapters.js');
  const urls = [];
  const src = { id: 'aus', rateLimitPerMin: 1e6, adapterConfig: { domain: 'd', dataset: 'x', dateField: 'issue_date', sync: 'window', windowDays: 120, windowFields: ['issue_date', 'applieddate'],
    where: "permit_type_desc = 'Building Permit'", fields: { permitId: 'permit_number', address: 'a' } } };
  const rows = await socrata(src, { since: '2026-11-01T00:00:00.000Z', fetchImpl: async u => { urls.push(u); return { ok: true, json: async () => [{ ':updated_at': '2026-11-02T00:00:00Z', permit_number: '1', a: 'x' }] }; } });
  const q = new URL(urls[0]).searchParams;
  assert.match(q.get('$where'), /^\(issue_date > '\d{4}-\d\d-\d\dT[\d:]{8}' OR applieddate > '\d{4}-\d\d-\d\dT[\d:]{8}'\) AND permit_type_desc = 'Building Permit'$/);
  assert.ok(!q.get('$where').includes('2026-11-01T00')); // ignores the cursor
  assert.equal(q.get('$order'), ':id'); assert.equal(rows[0]._cursor, null);
});

test('placeholder values ($0/$1) are treated as unknown, real values kept', async () => {
  const { normalizePermit } = await import('../src/permits.js');
  const src = { id: 's', jurisdiction: 'aus', city: 'Austin', state: 'TX', url: 'u' };
  const v = x => normalizePermit({ permitId: 'P', address: 'a', permitType: 'Commercial', description: 'new office', valuation: x }, src);
  assert.equal(v('1').valuation, null); assert.equal(v('1').valuationBasis, null);
  assert.equal(v('0').valuation, null);
  assert.equal(v('$1,250,000').valuation, 1250000); assert.equal(v('250').valuation, 250);
});

test('Minneapolis occupancy codes: MFD and 3to4 are multifamily; generic "Comm" falls back to the description', async () => {
  const { classifyOccupancy } = await import('../src/permits.js');
  assert.equal(classifyOccupancy('MFD'), 'multifamily'); assert.equal(classifyOccupancy('3to4'), 'multifamily');
  assert.equal(classifyOccupancy('Comm'), null);
});

test('grouping: permits at one site become one lead; detail lists the others; unit numbers and street spellings normalize', async () => {
  const { siteKey } = await import('../src/leads.js');
  assert.equal(siteKey({ state: 'tx', city: 'Austin', address: '500 Congress Avenue Suite 200' }), siteKey({ state: 'TX', city: 'austin', address: '500 CONGRESS AVE #1400' }));
  assert.notEqual(siteKey({ state: 'TX', city: 'Austin', address: '500 Congress Ave' }), siteKey({ state: 'TX', city: 'Austin', address: '502 Congress Ave' }));
  const { store, org } = leadWorld();
  ingestPermits(store, SRC('IA', 'Ankeny'), [
    { permitId: 'A-1F', address: '100 SW Oralabor Road', permitType: 'Commercial New', description: 'Foundation only, new medical office', issuedDate: DAYS(-30).slice(0, 10), status: 'Issued', valuation: '400000' },
  ]);
  const r = searchProjects(store, org, new URLSearchParams(''));
  const site = r.results.find(x => x.address.startsWith('100 SW Oralabor'));
  assert.equal(r.total, 2); assert.equal(r.permitTotal, 3);
  assert.equal(site.permitCount, 2); assert.equal(site.combinedValue, 6900000); assert.equal(site.permitId, 'A-1'); // lead = largest value
  const d = projectDetail(store, org, site.id).project;
  assert.deepEqual(d.sitePermits.map(x => x.permitId), ['A-1F']);
});

test('work-type tags from real city wording; filter and saved searches use them', async () => {
  const { workTags } = await import('../src/leads.js');
  const tags = (description, permitType = '') => workTags({ description, permitType });
  assert.deepEqual(tags('RoofWind Comm FLAT ROOF (MAA)'), ['roofing', 'windows_glazing']);
  assert.ok(tags('Remodel Comm T/I').includes('tenant_improvement'));
  assert.ok(tags('Construct interior alterations to existing office', 'Addition/Alteration').includes('interior_remodel'));
  assert.deepEqual(tags('New Comm construct 4-story office building'), ['new_construction']);
  assert.ok(tags('UnitFinish MFD water damage repairs in unit').includes('repair'));
  assert.ok(tags('Install fire sprinkler system').includes('fire_protection'));
  assert.deepEqual(tags('Commercial'), []);
  assert.deepEqual(workTags({ permitType: 'New', description: 'Construct mixed use building' }), ['new_construction']);
  assert.deepEqual(workTags({ permitType: 'Commercial', workClass: 'New', description: 'construct 3 story medical clinic' }), ['new_construction']);
  assert.ok(!tags('Install new windows').includes('new_construction'));
  assert.ok(tags('New 6-story medical office building').includes('new_construction'));
  assert.ok(tags('Shell building', 'Commercial New').includes('new_construction'));
  assert.ok(!tags('Replace rooftop unit with new equipment').includes('new_construction'));
  const { store, org, user } = leadWorld();
  ingestPermits(store, SRC('IA', 'Ankeny'), [{ permitId: 'R-1', address: '7 Roof Ln', permitType: 'Commercial Alteration', description: 'Commercial reroof, TPO membrane', issuedDate: DAYS(-5).slice(0, 10), status: 'Issued', valuation: '90000' }]);
  assert.deepEqual(searchProjects(store, org, new URLSearchParams('work=roofing')).results.map(r => r.permitId), ['R-1']);
  assert.equal(saveSearch(store, org, user, { name: 'Roofing jobs', filters: { work: 'roofing', state: 'IA' } }).search.filters.work, 'roofing');
});
