// Project Intelligence Core (phase 1): one permanent project record per development, with everything else linked
// to it. Every link and company relationship keeps its source, method, confidence and dates. Linking is
// deterministic; when two projects could match, the item goes to a review queue instead of being guessed.
import crypto from 'node:crypto';
import { now } from './store.js';
import { siteKey } from './leads.js';
import { normName } from './domain.js';
import { leadAccess } from './billing.js';

export const PHASES = ['planning', 'design', 'permitting', 'bidding', 'construction', 'closeout'];
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
export const newProjectId = () => 'BI-' + [...crypto.randomBytes(8)].map(b => ALPHA[b % ALPHA.length]).join('');

// ---------- index: site key → project ids (rebuilt on demand, cached on the store) ----------
function idx(store) {
  if (store._coreIdx) return store._coreIdx;
  const m = new Map();
  for (const p of store.list('projects')) for (const k of p.siteKeys || []) (m.get(k) || m.set(k, new Set()).get(k)).add(p.id);
  store._coreIdx = m; return m;
}
const addKey = (store, k, id) => { const m = idx(store); (m.get(k) || m.set(k, new Set()).get(k)).add(id); };

export function resolveProjectId(store, id) {
  if (store.get('projects', id)) return id;
  const a = store.get('projectAliases', id); return a ? a.projectId : null;
}
const linkOf = (store, kind, refId) => store.get('projectLinks', `${kind}:${refId}`);
/** Global, monotonic link sequence: ordering never depends on clock resolution (two links can share a millisecond). */
export function nextLinkSeq(store) {
  if (store._linkSeq == null) store._linkSeq = store.list('projectLinks').reduce((m, l) => Math.max(m, l.seq || 0), 0);
  return ++store._linkSeq;
}

function createProject(store, seed) {
  const id = newProjectId();
  const p = store.put('projects', { id, name: seed.name || 'Commercial project', status: 'active', phase: seed.phase || 'permitting',
    address: seed.address || null, city: seed.city || null, state: seed.state ? String(seed.state).toUpperCase() : null, siteKeys: [seed.siteKey],
    lat: seed.lat ?? null, lng: seed.lng ?? null, projectType: seed.projectType || null, estValue: seed.value || null, buildingSf: seed.sf || null, firstSeenAt: now() });
  addKey(store, seed.siteKey, id);
  store.put('projectPhases', { id: `${id}:1`, seq: 1, projectId: id, phase: p.phase, startedAt: now(), endedAt: null, source: seed.kind });
  return p;
}

/** Find or create the project for one record. Returns { projectId, created, ambiguous }. */
export function linkRecord(store, rec) {
  const existing = linkOf(store, rec.kind, rec.refId);
  if (existing) {                                       // already linked: stable, just refresh
    existing.lastSeenAt = now(); store.put('projectLinks', existing);
    enrich(store, store.get('projects', existing.projectId), rec);
    return { projectId: existing.projectId, created: false };
  }
  if (!rec.siteKey || /\|\|$|\|$/.test(rec.siteKey) || rec.siteKey.endsWith('|')) return { projectId: null, skipped: 'no address' };
  const matches = [...(idx(store).get(rec.siteKey) || [])];
  if (matches.length > 1) {                              // never guess between two projects
    store.put('reviewQueue', { id: `${rec.kind}:${rec.refId}`, kind: rec.kind, refId: rec.refId, siteKey: rec.siteKey, candidates: matches, reason: 'address matches more than one project', createdAt: now(), status: 'open' });
    return { projectId: null, ambiguous: matches };
  }
  const created = !matches.length;
  const p = created ? createProject(store, rec) : store.get('projects', matches[0]);
  store.put('projectLinks', { id: `${rec.kind}:${rec.refId}`, seq: nextLinkSeq(store), projectId: p.id, kind: rec.kind, refId: rec.refId,
    method: created ? 'created from record' : rec.method || 'address match', confidence: rec.confidence || 'high', sourceUrl: rec.sourceUrl || null, firstSeenAt: now(), lastSeenAt: now() });
  enrich(store, p, rec);
  return { projectId: p.id, created };
}

