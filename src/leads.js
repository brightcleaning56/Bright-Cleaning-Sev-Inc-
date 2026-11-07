// Subscriber-facing lead intelligence: the iSqFt/BidClerk-style product.
// Every project comes from a public record with a source link. Anything computed
// (timeline, trade windows) is labeled as an estimate.
import { now } from './store.js';
import { normName, SENDABLE } from './domain.js';
import { leadAccess } from './billing.js';
import { licenseFor } from './enrichment.js';
import { config } from './config.js';
import { marketStatus } from './publishing.js';
import { derived } from './coredb.js';

const DAY = 864e5;

// ---------------- work-type tags (what trades the job involves) ----------------
// Read from the permit's own wording; computed at query time so every stored record benefits.
export const WORK_TAGS = [
  ['new_construction', 'New construction', /\bnew (comm\b|construction|commercial|office|retail|warehouse|medical|school|hotel|apartment|multi)|\bnew\b[\s\w,-]{0,30}\b(building|bldg|structure|facility|tower|center|shell)\b|\bcommercial new\b|ground[- ]up|construct (a )?new/],
  ['addition', 'Addition', /\baddition\b|\baddn\b|expan(d|sion)/],
  ['tenant_improvement', 'Tenant improvement / finish-out', /tenant (improve?ment|finish|fit)|\bt\/?i\b|finish[- ]?out|build[- ]?out|fit[- ]?out|white box/],
  ['interior_remodel', 'Interior remodel', /interior|remodel|renovat|alteration|\balter\b|unitfinish|bathroom|kitchen/],
  ['roofing', 'Roofing', /roof|reroof|re-roof|roofwind/],
  ['windows_glazing', 'Windows & glazing', /window|glaz|curtain ?wall|storefront|roofwind/],
  ['exterior_facade', 'Exterior / facade', /exterior|facade|fa\u00e7ade|siding|masonry|tuck ?point|stucco|cladding/],
  ['demolition', 'Demolition', /demoli|\bdemo\b|wreck/],
  ['site_work', 'Site work & grading', /grading|excavat|site work|sitework|earthwork|foundation|footing|shoring|retaining wall/],
  ['mep', 'Mechanical / electrical / plumbing', /mechanical|electrical|plumbing|hvac|\bmep\b|boiler|chiller|ductwork|equipment/],
  ['fire_protection', 'Fire protection', /sprinkler|fire (alarm|suppression|protection)|standpipe/],
  ['parking_paving', 'Parking & paving', /parking|paving|asphalt|garage|deck/],
  ['solar_energy', 'Solar / energy', /solar|photovoltaic|\bpv\b|battery storage|ev charg/],
  ['telecom', 'Telecom', /telecom|antenna|cell (site|tower)|wireless/],
  ['repair', 'Repair / restoration', /repair|water damage|fire damage|restor|replace/],
];
export function workTags(p) {
  const t = [p.permitType, p.workClass, p.description, p.projectName].filter(Boolean).join(' ').toLowerCase();
  const tags = WORK_TAGS.filter(([, , re]) => re.test(t)).map(([k]) => k);
  // Seattle permit type / Minneapolis work type of exactly "New" means a new building.
  if (!tags.includes('new_construction') && [p.permitType, p.workClass].some(v => /^\s*new\s*$/i.test(String(v || '')))) tags.unshift('new_construction');
  if (tags.includes('new_construction')) return tags.filter(k => !['interior_remodel', 'repair'].includes(k));
  return tags;
}
export const STAGES = ['applied', 'approved', 'issued', 'under_construction', 'finaled', 'expired'];

// ---------------- timeline estimate ----------------
// Typical commercial durations by reported valuation. Deliberately conservative and labeled.
function durationMonths(valuation, type) {
  let m = valuation == null ? 8 : valuation < 250e3 ? 2 : valuation < 1e6 ? 4 : valuation < 5e6 ? 8 : valuation < 20e6 ? 14 : 20;
  if (['warehouse', 'industrial'].includes(type)) m = Math.max(2, Math.round(m * 0.8));
  if (['medical', 'hospitality', 'education'].includes(type)) m = Math.round(m * 1.2);
  return m;
}
// Fractions of the build when each trade is typically on site.
export const TRADE_WINDOWS = [
  ['Site work & foundations', 0, 0.15], ['Structure & shell', 0.1, 0.45], ['Roofing', 0.3, 0.5],
  ['Mechanical, electrical & plumbing rough-in', 0.35, 0.65], ['Drywall & interior framing', 0.5, 0.75],
  ['Flooring, paint & finishes', 0.65, 0.9], ['Windows & glazing', 0.4, 0.7], ['Final / post-construction cleaning', 0.9, 1.0],
  ['Ongoing janitorial & property services', 1.0, 1.0],
];

