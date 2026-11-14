// Super Admin Phase 3: global projects, duplicate review, corrections, bid/award oversight (read-only), document access.
// Reuses core.js for merge/split/review and planroom.entitled for access — no second implementation.
import { now } from '../store.js';
import { mergeProjects, splitLinks, resolveReview, resolveProjectId, recomputePhase } from '../core.js';
import { adminAudit } from './rbac.js';
import { paginate } from './service.js';

const fail = (code, error) => ({ ok: false, code, error });
const needReason = r => String(r || '').trim().length >= 5;
const qv = (q, k) => typeof q.get === 'function' ? q.get(k) : (Object.prototype.hasOwnProperty.call(q, k) ? q[k] : null);
const by = f => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0), byDesc = f => (a, b) => -by(f)(a, b);
const linksOf = (store, id) => store.list('projectLinks', l => l.projectId === id);

// ---------- projects ----------
function projectRow(store, p, links) {
  const ls = links || linksOf(store, p.id);
  const pkgs = ls.filter(l => l.kind === 'bid_request').map(l => store.get('bidRequests', l.refId)).filter(Boolean);
  return { id: p.id, name: p.name, address: p.address, city: p.city, state: p.state, phase: p.phase, status: p.status || 'active', projectType: p.projectType,
    permits: ls.filter(l => l.kind === 'permit').length, landUse: ls.filter(l => l.kind === 'land_use').length, packages: pkgs.length,
    openPackages: pkgs.filter(r => r.status === 'open').length, estValue: p.estValue ?? null, firstSeenAt: p.firstSeenAt, corrected: (p.corrections || []).length > 0 };
}
export function listProjects(store, q) {
  const f = k => qv(q, k) || '', text = f('q').toLowerCase();
  const byProject = new Map(); for (const l of store.list('projectLinks')) (byProject.get(l.projectId) || byProject.set(l.projectId, []).get(l.projectId)).push(l);
  const src = f('source') ? new Set(store.list('permits', x => x.permitId === f('source') || x.id === f('source')).map(x => store.get('projectLinks', 'permit:' + x.id)?.projectId)) : null;
  const rows = store.list('projects').map(p => projectRow(store, p, byProject.get(p.id) || [])).filter(r =>
    (!text || `${r.id} ${r.name} ${r.address} ${r.city}`.toLowerCase().includes(text)) && (!f('state') || r.state === f('state').toUpperCase())
    && (!f('phase') || r.phase === f('phase')) && (!f('status') || r.status === f('status')) && (!src || src.has(r.id)) && (f('hasPackages') !== 'true' || r.packages > 0));
  return paginate(rows, q, { name: by(r => String(r.name).toLowerCase()), newest: byDesc(r => r.firstSeenAt || ''), value: byDesc(r => r.estValue ?? -1), permits: byDesc(r => r.permits) }, 'newest');
}
export function projectAdminDetail(store, idIn) {
  const id = resolveProjectId(store, idIn); const p = id && store.get('projects', id);
  if (!p) return fail(404, 'project not found');
  const ls = linksOf(store, id);
  const permits = ls.filter(l => l.kind === 'permit').map(l => ({ link: l, x: store.get('permits', l.refId) })).filter(o => o.x)
    .map(({ link, x }) => ({ id: x.id, permitId: x.permitId, status: x.status, description: x.description, valuation: x.valuation ?? null, permitDate: x.permitDate, sourceId: x.sourceId, sourceUrl: x.sourceUrl, lastVerifiedAt: x.lastVerifiedAt || x.updatedAt, linkMethod: link.method, confidence: link.confidence, linkSeq: link.seq ?? null }));
  const packages = ls.filter(l => l.kind === 'bid_request').map(l => store.get('bidRequests', l.refId)).filter(Boolean).map(r => packageRow(store, r));
  return { ok: true, project: { ...projectRow(store, p, ls), aliases: store.list('projectAliases', a => a.projectId === id).map(a => a.id), siteKeys: p.siteKeys || [],
    permits, landUse: ls.filter(l => l.kind === 'land_use').map(l => store.get('signals', l.refId)).filter(Boolean).map(s => ({ id: s.id, file: s.file, title: s.title, url: s.url })),
    packages, documents: ls.filter(l => l.kind === 'document').length,
    companies: store.list('projectCompanies', c => c.projectId === id).map(c => ({ name: c.name, role: c.role, verified: c.verified, method: c.method, evidence: (c.evidence || []).length })),
    phases: store.list('projectPhases', h => h.projectId === id).sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(h => ({ phase: h.phase, startedAt: h.startedAt, endedAt: h.endedAt })),
    links: ls.map(l => ({ id: l.id, kind: l.kind, method: l.method, confidence: l.confidence, seq: l.seq ?? null })),
    corrections: p.corrections || [], statusReason: p.statusReason || null,
    activity: (store.data.audit || []).filter(a => a.target === id || a.target === `project:${id}`).slice(-50).reverse() } };
}