/** Fill project fields from linked records without overwriting better data. */
function enrich(store, p, rec) {
  if (!p) return;
  let ch = false;
  const set = (k, v) => { if (v != null && v !== '' && p[k] !== v) { p[k] = v; ch = true; } };
  if (rec.preferName || !p.name || p.name === 'Commercial project') set('name', rec.name);
  if (!p.address) set('address', rec.address);
  if (p.lat == null && rec.lat != null) { set('lat', rec.lat); set('lng', rec.lng); }
  if (!p.projectType || p.projectType === 'other_commercial') set('projectType', rec.projectType);
  if (rec.value && (!p.estValue || rec.value > p.estValue)) set('estValue', rec.value);
  if (rec.sf && (!p.buildingSf || rec.sf > p.buildingSf)) set('buildingSf', rec.sf);
  if (ch) store.put('projects', p);
}

/** Company relationship with provenance; one row per (project, role, company), dates refreshed on every sighting. */
export function upsertCompany(store, projectId, { name, role, sourceKind, sourceRef, sourceUrl, verified, method }) {
  if (!projectId || !name) return null;
  const key = normName(name); if (!key) return null;
  const id = `${projectId}:${role}:${key}`;
  const prev = store.get('projectCompanies', id);
  // Every source that supports this relationship is kept; the headline is the strongest (verified beats named).
  const evidence = [...(prev?.evidence || [])];
  const e = evidence.find(x => x.kind === sourceKind && x.ref === sourceRef);
  if (e) e.lastSeenAt = now(); else evidence.push({ kind: sourceKind, ref: sourceRef, url: sourceUrl || null, method, verified: !!verified, firstSeenAt: now(), lastSeenAt: now() });
  const best = evidence.find(x => x.verified) || evidence[0];
  return store.put('projectCompanies', { ...(prev || {}), id, projectId, role, companyKey: key, name: prev?.name || name,
    sourceKind: best.kind, sourceRef: best.ref, sourceUrl: best.url, method: best.method, verified: evidence.some(x => x.verified),
    evidence, firstSeenAt: prev?.firstSeenAt || now(), lastSeenAt: now() });
}

// ---------- record adapters ----------
const permitPhase = st => /final|complete|closed/i.test(st || '') ? 'closeout' : /issued|construction|inspect|approved/i.test(st || '') ? 'construction' : 'permitting';
export function linkPermit(store, pm) {
  if (pm.archived) return { projectId: null, skipped: 'archived' };
  const r = linkRecord(store, { kind: 'permit', refId: pm.id, siteKey: siteKey(pm), name: pm.projectName || pm.description, preferName: !!pm.projectName,
    address: pm.address, city: pm.city, state: pm.state, lat: pm.lat, lng: pm.lng, projectType: pm.projectType, value: pm.valuation, sf: pm.squareFeet, sourceUrl: pm.sourceUrl });
  if (r.projectId) {
    const src = { sourceKind: 'permit', sourceRef: pm.permitId, sourceUrl: pm.sourceUrl, verified: false, method: 'named on permit' };
    upsertCompany(store, r.projectId, { name: pm.contractorOnPermit, role: 'general_contractor', ...src });
    upsertCompany(store, r.projectId, { name: pm.owner, role: 'owner', ...src });
    upsertCompany(store, r.projectId, { name: pm.architect, role: 'architect', ...src });
  }
  return r;
}
export function linkSignal(store, sg) {
  if (!sg.address) return { projectId: null, skipped: 'no address' };
  return linkRecord(store, { kind: 'land_use', refId: sg.id, siteKey: siteKey({ address: sg.address, city: sg.city, state: sg.state }), name: sg.title,
    address: sg.address, city: sg.city, state: sg.state, sourceUrl: sg.url, phase: 'planning' });
}
export function linkBidRequest(store, rq) {
  const r = linkRecord(store, { kind: 'bid_request', refId: rq.id, siteKey: siteKey(rq), name: rq.title, address: rq.address, city: rq.city, state: rq.state, projectType: rq.projectType, sf: rq.squareFeet, phase: 'bidding' });
  if (r.projectId) {
    const buyer = store.get('orgs', rq.buyerOrgId);
    const role = { general_contractor: 'general_contractor', property_manager: 'owner', owner: 'owner', developer: 'developer' }[rq.buyerKind || buyer?.buyerKind] || 'general_contractor';
    upsertCompany(store, r.projectId, { name: rq.buyerName || buyer?.name, role, sourceKind: 'bid_request', sourceRef: rq.id, verified: true, method: 'posted the bid request from its own account' });
    for (const d of store.list('documents', d => d.requestId === rq.id && !d.removed)) linkDocument(store, d);
  }
  return r;
}
/** The GC explicitly chose the project when posting: link as confirmed (no address guess). */
export function linkBidRequestTo(store, rq, projectIdIn) {
  const projectId = resolveProjectId(store, projectIdIn);
  const p = projectId && store.get('projects', projectId);
  if (!p) return { ok: false, code: 400, error: 'project not found' };
  if (p.state && rq.state && p.state !== String(rq.state).toUpperCase()) return { ok: false, code: 400, error: 'that project is in a different state than this request' };
  store.put('projectLinks', { id: `bid_request:${rq.id}`, seq: nextLinkSeq(store), projectId, kind: 'bid_request', refId: rq.id, method: 'chosen by GC', confidence: 'confirmed', sourceUrl: null, firstSeenAt: now(), lastSeenAt: now() });
  linkBidRequest(store, rq);                    // already linked now: adds the GC relationship and any plan-room files
  recomputePhase(store, projectId);
  return { ok: true, projectId };
}