// Interior jobs (tenant finish, remodel) skip site work and structure.
export const INTERIOR_WINDOWS = [
  ['Selective demolition', 0, 0.15], ['Mechanical, electrical & plumbing', 0.1, 0.55], ['Drywall & interior framing', 0.25, 0.65],
  ['Flooring, paint & finishes', 0.55, 0.9], ['Final / post-construction cleaning', 0.9, 1.0], ['Ongoing janitorial & property services', 1.0, 1.0],
];
export const isInterior = p => /alteration|tenant|finish|remodel|renovat|interior|build-?out/i.test([p.permitType, p.description, p.workClass].join(' '))
  && !/new (building|construction|office|warehouse|medical|multi|apartment)/i.test([p.permitType, p.description].join(' '));

export function timeline(p) {
  const anchor = p.status === 'issued' || p.status === 'finaled' ? p.permitDate : p.permitDate;
  if (!anchor || Number.isNaN(Date.parse(anchor))) return null;
  const start = Date.parse(anchor) + (p.status === 'applied' ? 45 : p.status === 'approved' ? 21 : 14) * DAY;
  const months = durationMonths(p.valuation, p.projectType);
  const end = start + months * 30.4 * DAY;
  const d = t => new Date(t).toISOString().slice(0, 10);
  const span = end - start;
  return {
    basis: 'estimate', note: 'Estimated from permit date, status, reported value and building type. Confirm with the GC.',
    estimatedStart: d(start), estimatedCompletion: d(end), durationMonths: months,
    scope: isInterior(p) ? 'interior' : 'new construction',
    trades: (isInterior(p) ? INTERIOR_WINDOWS : TRADE_WINDOWS).map(([trade, a, b]) => ({ trade, from: d(start + a * span), to: d(start + b * span) })),
  };
}

export function stageOf(p, at = Date.now()) {
  if (p.status === 'finaled' || p.status === 'expired') return p.status;
  if (p.status === 'issued') {
    const t = timeline(p);
    return t && Date.parse(t.estimatedStart) <= at ? 'under_construction' : 'issued';
  }
  return p.status === 'unknown' ? 'applied' : p.status;
}

// ---------------- contacts on a project ----------------
export function projectContacts(store, p, { details }) {
  const out = [];
  const named = [['General contractor (named on permit)', p.contractorOnPermit], ['Owner / developer', p.owner], ['Architect', p.architect]];
  for (const [role, name] of named) {
    if (!name) continue;
    const co = store.list('companies', c => c.normName === normName(name))[0];
    const people = co ? store.list('contacts', c => c.companyId === co.id && c.status !== 'opted_out' && !store.isSuppressed(c.email)) : [];
    const lic = licenseFor(store, p.state, name);
    out.push({
      role, name, source: 'public record', inDirectory: !!co,
      license: lic ? { number: lic.licenseNumber, status: lic.status, active: lic.active, type: lic.type, expiresAt: lic.expiresAt, specialties: lic.specialties,
        phone: details ? lic.phone : null, address: details ? lic.address : null, checkedAt: lic.checkedAt, sourceUrl: lic.sourceUrl } : null,
      website: co?.website || null, bidInstructions: co?.bidInstructions || null,
      people: people.map(c => ({ id: c.id, name: c.name, title: c.role || null, status: c.status,
        verified: SENDABLE.has(c.status), email: details ? c.email || null : null, phone: details ? c.phone || null : null, evidenceUrl: details ? c.evidenceUrl : null })),
    });
  }
  return out;
}

// ---------------- search ----------------
const num = v => (v === undefined || v === null || v === '' ? null : Number(v));
export function parseFilters(q) {
  const get = k => (q.get ? q.get(k) : q[k]);
  const list = k => { const v = get(k); return v ? (Array.isArray(v) ? v : String(v).split(',')).map(s => s.trim()).filter(Boolean) : []; };
  return {
    text: (get('q') || '').trim().toLowerCase() || null,
    states: list('state').map(s => s.toUpperCase()), cities: list('city').map(s => s.toLowerCase()),
    types: list('type'), stages: list('stage'),
    minValue: num(get('minValue')), maxValue: num(get('maxValue')), minSqft: num(get('minSqft')),
    since: get('since') || null, hasContact: get('hasContact') === 'true', includeClosed: get('includeClosed') === 'true',
    work: list('work'),
  };
}