// ---------- duplicates: the ambiguity queue plus likely duplicates (same city, street number and street) ----------
const streetKey = a => { const m = String(a || '').toLowerCase().replace(/[.,#]/g, ' ').match(/^\s*(\d+)\s+(.+?)\s*(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|place|pl|court|ct)?(\s+(suite|ste|unit|bldg|building|fl|floor)\b.*)?$/);
  return m ? `${m[1]}|${m[2].replace(/\s+/g, ' ').trim()}` : null; };
export function duplicateCandidates(store, q) {
  const groups = new Map();
  for (const p of store.list('projects', p => p.status !== 'invalid')) { const k = streetKey(p.address); if (!k) continue; const key = `${p.state}|${String(p.city || '').toLowerCase()}|${k}`; (groups.get(key) || groups.set(key, []).get(key)).push(p); }
  const likely = [...groups.values()].filter(g => g.length > 1).map(g => ({ type: 'likely_duplicate', key: g.map(p => p.id).sort().join('+'), projects: g.map(p => projectRow(store, p)), reason: 'same city, street number and street' }));
  const queue = store.list('reviewQueue', r => r.status === 'open').map(r => ({ type: 'ambiguous_link', key: r.id, reviewId: r.id, record: `${r.kind} ${r.refId}`, projects: r.candidates.map(id => store.get('projects', id)).filter(Boolean).map(p => projectRow(store, p)), reason: r.reason }));
  return paginate([...queue, ...likely], q, { default: by(x => x.type === 'ambiguous_link' ? 0 : 1) }, 'default');
}
export function mergePreview(store, keepId, dropId) {
  const keep = store.get('projects', keepId), drop = store.get('projects', dropId);
  if (!keep || !drop || keepId === dropId) return fail(400, 'two different existing projects required');
  const ls = linksOf(store, dropId), count = k => ls.filter(l => l.kind === k).length;
  return { ok: true, keep: projectRow(store, keep), drop: projectRow(store, drop),
    moves: { permits: count('permit'), landUse: count('land_use'), packages: count('bid_request'), documents: count('document'), contracts: count('contract'),
      companies: store.list('projectCompanies', c => c.projectId === dropId).length },
    effects: [`${drop.id} becomes an alias of ${keep.id}; links to it keep working`, 'packages, bids, documents and awards stay attached to their records (only the project link moves)', 'the merge is recorded in the audit log; a wrong merge is undone with a split'] };
}
export function adminMerge(store, ctx, { keepId, dropId, reason }) {
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  const pv = mergePreview(store, keepId, dropId); if (!pv.ok) return pv;
  const r = mergeProjects(store, keepId, dropId, ctx.user.email); if (!r.ok) return r;
  adminAudit(store, ctx, { action: 'admin.project.merge', target: keepId, reason, before: { kept: pv.keep.id, dropped: pv.drop.id }, after: { projectId: keepId }, detail: { moved: pv.moves } });
  return { ok: true, projectId: keepId, moved: pv.moves };
}
export function adminSplit(store, ctx, id, { linkIds, reason }) {
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  const r = splitLinks(store, id, Array.isArray(linkIds) ? linkIds : [], ctx.user.email); if (!r.ok) return r;
  adminAudit(store, ctx, { action: 'admin.project.split', target: id, reason, after: { newProject: r.projectId, links: linkIds } });
  return r;
}
export function adminResolveReview(store, ctx, reviewId, { projectId, reason }) {
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  const r = resolveReview(store, reviewId, projectId, ctx.user.email); if (!r.ok) return r;
  adminAudit(store, ctx, { action: 'admin.project.review', target: projectId, reason, detail: { reviewId } });
  return r;
}
/** Typed corrections only (no arbitrary patch). The original value is kept; source permits are never edited. */
const CORRECTABLE = { name: v => String(v).trim().slice(0, 200), projectType: v => ['office', 'retail', 'warehouse', 'industrial', 'multifamily', 'medical', 'education', 'hospitality', 'restaurant', 'institutional', 'mixed_use', 'other_commercial'].includes(v) ? v : null };
export function resolveProject(store, ctx, id, { action, field, value, status, reason }) {
  const p = store.get('projects', resolveProjectId(store, id) || ''); if (!p) return fail(404, 'project not found');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (action === 'correct') {
    if (!CORRECTABLE[field]) return fail(400, `correctable fields: ${Object.keys(CORRECTABLE).join(', ')}`);
    const v = CORRECTABLE[field](value); if (v == null || v === '') return fail(400, 'invalid value');
    if (p[field] === v) return fail(409, 'no change');
    const from = p[field] ?? null;
    p.corrections = [...(p.corrections || []), { field, from, to: v, reason, by: ctx.user.email, at: now() }]; p[field] = v; store.put('projects', p);
    adminAudit(store, ctx, { action: 'admin.project.correct', target: p.id, reason, before: { [field]: from }, after: { [field]: v } });
    return { ok: true, project: projectRow(store, p) };
  }
  if (action === 'status') {
    if (!['active', 'stale', 'invalid'].includes(status)) return fail(400, 'status must be active, stale or invalid');
    if ((p.status || 'active') === status) return fail(409, 'no change');
    const before = p.status || 'active'; p.status = status; p.statusReason = status === 'active' ? null : reason; store.put('projects', p);
    adminAudit(store, ctx, { action: 'admin.project.status', target: p.id, reason, before: { status: before }, after: { status } });
    return { ok: true, project: projectRow(store, p) };
  }
  return fail(400, 'action must be correct or status');
}

// ---------- bid / award oversight (read-only) ----------
function packageRow(store, r) {
  const inv = store.list('invitations', i => i.requestId === r.id), subs = store.list('submissions', s => s.requestId === r.id);
  return { id: r.id, title: r.title, publisher: r.buyerName, publisherOrgId: r.buyerOrgId, status: r.status, dueDate: r.dueDate, trades: r.trades || [], distribution: r.distribution || 'eligible',
    publicationId: r.publicationId || null, invited: inv.length, opened: inv.filter(i => i.viewedAt).length, willBid: inv.filter(i => i.intent === 'will_bid').length,
    bids: subs.length, late: subs.filter(s => Date.parse(s.submittedAt || s.createdAt) > Date.parse(r.dueDate + 'T23:59:59Z')).length, addenda: r.addendumCount || 0, awarded: r.status === 'awarded', createdAt: r.createdAt };
}
export function listPackages(store, q) {
  const f = k => qv(q, k) || '', text = f('q').toLowerCase();
  const rows = store.list('bidRequests').map(r => packageRow(store, r)).filter(r => (!text || `${r.title} ${r.publisher} ${r.id}`.toLowerCase().includes(text)) && (!f('status') || r.status === f('status')) && (!f('publisherOrgId') || r.publisherOrgId === f('publisherOrgId')));
  return paginate(rows, q, { due: by(r => r.dueDate || ''), newest: byDesc(r => r.createdAt || ''), bids: byDesc(r => r.bids) }, 'newest');
}
export function packageDetail(store, id) {
  const r = store.get('bidRequests', id); if (!r) return fail(404, 'package not found');
  const org = oid => { const o = store.get('orgs', oid); return o?.legal?.name || o?.name || oid; };
  const cutoff = Date.parse(r.dueDate + 'T23:59:59Z');
  const contract = store.list('contracts', c => c.requestId === id)[0] || null;
  return { ok: true, package: { ...packageRow(store, r), description: r.description, inclusions: r.inclusions || null, exclusions: r.exclusions || null,
    projectId: store.get('projectLinks', 'bid_request:' + id)?.projectId || null,
    invitations: store.list('invitations', i => i.requestId === id).map(i => ({ company: org(i.sellerOrgId), orgId: i.sellerOrgId, intent: i.intent, invitedAt: i.invitedAt, viewedAt: i.viewedAt || null, via: i.via || 'match', acknowledgedAddenda: i.acknowledgedAddenda ?? null })),
    // Read-only: originals exactly as submitted (amount, time, receipt, fingerprint). No edit route exists.
    submissions: store.list('submissions', s => s.requestId === id).map(s => ({ id: s.id, company: org(s.sellerOrgId), amount: s.total ?? null, revision: s.revision ?? null, submittedAt: s.submittedAt || s.createdAt, late: Date.parse(s.submittedAt || s.createdAt) > cutoff, receipt: s.receiptId || null, sha256: s.sha256 || null, status: s.status || 'submitted' })),
    documents: store.list('documents', d => d.requestId === id).map(d => docRow(store, d)),
    award: contract ? { contractId: contract.id, company: contract.sellerName, total: contract.total, signedAt: contract.signedAt || contract.createdAt, signer: contract.signerName || null } : null } };
}

// ---------- documents ----------
function docRow(store, d) {
  const r = store.get('bidRequests', d.requestId) || {};
  return { id: d.id, name: d.name, sheet: d.sheet || null, discipline: d.discipline, packageId: d.requestId, package: r.title || null, publisher: r.buyerName || null,
    revision: d.addendum ? `Addendum ${d.addendum}` : 'Original', size: d.size || null, sha256: d.sha256 || null, uploadedAt: d.uploadedAt,
    validation: 'PDF signature checked at upload', malwareScan: 'not scanned — no scanner configured', storage: 'server disk (R2 not connected)',
    state: d.removed ? 'removed' : d.quarantined ? 'quarantined' : 'available', revokedCompanies: (r.revokedOrgs || []).length };
}
export function listDocuments(store, q) {
  const f = k => qv(q, k) || '', text = f('q').toLowerCase();
  const rows = store.list('documents').map(d => docRow(store, d)).filter(r => (!text || `${r.name} ${r.package} ${r.publisher}`.toLowerCase().includes(text)) && (!f('state') || r.state === f('state')) && (!f('packageId') || r.packageId === f('packageId')));
  return paginate(rows, q, { newest: byDesc(r => r.uploadedAt || ''), name: by(r => String(r.name).toLowerCase()) }, 'newest');
}
export function documentDetail(store, id) {
  const d = store.get('documents', id); if (!d) return fail(404, 'document not found');
  const r = store.get('bidRequests', d.requestId) || {};
  const org = oid => { const o = store.get('orgs', oid); return o?.legal?.name || o?.name || oid; };
  return { ok: true, document: { ...docRow(store, d),
    canView: [{ company: org(r.buyerOrgId), orgId: r.buyerOrgId, basis: 'publisher (uploaded the package)' },
      ...store.list('invitations', i => i.requestId === d.requestId).map(i => ({ company: org(i.sellerOrgId), orgId: i.sellerOrgId, basis: (r.revokedOrgs || []).includes(i.sellerOrgId) ? 'REVOKED by BUILDINTEL' : 'invited bidder' }))],
    accessHistory: (store.data.audit || []).filter(a => a.target === id && /doc|document/.test(a.action)).slice(-50).reverse(),
    quarantine: d.quarantined ? { reason: d.quarantineReason, by: d.quarantinedBy, at: d.quarantinedAt } : null } };
}
/** Revoke (or restore) one company's access to a package's plans. Checked again whenever a link is opened. */
export function setPackageAccess(store, ctx, packageId, { orgId, revoke, reason }) {
  const r = store.get('bidRequests', packageId); if (!r) return fail(404, 'package not found');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (orgId === r.buyerOrgId) return fail(409, 'the publisher cannot be cut off from its own package');
  const set = new Set(r.revokedOrgs || []);
  if (revoke ? set.has(orgId) : !set.has(orgId)) return fail(409, revoke ? 'access already revoked' : 'access is not revoked');
  revoke ? set.add(orgId) : set.delete(orgId); r.revokedOrgs = [...set]; store.put('bidRequests', r);
  adminAudit(store, ctx, { action: revoke ? 'admin.document.access.revoke' : 'admin.document.access.restore', target: packageId, orgId, reason, detail: { company: orgId } });
  return { ok: true, revokedOrgs: r.revokedOrgs };
}
export function setQuarantine(store, ctx, docId, { quarantine, reason }) {
  const d = store.get('documents', docId); if (!d) return fail(404, 'document not found');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (!!d.quarantined === !!quarantine) return fail(409, quarantine ? 'already quarantined' : 'not quarantined');
  if (quarantine) Object.assign(d, { quarantined: true, quarantineReason: reason, quarantinedBy: ctx.user.email, quarantinedAt: now() });
  else { d.quarantined = false; d.releasedBy = ctx.user.email; d.releasedAt = now(); }
  store.put('documents', d);
  adminAudit(store, ctx, { action: quarantine ? 'admin.document.quarantine' : 'admin.document.release', target: docId, reason });
  return { ok: true, document: docRow(store, d) };
}

// ---------- trades & markets ----------
export function tradesAndMarkets(store) {
  const subs = store.list('orgs', o => o.kind !== 'buyer' && Array.isArray(o.trades));
  const trades = {}, states = {};
  for (const o of subs) { for (const t of o.trades) trades[t] = (trades[t] || 0) + 1; for (const s of o.territories || []) states[s] = (states[s] || 0) + 1; }
  const projects = {}; for (const p of store.list('projects')) projects[p.state || '—'] = (projects[p.state || '—'] || 0) + 1;
  return { asOf: now(), trades: Object.entries(trades).sort((a, b) => b[1] - a[1]).map(([trade, companies]) => ({ trade, companies })),
    markets: [...new Set([...Object.keys(states), ...Object.keys(projects)])].sort().map(st => ({ state: st, subscriberCompanies: states[st] || 0, projects: projects[st] || 0 })) };
}
export { recomputePhase };