export function linkDocument(store, d) {
  const req = linkOf(store, 'bid_request', d.requestId); if (!req) return { projectId: null, skipped: 'bid request not linked' };
  if (linkOf(store, 'document', d.id)) return { projectId: req.projectId, created: false };
  store.put('projectLinks', { id: `document:${d.id}`, seq: nextLinkSeq(store), projectId: req.projectId, kind: 'document', refId: d.id, method: 'uploaded to a linked bid request', confidence: 'high', sourceUrl: null, firstSeenAt: now(), lastSeenAt: now() });
  return { projectId: req.projectId, created: false };
}
export function linkAward(store, c) {
  const req = linkOf(store, 'bid_request', c.requestId); if (!req) return null;
  if (!linkOf(store, 'contract', c.id)) store.put('projectLinks', { id: `contract:${c.id}`, seq: nextLinkSeq(store), projectId: req.projectId, kind: 'contract', refId: c.id, method: 'award on a linked bid request', confidence: 'high', sourceUrl: null, firstSeenAt: now(), lastSeenAt: now() });
  const seller = store.get('orgs', c.sellerOrgId);
  upsertCompany(store, req.projectId, { name: seller?.legal?.name || seller?.name || c.sellerName, role: 'trade_contractor', sourceKind: 'contract', sourceRef: c.id, verified: true, method: 'signed award' });
  return req.projectId;
}

/** Phase from linked records; history kept whenever it changes. */
export function recomputePhase(store, projectId, linksIn, histIn) {
  const p = store.get('projects', projectId); if (!p) return null;
  const links = linksIn || store.list('projectLinks', l => l.projectId === projectId);
  let ph = 'planning';
  const bump = x => { if (PHASES.indexOf(x) > PHASES.indexOf(ph)) ph = x; };
  for (const l of links) {
    if (l.kind === 'permit') { const pm = store.get('permits', l.refId); if (pm) bump(permitPhase(pm.status)); }
    if (l.kind === 'bid_request') { const rq = store.get('bidRequests', l.refId); if (rq?.status === 'open') bump('bidding'); }
    if (l.kind === 'contract') bump('construction');
  }
  if (p.phase !== ph) {
    const hist = histIn || store.list('projectPhases', h => h.projectId === projectId);
    for (const h of hist.filter(h => !h.endedAt)) { h.endedAt = now(); store.put('projectPhases', h); }
    const seq = Math.max(0, ...hist.map(h => h.seq || 0)) + 1;
    store.put('projectPhases', { id: `${projectId}:${seq}`, seq, projectId, phase: ph, startedAt: now(), endedAt: null, source: 'linked records' });
    p.phase = ph; store.put('projects', p);
  }
  return ph;
}