export function matches(store, p, f, access) {
  if (!p.commercial || p.archived) return false;
  if (p.state && !access.states.includes(String(p.state).toUpperCase())) return false; // territory gate
  if (f.states.length && !f.states.includes(String(p.state || '').toUpperCase())) return false;
  if (f.cities.length && !f.cities.includes(String(p.city || '').toLowerCase())) return false;
  if (f.types.length && !f.types.includes(p.projectType)) return false;
  if (f.work.length && !workTags(p).some(t => f.work.includes(t))) return false;
  if (f.stages.length ? !f.stages.includes(stageOf(p)) : (!f.includeClosed && ['finaled', 'expired'].includes(stageOf(p)))) return false; // leads = active work by default
  if (f.minValue != null && !(p.valuation >= f.minValue)) return false;
  if (f.maxValue != null && !(p.valuation <= f.maxValue)) return false;   // unknown value counts as 0: passes a maximum, fails a positive minimum (same rule in permitsql.js)
  if (f.minSqft != null && !(p.squareFeet >= f.minSqft)) return false;
  if (f.since && !(Date.parse(p.changedAt || p.createdAt) > Date.parse(f.since))) return false; // strictly after the last run
  if (f.text) {
    const hay = [p.projectName, p.description, p.address, p.city, p.contractorOnPermit, p.owner, p.architect, p.permitId].join(' ').toLowerCase();
    if (!f.text.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  if (f.hasContact) {
    const co = p.contractorOnPermit && store.list('companies', c => c.normName === normName(p.contractorOnPermit))[0];
    if (!co || !store.list('contacts', c => c.companyId === co.id && SENDABLE.has(c.status)).length) return false;
  }
  return true;
}

export const summaryFor = (store, p, orgId) => summary(store, p, orgId);
const summary = (store, p, orgId) => {
  const t = timeline(p);
  const tracked = store.tlist('tracked', orgId, x => x.permitId === p.id)[0];
  return {
    id: p.id, permitId: p.permitId, title: p.projectName || p.description || 'Commercial project', address: p.address, city: p.city, state: p.state,
    projectType: p.projectType, stage: stageOf(p), valuation: p.valuation, valuationBasis: p.valuationBasis, squareFeet: p.squareFeet,
    permitDate: p.permitDate, contractorOnPermit: p.contractorOnPermit, estimatedStart: t?.estimatedStart || null,
    estimatedCompletion: t?.estimatedCompletion || null, firstSeenAt: p.firstSeenAt || p.createdAt, changedAt: p.changedAt || p.updatedAt,
    confidence: p.confidence, sourceUrl: p.sourceUrl, tracked: tracked ? tracked.stage : null, work: workTags(p),
    checkedAt: p.lastVerifiedAt || p.updatedAt,
  };
};

// One site, one lead: cities issue several permits for the same job (building, foundation, phases, revisions).
export function siteKey(p) {
  const a = String(p.address || '').toLowerCase()
    .replace(/\b(ste|suite|unit|bldg|building|fl|floor|rm|room|apt)\b\.?\s*[\w-]+/g, '').replace(/#\s*[\w-]+/g, '')
    .replace(/\b(street)\b/g, 'st').replace(/\b(avenue)\b/g, 'ave').replace(/\b(boulevard)\b/g, 'blvd').replace(/\b(road)\b/g, 'rd').replace(/\b(drive)\b/g, 'dr')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return `${String(p.state || '').toUpperCase()}|${String(p.city || '').toLowerCase()}|${a}`;
}

// ---------- grouping: permanent project (core reads) or job-site address (original) ----------
export const coreReadsOn = (opts) => (opts?.coreReads ?? config.coreReads) === 'on';
/** Project ID for a permit via its core link (aliases resolved); falls back to the address while not linked yet. */
export function projectIdOf(store, p) {
  const l = store.get('projectLinks', 'permit:' + p.id);
  if (!l) return 'site:' + siteKey(p);
  const a = store.get('projectAliases', l.projectId);
  return a ? a.projectId : l.projectId;
}
export const groupKeyFn = (store, opts) => coreReadsOn(opts) ? (p => projectIdOf(store, p)) : siteKey;
/** The project's anchor permit: the first permit ever linked (stable, so tracking and estimates don't move). */
export function anchorPermitId(store, projectId) {
  // Sequence first (exact creation order); links made before sequences existed fall back to their timestamp.
  const ls = store.list('projectLinks', l => l.projectId === projectId && l.kind === 'permit')
    .sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)) || a.id.localeCompare(b.id));
  return ls[0]?.refId || null;
}