/** Idempotent backfill + incremental sync: safe to run on every cycle. */
export function backfillCore(store, { full = false } = {}) {
  const since = full ? null : store._coreCursor || null;
  const runStart = now();
  const changed = r => !since || String(r.updatedAt || r.createdAt || '') >= since;
  const before = { projects: store.list('projects').length, links: store.list('projectLinks').length };
  const out = { permits: 0, signals: 0, bidRequests: 0, documents: 0, contracts: 0, ambiguous: 0, skipped: 0 };
  const touched = new Set();
  const tally = (k, r) => { if (r?.projectId) { out[k]++; touched.add(r.projectId); } else if (r?.ambiguous) out.ambiguous++; else out.skipped++; };
  for (const s of store.list('signals', s => s.kind === 'land_use_application' && changed(s))) tally('signals', linkSignal(store, s));
  for (const pm of store.list('permits', pm => !pm.archived && changed(pm))) tally('permits', linkPermit(store, pm));
  for (const rq of store.list('bidRequests', changed)) tally('bidRequests', linkBidRequest(store, rq));
  for (const d of store.list('documents', d => !d.removed && changed(d))) tally('documents', linkDocument(store, d));
  for (const c of store.list('contracts', changed)) { const id = linkAward(store, c); if (id) { out.contracts++; touched.add(id); } }
  const byProject = new Map();                                    // group links once instead of rescanning per project
  for (const l of store.list('projectLinks')) if (touched.has(l.projectId)) (byProject.get(l.projectId) || byProject.set(l.projectId, []).get(l.projectId)).push(l);
  const histBy = new Map();                                       // and phase history once (was a full scan per project: quadratic)
  for (const h of store.list('projectPhases')) if (touched.has(h.projectId)) (histBy.get(h.projectId) || histBy.set(h.projectId, []).get(h.projectId)).push(h);
  for (const id of touched) recomputePhase(store, id, byProject.get(id) || [], histBy.get(id) || []);
  store._coreCursor = runStart;
  return { ...out, mode: since ? 'incremental' : 'full', newProjects: store.list('projects').length - before.projects, newLinks: store.list('projectLinks').length - before.links,
    projects: store.list('projects').length, openReview: store.list('reviewQueue', r => r.status === 'open').length };
}

// ---------- admin: merge, split, resolve review items ----------
export function mergeProjects(store, keepId, dropId, actor) {
  const keep = store.get('projects', keepId), drop = store.get('projects', dropId);
  if (!keep || !drop || keepId === dropId) return { ok: false, code: 400, error: 'two different existing projects required' };
  for (const l of store.list('projectLinks', l => l.projectId === dropId)) { l.projectId = keepId; l.method += ' (merged)'; store.put('projectLinks', l); }
  for (const c of store.list('projectCompanies', c => c.projectId === dropId)) {
    const id = `${keepId}:${c.role}:${c.companyKey}`; const prev = store.get('projectCompanies', id);
    const evidence = [...(prev?.evidence || []), ...(c.evidence || []).filter(x => !(prev?.evidence || []).some(y => y.kind === x.kind && y.ref === x.ref))];
    const best = evidence.find(x => x.verified) || evidence[0] || {};
    store.put('projectCompanies', { ...c, ...(prev || {}), id, projectId: keepId, evidence, verified: evidence.some(x => x.verified), method: best.method || c.method, sourceKind: best.kind || c.sourceKind, sourceRef: best.ref || c.sourceRef, sourceUrl: best.url ?? c.sourceUrl,
      firstSeenAt: [prev?.firstSeenAt, c.firstSeenAt].filter(Boolean).sort()[0] });
    store.remove('projectCompanies', c.id);
  }
  for (const h of store.list('projectPhases', h => h.projectId === dropId)) store.remove('projectPhases', h.id);
  keep.siteKeys = [...new Set([...(keep.siteKeys || []), ...(drop.siteKeys || [])])]; store.put('projects', keep);
  for (const a of store.list('projectAliases', a => a.projectId === dropId)) { a.projectId = keepId; store.put('projectAliases', a); }
  store.put('projectAliases', { id: dropId, projectId: keepId, at: now(), by: actor });
  store.remove('projects', dropId); store._coreIdx = null;
  for (const r of store.list('reviewQueue', r => r.status === 'open' && r.candidates.includes(dropId))) { r.status = 'resolved'; r.resolution = `merged into ${keepId}`; store.put('reviewQueue', r); }
  recomputePhase(store, keepId);
  store.audit({ actor, action: 'project.merge', target: keepId, detail: { merged: dropId } });
  return { ok: true, projectId: keepId };
}

export function splitLinks(store, projectId, linkIds, actor) {
  const p = store.get('projects', projectId); if (!p) return { ok: false, code: 404, error: 'not found' };
  const links = linkIds.map(id => store.get('projectLinks', id)).filter(l => l?.projectId === projectId);
  if (!links.length || links.length === store.list('projectLinks', l => l.projectId === projectId).length) return { ok: false, code: 400, error: 'choose some, but not all, linked records to split off' };
  const np = store.put('projects', { ...p, id: newProjectId(), siteKeys: [...(p.siteKeys || [])], firstSeenAt: now() });
  for (const l of links) { l.projectId = np.id; l.method = 'split by admin'; store.put('projectLinks', l); }
  store._coreIdx = null;
  recomputePhase(store, projectId); recomputePhase(store, np.id);
  store.audit({ actor, action: 'project.split', target: projectId, detail: { newProject: np.id, links: links.map(l => l.id) } });
  return { ok: true, projectId: np.id };
}

export function resolveReview(store, reviewId, projectId, actor) {
  const r = store.get('reviewQueue', reviewId); if (!r || r.status !== 'open') return { ok: false, code: 404, error: 'not found' };
  if (!r.candidates.includes(projectId)) return { ok: false, code: 400, error: 'choose one of the candidate projects' };
  store.put('projectLinks', { id: `${r.kind}:${r.refId}`, seq: nextLinkSeq(store), projectId, kind: r.kind, refId: r.refId, method: 'chosen in review', confidence: 'confirmed', sourceUrl: null, firstSeenAt: now(), lastSeenAt: now(), reviewedBy: actor });
  r.status = 'resolved'; r.resolution = projectId; r.resolvedBy = actor; r.resolvedAt = now(); store.put('reviewQueue', r);
  recomputePhase(store, projectId);
  return { ok: true };
}