/** Byte-order string comparison (same as PostgreSQL COLLATE "C"). */
export const cmpC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function searchProjects(store, org, query, { page = 1, pageSize = 50, sort = 'newest', coreReads } = {}) {
  const access = leadAccess(org);
  if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const f = parseFilters(query);
  const groups = new Map(); const keyOf = groupKeyFn(store, { coreReads }); const core = coreReadsOn({ coreReads });
  for (const p of store.list('permits', p => matches(store, p, f, access))) {
    const k = keyOf(p); const g = groups.get(k);
    if (g) g.push(p); else groups.set(k, [p]);
  }
  let rows = [...groups.entries()].map(([gk, ps]) => {
    // Lead permit: the largest real value, then the most recent activity.
    const lead = [...ps].sort((a, b) => (b.valuation || 0) - (a.valuation || 0) || cmpC(String(b.changedAt || ''), String(a.changedAt || '')) || cmpC(a.id, b.id))[0];
    const s = summary(store, lead, org.id);
    const vals = ps.map(p => p.valuation).filter(Boolean);
    const proj = core && gk.startsWith('BI-') ? store.get('projects', gk) : null;
    return { ...s, groupKey: gk, ...(proj ? { id: proj.id, projectId: proj.id, anchorPermitId: lead.id, title: proj.name || s.title, phase: proj.phase } : {}),
      permitIds: ps.map(p => p.id), work: [...new Set(ps.flatMap(workTags))], permitCount: ps.length, combinedValue: vals.length ? vals.reduce((a, b) => a + b, 0) : null,
      latestActivity: ps.map(p => String(p.changedAt || p.createdAt)).sort().pop(),
      earliestStart: ps.map(p => timeline(p)?.estimatedStart).filter(Boolean).sort()[0] || null };
  });
  // Final tie-breaker on the group key: identical order on every server and in the SQL path.
  const sorters = {
    newest: (a, b) => cmpC(b.latestActivity, a.latestActivity) || cmpC(a.groupKey, b.groupKey),
    value: (a, b) => (b.combinedValue || 0) - (a.combinedValue || 0) || cmpC(a.groupKey, b.groupKey),
    start: (a, b) => cmpC(String(a.earliestStart || '9'), String(b.earliestStart || '9')) || cmpC(a.groupKey, b.groupKey),
  };
  rows.sort(sorters[sort] || sorters.newest);
  const total = rows.length;
  const permitTotal = rows.reduce((n, r) => n + r.permitCount, 0);
  rows = rows.slice((page - 1) * pageSize, page * pageSize).map(r => { const pid = r.projectId || projectIdOf(store, { id: r.permitIds?.[0] || r.id });
    return { ...r, market: marketStatus(store, pid.startsWith('BI-') ? pid : null, org) }; });
  return { ok: true, total, permitTotal, page, pageSize, territories: access.states.length > 50 ? 'all states' : access.states, results: rows };
}

export function projectDetail(store, org, idIn, opts = {}) {
  const access = leadAccess(org);
  if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  let id = idIn, projectId = null;
  if (String(idIn).startsWith('BI-')) {
    const a = store.get('projectAliases', idIn); projectId = store.get('projects', idIn) ? idIn : a?.projectId || null;
    if (!projectId) return { ok: false, error: 'project not found', code: 404 };
    id = anchorPermitId(store, projectId);
    if (!id) return coreOnlyDetail(store, org, projectId, access);   // planning or bid-request-only project
  } else if (coreReadsOn(opts)) { const k = projectIdOf(store, { id }); if (k.startsWith('BI-')) projectId = k; }
  const p = store.get('permits', id);
  if (!p || !matches(store, p, parseFilters({ includeClosed: 'true' }), access)) return { ok: false, error: 'not found or outside your territory', code: 404 };
  const tracked = store.tlist('tracked', org.id, x => x.permitId === p.id)[0] || null;
  return { ok: true, project: {
    ...summary(store, p, org.id), description: p.description, permitType: p.permitType, status: p.status,
    statusHistory: p.statusHistory || [{ status: p.status, at: p.createdAt }], owner: p.owner, architect: p.architect,
    contractorNote: 'A contractor named on a permit is not always the awarded contractor.',
    timeline: timeline(p), contacts: projectContacts(store, p, { details: access.contactDetails }),
    lastVerifiedAt: p.lastVerifiedAt, trackedRecord: tracked, sourceLastSync: store.get('sources', p.sourceId)?.lastSuccessAt || null,
    sourceName: store.get('sources', p.sourceId)?.name || null, sourceDisclaimer: store.get('sources', p.sourceId)?.attribution || null,
    ...(projectId ? linkedPackagesCore(store, org, projectId) : linkedPackages(store, org, p)),
    ...(projectId ? coreBlock(store, projectId, p) : {}),
    market: marketStatus(store, projectId || (k => k.startsWith('BI-') ? k : null)(projectIdOf(store, p)), org),
    sitePermits: store.list('permits', x => x.id !== p.id && (projectId ? projectIdOf(store, x) === projectId : siteKey(x) === siteKey(p)) && matches(store, x, parseFilters({ includeClosed: 'true' }), access))
      .sort((a, b) => String(b.permitDate || '').localeCompare(String(a.permitDate || '')))
      .map(x => ({ id: x.id, permitId: x.permitId, permitType: x.permitType, description: x.description, status: x.status, stage: stageOf(x),
        valuation: x.valuation, permitDate: x.permitDate, contractorOnPermit: x.contractorOnPermit, sourceUrl: x.sourceUrl })),
  } };
}

// ---------------- tracking ----------------
export const TRACK_STAGES = ['watching', 'contacted', 'bidding', 'won', 'lost'];
export function trackProject(store, org, user, permitIdIn, { stage = 'watching', note } = {}) {
  if (!TRACK_STAGES.includes(stage)) return { ok: false, error: `stage must be ${TRACK_STAGES.join('|')}` };
  let permitId = permitIdIn;
  if (String(permitIdIn).startsWith('BI-')) {
    const a = store.get('projectAliases', permitIdIn); const pid = store.get('projects', permitIdIn) ? permitIdIn : a?.projectId;
    permitId = pid && anchorPermitId(store, pid);
    if (!permitId) return { ok: false, code: 400, error: 'this project can be followed once a building permit is linked to it' };
  }
  const d = projectDetail(store, org, permitId); if (!d.ok) return d;
  const t = store.tlist('tracked', org.id, x => x.permitId === permitId)[0] || { permitId, notes: [] };
  t.stage = stage;
  if (note) t.notes.push({ text: String(note).slice(0, 2000), by: user.email, at: now() });
  store.tput('tracked', org.id, t);
  store.audit({ actor: user.email, orgId: org.id, action: 'project.track', target: permitId, detail: { stage } });
  return { ok: true, tracked: t };
}

// ---------------- saved searches + alerts ----------------
export function saveSearch(store, org, user, { name, filters }) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason };
  if (!name) return { ok: false, error: 'name required' };
  if (store.tlist('savedSearches', org.id).length >= access.savedSearches) return { ok: false, error: `your plan allows ${access.savedSearches} saved searches` };
  const clean = Object.fromEntries(Object.entries(filters || {}).filter(([k]) => ['q', 'state', 'city', 'type', 'stage', 'minValue', 'maxValue', 'minSqft', 'hasContact', 'includeClosed', 'work'].includes(k)));
  const s = store.tput('savedSearches', org.id, { name: String(name).slice(0, 100), filters: clean, frequency: 'daily', lastRunAt: now(), createdBy: user.email, alertEmail: user.email });
  store.audit({ actor: user.email, orgId: org.id, action: 'search.save', target: s.id });
  return { ok: true, search: s };
}

/** New or changed projects for each saved search since its last run. */
export function collectAlerts(store, org) {
  const access = leadAccess(org); if (!access.ok) return [];
  const out = [];
  for (const s of store.tlist('savedSearches', org.id)) {
    const since = s.lastRunAt || s.createdAt;
    const f = parseFilters(s.filters); f.since = since;
    const hits = store.list('permits', p => matches(store, p, f, access)).map(p => ({
      ...summary(store, p, org.id), why: Date.parse(p.firstSeenAt || p.createdAt) >= Date.parse(since) ? 'new'
        : (h => h.length > 1 ? `stage changed: ${h.at(-2).status} → ${h.at(-1).status}` : `updated (${p.status})`)(p.statusHistory || []),
    }));
    out.push({ search: s, hits });
  }
  return out;
}