// ---------- read model ----------
/** Full core record for one company, respecting territory and bid-package visibility. */
export function coreView(store, org, idIn) {
  const id = resolveProjectId(store, idIn);
  const p = id && store.get('projects', id);
  if (!p) return { ok: false, code: 404, error: 'project not found' };
  const links = store.list('projectLinks', l => l.projectId === id);
  const access = leadAccess(org);
  const invitedTo = rid => store.list('invitations', i => i.requestId === rid && i.sellerOrgId === org.id).length > 0 || store.get('bidRequests', rid)?.buyerOrgId === org.id;
  const inTerritory = access.ok && (access.states || []).includes(String(p.state || '').toUpperCase());
  const sees = links.filter(l => l.kind === 'bid_request' && invitedTo(l.refId));
  if (!inTerritory && !sees.length && org.subscription?.plan !== 'internal') return { ok: false, code: 404, error: 'project not found' };
  const visibleReq = new Set(sees.map(l => l.refId));
  const permits = links.filter(l => l.kind === 'permit').map(l => ({ link: l, p: store.get('permits', l.refId) })).filter(x => x.p)
    .map(({ link, p: pm }) => ({ id: pm.id, permitId: pm.permitId, status: pm.status, description: pm.description, valuation: pm.valuation || null, permitDate: pm.permitDate, sourceUrl: pm.sourceUrl, linkMethod: link.method, confidence: link.confidence }));
  const signals = links.filter(l => l.kind === 'land_use').map(l => store.get('signals', l.refId)).filter(Boolean).map(s => ({ id: s.id, file: s.file, title: s.title, status: s.status, introDate: s.introDate, url: s.url }));
  const packages = links.filter(l => l.kind === 'bid_request' && visibleReq.has(l.refId)).map(l => store.get('bidRequests', l.refId)).filter(Boolean)
    .map(r => ({ id: r.id, title: r.title, trades: r.trades, dueDate: r.dueDate, status: r.status, buyerName: r.buyerName, addendumCount: r.addendumCount || 0 }));
  const docs = links.filter(l => l.kind === 'document').map(l => store.get('documents', l.refId)).filter(d => d && visibleReq.has(d.requestId));
  return { ok: true, project: {
    id: p.id, aliasOf: idIn !== id ? idIn : undefined, name: p.name, phase: p.phase, address: p.address, city: p.city, state: p.state, lat: p.lat, lng: p.lng,
    projectType: p.projectType, estValue: p.estValue, buildingSf: p.buildingSf, firstSeenAt: p.firstSeenAt,
    phases: store.list('projectPhases', h => h.projectId === id).sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(h => ({ seq: h.seq, phase: h.phase, startedAt: h.startedAt, endedAt: h.endedAt, source: h.source })),
    companies: store.list('projectCompanies', c => c.projectId === id).map(c => ({ name: c.name, role: c.role, verified: c.verified, method: c.method, sourceKind: c.sourceKind, sourceRef: c.sourceRef, sourceUrl: c.sourceUrl,
      evidence: (c.evidence || []).map(e => ({ kind: e.kind, ref: c.role === 'trade_contractor' || e.kind !== 'contract' ? e.ref : null, method: e.method, verified: e.verified, url: e.url, firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt })), firstSeenAt: c.firstSeenAt, lastSeenAt: c.lastSeenAt })),
    permits, signals, bidPackages: packages, documents: docs.map(d => ({ id: d.id, name: d.name, sheet: d.sheet, discipline: d.discipline, addendum: d.addendum })),
    counts: { permits: permits.length, signals: signals.length, bidPackages: packages.length, documents: docs.length, contracts: links.filter(l => l.kind === 'contract').length },
  } };
}

/** GC project picker: names and addresses only (public permit information), one state at a time. */
export function pickProjects(store, { state, q }) {
  const st = String(state || '').toUpperCase(), ql = String(q || '').trim().toLowerCase();
  if (!/^[A-Z]{2}$/.test(st) || ql.length < 3) return [];
  return store.list('projects', p => p.state === st && `${p.name} ${p.address} ${p.city}`.toLowerCase().includes(ql)).slice(0, 10)
    .map(p => ({ id: p.id, name: p.name, address: p.address, city: p.city, state: p.state, phase: p.phase }));
}

/** In-memory search with the same result shape as the SQL search (used when storage is the JSON file). */
export function searchCoreMemory(store, { states, q, type, phase, minValue, limit = 50 }) {
  const ql = String(q || '').toLowerCase();
  return store.list('projects', p => (!states?.length || states.includes(p.state)) && (!ql || `${p.name} ${p.address}`.toLowerCase().includes(ql))
    && (!type || p.projectType === type) && (!phase || p.phase === phase) && (!minValue || (p.estValue || 0) >= Number(minValue)))
    .sort((a, b) => (b.estValue ?? -1) - (a.estValue ?? -1) || a.id.localeCompare(b.id)).slice(0, Math.min(200, Number(limit) || 50))
    .map(p => ({ id: p.id, name: p.name, phase: p.phase, address: p.address, city: p.city, state: p.state, projectType: p.projectType, estValue: p.estValue ?? null, buildingSf: p.buildingSf ? Math.round(p.buildingSf) : null, lat: p.lat ?? null, lng: p.lng ?? null }));
}