export function exportCsv(store, org, query) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const month = new Date().toISOString().slice(0, 7);
  org.exportUsage ||= {};
  const used = org.exportUsage[month] || 0;
  const r = searchProjects(store, org, query, { pageSize: 100000 });
  const allowed = Math.max(0, access.exportsPerMonth - used);
  if (!allowed) return { ok: false, error: `export limit reached for ${month} (${access.exportsPerMonth} rows)`, code: 402 };
  const rows = r.results.slice(0, allowed);
  org.exportUsage[month] = used + rows.length; store.put('orgs', org);
  const cols = ['permitId', 'title', 'address', 'city', 'state', 'projectType', 'work', 'stage', 'valuation', 'permitCount', 'combinedValue', 'squareFeet', 'permitDate', 'estimatedStart', 'estimatedCompletion', 'contractorOnPermit', 'sourceUrl'];
  const esc = v => { const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return { ok: true, csv: [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'), rows: rows.length, truncated: r.results.length > rows.length };
}

// ---------------- contractor intelligence (built from our own permit data) ----------------
export function contractors(store, org, query) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const get = k => (query.get ? query.get(k) : query[k]);
  const q = String(get('q') || '').toLowerCase(), st = String(get('state') || '').toUpperCase();
  const f = parseFilters({ includeClosed: 'true' });
  const by = new Map();
  for (const p of store.list('permits', p => p.contractorOnPermit && matches(store, p, f, access) && (!st || String(p.state).toUpperCase() === st))) {
    const key = `${String(p.state).toUpperCase()}:${normName(p.contractorOnPermit)}`; if (key.endsWith(':')) continue;
    const g = by.get(key) || { key, name: p.contractorOnPermit, state: p.state, permits: 0, active: 0, value: 0, cities: new Set(), latest: '', work: new Set(), sites: new Set() };
    g.permits++; if (!['finaled', 'expired'].includes(stageOf(p))) g.active++;
    g.value += p.valuation || 0; g.cities.add(p.city); g.sites.add(siteKey(p));
    if (String(p.permitDate || '') > g.latest) g.latest = String(p.permitDate || '');
    workTags(p).forEach(w => g.work.add(w));
    by.set(key, g);
  }
  let rows = [...by.values()].filter(g => !q || g.name.toLowerCase().includes(q)).map(g => {
    const lic = licenseFor(store, g.state, g.name);
    return { key: g.key, name: g.name, state: g.state, permits: g.permits, sites: g.sites.size, activePermits: g.active, reportedValue: g.value || null,
      cities: [...g.cities], latestPermit: g.latest || null, work: [...g.work],
      license: lic ? { number: lic.licenseNumber, status: lic.status, active: lic.active, checkedAt: lic.checkedAt } : null };
  });
  rows.sort((a, b) => b.activePermits - a.activePermits || (b.reportedValue || 0) - (a.reportedValue || 0));
  return { ok: true, total: rows.length, results: rows.slice(0, 200) };
}

export function contractorDetail(store, org, key) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const [st, nn] = String(key).split(':');
  const f = parseFilters({ includeClosed: 'true' });
  const ps = store.list('permits', p => p.contractorOnPermit && String(p.state).toUpperCase() === st && normName(p.contractorOnPermit) === nn && matches(store, p, f, access));
  if (!ps.length) return { ok: false, error: 'not found or outside your territory', code: 404 };
  const lic = licenseFor(store, st, ps[0].contractorOnPermit);
  const co = store.list('companies', c => c.normName === nn)[0];
  return { ok: true, contractor: {
    key, name: ps[0].contractorOnPermit, state: st,
    license: lic ? { number: lic.licenseNumber, status: lic.status, active: lic.active, type: lic.type, expiresAt: lic.expiresAt, specialties: lic.specialties,
      phone: access.contactDetails ? lic.phone : null, address: access.contactDetails ? lic.address : null, principal: lic.principal, checkedAt: lic.checkedAt, sourceUrl: lic.sourceUrl } : null,
    website: co?.website || null,
    people: co ? store.list('contacts', c => c.companyId === co.id && c.status !== 'opted_out' && !store.isSuppressed(c.email)).map(c => ({ name: c.name, title: c.role, verified: SENDABLE.has(c.status), email: access.contactDetails ? c.email : null })) : [],
    projects: ps.sort((a, b) => String(b.permitDate || '').localeCompare(String(a.permitDate || ''))).slice(0, 100).map(p => summary(store, p, org.id)),
  } };
}

// ---------------- planning / zoning signals ----------------
export function planningSignals(store, org, query) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const get = k => (query.get ? query.get(k) : query[k]);
  const q = String(get('q') || '').toLowerCase();
  const rows = store.list('signals', s => access.states.includes(String(s.state).toUpperCase()) && (!q || `${s.title} ${s.type} ${s.file} ${s.address || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => String(b.introDate || '').localeCompare(String(a.introDate || '')));
  return { ok: true, total: rows.length, results: rows.slice(0, 200), note: 'Planning and zoning items come before permits. Many never become projects; treat them as early signals.' };
}

// ---------------- command center ----------------
/** Real numbers only, scoped to the company's territory. */
export function commandCenter(store, org, opts = {}) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const f = parseFilters({});
  const active = store.list('permits', p => matches(store, p, f, access));
  const month = Date.now() - 30 * DAY;
  const keyOf = groupKeyFn(store, opts);
  const sites = new Set(active.map(keyOf));
  const newSites = new Set(active.filter(p => Date.parse(p.firstSeenAt || p.createdAt) > month).map(keyOf));
  const value = active.reduce((n, p) => n + (p.valuation || 0), 0);
  const sources = store.list('sources', s => s.enabled && ['socrata', 'arcgis'].includes(s.adapter));
  const live = sources.filter(s => access.states.includes(String(s.state || '').toUpperCase()));
  const openRequests = store.list('bidRequests', r => r.status === 'open' && Date.parse(r.dueDate) > Date.now() && access.states.includes(r.state));
  const withPlans = new Set(store.list('documents', d => !d.removed).map(d => d.requestId));
  const signals = store.list('signals', s => access.states.includes(String(s.state).toUpperCase()));
  const located = active.filter(p => p.lat != null && p.lng != null).length;
  const prevMonth = Date.now() - 60 * DAY;
  const newPrev = new Set(active.filter(p => { const t = Date.parse(p.firstSeenAt || p.createdAt); return t > prevMonth && t <= month; }).map(keyOf)).size;
  return { ok: true, kpis: {
    activeSites: sites.size, activePermits: active.length, newSitesThisMonth: newSites.size,
    reportedValue: value || null, valueCoverage: active.length ? Math.round(100 * active.filter(p => p.valuation).length / active.length) : 0,
    openBidRequests: openRequests.length, bidRequestsWithPlans: openRequests.filter(r => withPlans.has(r.id)).length,
    earlySignals: signals.length, locatedOnMap: located, newSitesPrevMonth: newPrev,
    states: [...new Set(live.map(s => s.state))].length,
    coverage: live.map(s => ({ city: s.city, state: s.state, lastSync: s.lastSuccessAt || null })),
  } };
}

/** Map points for projects that have coordinates (one per job site). */
export function mapPoints(store, org, query, opts = {}) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const f = parseFilters(query);
  const bySite = new Map(); const keyOf = groupKeyFn(store, opts);
  for (const p of store.list('permits', p => p.lat != null && p.lng != null && matches(store, p, f, access))) {
    const k = keyOf(p); const cur = bySite.get(k);
    if (!cur || (p.valuation || 0) > (cur.valuation || 0)) bySite.set(k, p);
  }
  const pts = [...bySite.entries()].slice(0, 3000).map(([k, p]) => ({ id: k.startsWith('BI-') ? k : p.id, lat: p.lat, lng: p.lng, title: (k.startsWith('BI-') && store.get('projects', k)?.name) || p.projectName || p.description || 'Commercial project',
    address: p.address, city: p.city, stage: stageOf(p), type: p.projectType, valuation: p.valuation || null }));
  return { ok: true, total: pts.length, points: pts };
}

// ---------------- market activity (from our own permit history) ----------------
export function marketActivity(store, org) {
  const access = leadAccess(org); if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const all = store.list('permits', p => matches(store, p, parseFilters({ includeClosed: 'true' }), access));
  const count = (key) => { const m = new Map(); for (const p of all) { const k = key(p); if (!k) continue; const g = m.get(k) || { key: k, permits: 0, value: 0 }; g.permits++; g.value += p.valuation || 0; m.set(k, g); } return [...m.values()].sort((a, b) => b.permits - a.permits); };
  const month = p => String(p.permitDate || '').slice(0, 7);
  return { ok: true, totalPermits: all.length,
    byCity: count(p => `${p.city}, ${p.state}`).slice(0, 15), byType: count(p => p.projectType), byStage: count(p => stageOf(p)),
    byWork: (() => { const m = new Map(); for (const p of all) for (const w of workTags(p)) m.set(w, (m.get(w) || 0) + 1); return [...m.entries()].map(([key, permits]) => ({ key, permits })).sort((a, b) => b.permits - a.permits); })(),
    byMonth: count(month).sort((a, b) => a.key.localeCompare(b.key)).slice(-12),
    note: 'Counted from permits BUILDINTEL has collected in your territory (coverage grows as cities are added); not a market forecast.' };
}

/** Bid requests at the same job site that this company may see (it posted them or was invited), with their plan-room files. */
export function linkedPackages(store, org, p) {
  const k = siteKey(p);
  const visible = r => r.buyerOrgId === org.id || store.list('invitations', i => i.requestId === r.id && i.sellerOrgId === org.id).length > 0;
  const reqs = store.list('bidRequests', r => siteKey(r) === k && visible(r));
  const docs = store.list('documents', d => !d.removed && reqs.some(r => r.id === d.requestId));
  return {
    bidPackages: reqs.map(r => { const inv = store.list('invitations', i => i.requestId === r.id && i.sellerOrgId === org.id)[0];
      return { id: r.id, title: r.title, trades: r.trades, dueDate: r.dueDate, status: r.status, buyerName: r.buyerName, addendumCount: r.addendumCount || 0, invitationId: inv?.id || null, intent: inv?.intent || null }; }),
    drawings: docs.map(d => ({ id: d.id, name: d.name, sheet: d.sheet, discipline: d.discipline, kind: d.kind, title: d.title, addendum: d.addendum, requestId: d.requestId })),
    analyses: store.tlist('analyses', org.id, a => a.status === 'verified' && docs.some(d => d.id === a.documentId)).map(a => ({ id: a.id, documentId: a.documentId, sheet: a.sheet, totals: a.result.totals, rooms: a.result.rooms })),
  };
}

// ---------- core read helpers (phase 2) ----------
function coreBlock(store, projectId, p) {
  const pr = store.get('projects', projectId);
  return { id: projectId, projectId, anchorPermitId: p.id, title: pr?.name || undefined, phase: pr?.phase,
    projectPhases: store.list('projectPhases', h => h.projectId === projectId).sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(h => ({ phase: h.phase, startedAt: h.startedAt, endedAt: h.endedAt })) };
}
/** Bid packages, drawings and confirmed takeoffs linked to the project (GC-picked or address-linked), visible to this company. */
export function linkedPackagesCore(store, org, projectId) {
  const visible = r => r.buyerOrgId === org.id || store.list('invitations', i => i.requestId === r.id && i.sellerOrgId === org.id).length > 0;
  const reqs = store.list('projectLinks', l => l.projectId === projectId && l.kind === 'bid_request').map(l => store.get('bidRequests', l.refId)).filter(r => r && visible(r));
  const docs = store.list('documents', d => !d.removed && reqs.some(r => r.id === d.requestId));
  return {
    bidPackages: reqs.map(r => { const inv = store.list('invitations', i => i.requestId === r.id && i.sellerOrgId === org.id)[0];
      return { id: r.id, title: r.title, trades: r.trades, dueDate: r.dueDate, status: r.status, buyerName: r.buyerName, addendumCount: r.addendumCount || 0, invitationId: inv?.id || null, intent: inv?.intent || null }; }),
    drawings: docs.map(d => ({ id: d.id, name: d.name, sheet: d.sheet, discipline: d.discipline, kind: d.kind, title: d.title, addendum: d.addendum, requestId: d.requestId })),
    analyses: store.tlist('analyses', org.id, a => a.status === 'verified' && docs.some(d => d.id === a.documentId)).map(a => ({ id: a.id, documentId: a.documentId, sheet: a.sheet, totals: a.result.totals, rooms: a.result.rooms })),
  };
}
/** Detail for a project with no building permit yet (land-use filing or GC bid request only). Same shape as a permit detail. */
function coreOnlyDetail(store, org, projectId, access) {
  const pr = store.get('projects', projectId);
  const pk = linkedPackagesCore(store, org, projectId);
  const signals = store.list('projectLinks', l => l.projectId === projectId && l.kind === 'land_use').map(l => store.get('signals', l.refId)).filter(Boolean);
  const inTerritory = access.states.includes(String(pr.state || '').toUpperCase());
  if (!inTerritory && !pk.bidPackages.length) return { ok: false, error: 'not found or outside your territory', code: 404 };
  const roleL = { general_contractor: 'General contractor', owner: 'Owner / developer', developer: 'Owner / developer', architect: 'Architect', trade_contractor: 'Trade contractor (awarded)' };
  const sig = signals[0];
  return { ok: true, project: {
    id: projectId, projectId, anchorPermitId: null, title: pr.name, address: pr.address, city: pr.city, state: pr.state, projectType: pr.projectType || 'other_commercial',
    stage: pr.phase, phase: pr.phase, valuation: pr.estValue || null, squareFeet: pr.buildingSf || null, permitId: sig?.file || '—', description: sig?.title || pr.name,
    status: sig?.status || pr.phase, statusHistory: [], work: [], timeline: null, sourceUrl: sig?.url || null, sourceName: sig ? 'Land-use application' : 'GC bid request',
    lastVerifiedAt: sig?.updatedAt || pr.updatedAt, confidence: 'project record', tracked: null, trackedRecord: null,
    contacts: store.list('projectCompanies', c => c.projectId === projectId).map(c => ({ role: roleL[c.role] || c.role, name: c.name, people: [], license: null, inDirectory: false })),
    contractorNote: 'No building permit is linked to this project yet.', sitePermits: [], market: marketStatus(store, projectId, org),
    projectPhases: store.list('projectPhases', h => h.projectId === projectId).sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(h => ({ phase: h.phase, startedAt: h.startedAt, endedAt: h.endedAt })),
    ...pk,
  } };
}

Object.assign(derived, { workTags, timeline, siteKey });   // bi_permits derives its filter columns with these exact functions
