// Project Publishing: verified publishers (owners, developers, GCs, CMs, agencies, authorized design teams) publish a
// project with several trade packages. Draft → checklist → publish → close → archive. Packages are bid requests, so plan
// rooms, addenda, planholders, leveling and e-signed awards all apply. A discovered permit is never a bid opportunity:
// bidding opens only when a verified publisher releases a package.
import { now } from './store.js';
import { createRequest, openPackageInvites, inviteCompanies, TRADES } from './marketplace.js';
import { publicationAllowance } from './entitlements.js';
import { linkBidRequest, linkBidRequestTo, recomputePhase, resolveProjectId } from './core.js';

export const PERMISSIONS = ['publish', 'upload', 'invite', 'award', 'billing', 'users'];
const MEMBER_DEFAULT = ['upload', 'invite'];
export const can = (user, perm) => user?.role === 'owner' || user?.role === 'platform_owner' || (user?.permissions || MEMBER_DEFAULT).includes(perm);

// Relationship of the publisher to the project. Declaration is enough for these (the company itself is verified);
// the others publish on someone else's behalf and must attach evidence of authorization.
export const RELATIONSHIPS = { owner: 'Owner', developer: 'Developer', gc_of_record: 'General contractor of record', property_manager: 'Property manager for the owner',
  construction_manager: 'Construction manager (for the owner)', architect_for_owner: 'Architect/engineer authorized by the owner', agent_for_owner: 'Other agent authorized by the owner' };
const NEEDS_EVIDENCE = new Set(['construction_manager', 'architect_for_owner', 'agent_for_owner']);
const defaultRelationship = kind => ({ owner: 'owner', public_agency: 'owner', developer: 'developer', general_contractor: 'gc_of_record', property_manager: 'property_manager', construction_manager: 'construction_manager', architect_engineer: 'architect_for_owner' }[kind] || 'gc_of_record');

// ---------- publisher verification (BUILDINTEL staff decide; an email address is not proof of authority) ----------
export const isVerifiedPublisher = org => org?.subscription?.plan === 'internal' || org?.publisher?.status === 'verified';
export function requestVerification(store, org, user, b) {
  if (org.kind !== 'buyer') return { ok: false, code: 403, error: 'publisher accounts only' };
  if (org.publisher?.status === 'verified') return { ok: false, code: 409, error: 'already verified' };
  const evidence = { website: String(b.website || '').slice(0, 300), licenseNumber: String(b.licenseNumber || '').slice(0, 80), phone: String(b.phone || '').slice(0, 40), notes: String(b.notes || '').slice(0, 2000),
    contactName: String(b.contactName || '').trim().slice(0, 120), title: String(b.title || '').trim().slice(0, 120) };
  if (!evidence.website && !evidence.licenseNumber) return { ok: false, code: 400, error: 'give a company website or a license/registration number we can check' };
  if (evidence.website && !/^https?:\/\//i.test(evidence.website)) return { ok: false, code: 400, error: 'website must be an http(s) link' };
  const history = [...(org.publisher?.history || []), { event: org.publisher?.status === 'rejected' ? 'resubmitted' : 'requested', at: now(), by: user.email }];
  org.publisher = { status: 'pending', evidence, requestedAt: now(), requestedBy: user.email, history }; store.put('orgs', org);
  store.audit({ actor: user.email, orgId: org.id, action: 'publisher.request' });
  return { ok: true, publisher: org.publisher };
}
export function decideVerification(store, admin, orgId, { status, note }) {
  const org = store.get('orgs', orgId);
  if (!org || org.kind !== 'buyer') return { ok: false, code: 404, error: 'not found' };
  if (!['verified', 'rejected'].includes(status)) return { ok: false, code: 400, error: 'status must be verified or rejected' };
  if (!String(note || '').trim()) return { ok: false, code: 400, error: 'record how it was checked (e.g. "license verified on state register")' };
  const at = now(); const note2 = String(note).slice(0, 1000);
  const history = [...(org.publisher?.history || []), { event: status, at, by: admin.email, note: note2 }];
  org.publisher = { ...(org.publisher || {}), status, decidedBy: admin.email, decidedAt: at, note: note2, history }; store.put('orgs', org);
  store.audit({ actor: admin.email, orgId, action: 'publisher.' + status, detail: { note } });
  return { ok: true, publisher: org.publisher };
}

// ---------- publications ----------
const own = (store, org, id) => { const p = store.get('publications', id); return p && p.publisherOrgId === org.id ? p : null; };
const hist = (p, status, by, note) => { p.statusHistory = [...(p.statusHistory || []), { status, at: now(), by, ...(note ? { note } : {}) }]; p.status = status; };
const TYPES = ['office', 'retail', 'warehouse', 'industrial', 'multifamily', 'medical', 'education', 'hospitality', 'restaurant', 'institutional', 'mixed_use', 'other_commercial'];

export function createPublication(store, org, user, b) {
  if (org.kind !== 'buyer') return { ok: false, code: 403, error: 'publisher accounts only' };
  if (!can(user, 'publish')) return { ok: false, code: 403, error: 'your company has not given you permission to publish' };
  const e = [];
  if (!String(b.title || '').trim()) e.push('project name required');
  if (!b.address || !b.city || !/^[A-Za-z]{2}$/.test(String(b.state || ''))) e.push('address, city and 2-letter state required');
  if (!TYPES.includes(b.projectType)) e.push('choose a project type');
  const relationship = b.relationship || defaultRelationship(org.buyerKind);
  if (!RELATIONSHIPS[relationship]) e.push('choose your relationship to the project');
  if (NEEDS_EVIDENCE.has(relationship) && !String(b.authorizationEvidence || '').trim()) e.push('publishing on the owner\'s behalf: describe or link the authorization (e.g. owner letter, contract reference)');
  if (b.projectId && !resolveProjectId(store, b.projectId)) e.push('linked project not found');
  if (e.length) return { ok: false, code: 400, error: e.join('; ') };
  const p = store.put('publications', { publisherOrgId: org.id, publisherName: org.name, title: String(b.title).slice(0, 200), address: b.address, city: b.city, state: String(b.state).toUpperCase(),
    projectType: b.projectType, description: String(b.description || '').slice(0, 4000), estValue: Number(b.estValue) || null, buildingSf: Number(b.buildingSf) || null,
    schedule: { start: b.scheduleStart || null, completion: b.scheduleCompletion || null }, team: { owner: b.owner || null, developer: b.developer || null, architect: b.architect || null, gc: b.gc || null },
    authority: { relationship, onBehalfOf: b.onBehalfOf || null, evidence: b.authorizationEvidence || null, declaredBy: user.email, declaredAt: now() },
    projectId: b.projectId ? resolveProjectId(store, b.projectId) : null, status: 'draft', statusHistory: [{ status: 'draft', at: now(), by: user.email }], createdBy: user.email });
  store.audit({ actor: user.email, orgId: org.id, action: 'publication.create', target: p.id });
  return { ok: true, publication: p };
}

export function addPackage(store, org, user, pubId, b) {
  const p = own(store, org, pubId); if (!p) return { ok: false, code: 404, error: 'not found' };
  if (!can(user, 'publish')) return { ok: false, code: 403, error: 'no permission to publish' };
  if (!['draft', 'published'].includes(p.status)) return { ok: false, code: 409, error: `publication is ${p.status}` };
  const r = createRequest(store, org, user, { ...b, address: p.address, city: p.city, state: p.state, projectType: p.projectType, title: b.title || p.title },
    { draft: true, publicationId: p.id });
  if (!r.ok) return { ok: false, code: 400, error: (r.errors || []).join('; ') };
  return { ok: true, package: r.request };
}

/** What still blocks publishing. Every item must pass. */
export function checklist(store, org, p) {
  const pkgs = store.list('bidRequests', r => r.publicationId === p.id);
  const drafts = pkgs.filter(r => r.status === 'draft');
  const allow = publicationAllowance(store, org);
  const items = [
    { key: 'verified', label: 'Company verified as a publisher', ok: isVerifiedPublisher(org), detail: org.publisher?.status ? `status: ${org.publisher.status}` : 'request verification first' },
    { key: 'authority', label: 'Authority to publish recorded', ok: !!p.authority?.relationship && (!NEEDS_EVIDENCE.has(p.authority.relationship) || (!!p.authority.evidence && p.authority.review === 'approved')),
      detail: (RELATIONSHIPS[p.authority?.relationship] || '') + (NEEDS_EVIDENCE.has(p.authority?.relationship) ? ` — owner authorization ${p.authority.review === 'approved' ? 'approved by BUILDINTEL' : p.authority.review === 'rejected' ? 'rejected: ' + (p.authority.reviewNote || '') : 'waiting for BUILDINTEL review'}` : '') },
    { key: 'packages', label: 'At least one trade package', ok: pkgs.length > 0, detail: `${pkgs.length} package(s)` },
    ...drafts.map(r => {
      const docs = store.list('documents', d => d.requestId === r.id && !d.removed).length;
      const problems = [];
      if (!(Date.parse(r.dueDate) > Date.now())) problems.push('due date is past');
      if (String(r.description || '').trim().length < 20) problems.push('scope needs a description (20+ characters)');
      if (r.distribution === 'invite_only' && !(r.invitees || []).length) problems.push('invite-only package has no invitees');
      if (!docs && !r.noDocuments) problems.push('no documents (upload plans or mark "no documents for this package")');
      return { key: 'pkg:' + r.id, label: `Package "${r.title}"`, ok: !problems.length, detail: problems.join('; ') || `${docs} document(s), ${r.distribution === 'invite_only' ? (r.invitees || []).length + ' invitee(s)' : 'eligible subscribers + ' + (r.invitees || []).length + ' invited'}` };
    }),
    ...(p.status === 'draft' ? [{ key: 'plan', label: 'Plan allows another active project', ok: allow.ok, detail: `${allow.active} of ${allow.limit} on ${allow.plan}` }] : []),
  ];
  return { ready: items.every(i => i.ok), items };
}

export function publish(store, org, user, pubId) {
  const p = own(store, org, pubId); if (!p) return { ok: false, code: 404, error: 'not found' };
  if (!can(user, 'publish')) return { ok: false, code: 403, error: 'no permission to publish' };
  if (!['draft', 'published'].includes(p.status)) return { ok: false, code: 409, error: `publication is ${p.status}` };
  const c = checklist(store, org, p);
  if (!c.ready) return { ok: false, code: 409, error: 'not ready: ' + c.items.filter(i => !i.ok).map(i => `${i.label} (${i.detail})`).join('; '), checklist: c };
  let invited = 0; const opened = [];
  for (const r of store.list('bidRequests', r => r.publicationId === p.id && r.status === 'draft')) {
    r.status = 'open'; r.publishedAt = now(); store.put('bidRequests', r);
    invited += openPackageInvites(store, r); opened.push(r.id);
    const l = p.projectId ? linkBidRequestTo(store, r, p.projectId) : linkBidRequest(store, r);
    if (l.projectId && !p.projectId) p.projectId = l.projectId;
    if (l.projectId) recomputePhase(store, l.projectId);
  }
  if (p.status !== 'published') { hist(p, 'published', user.email); p.publishedAt = now(); }
  store.put('publications', p);
  store.audit({ actor: user.email, orgId: org.id, action: 'publication.publish', target: p.id, detail: { packages: opened.length, invited } });
  return { ok: true, publication: p, packagesOpened: opened.length, invited };
}

export function setStatus(store, org, user, pubId, status) {
  const p = own(store, org, pubId); if (!p) return { ok: false, code: 404, error: 'not found' };
  const allowed = { draft: ['archived'], published: ['closed'], closed: ['archived', 'published'] }[p.status] || [];
  if (!allowed.includes(status)) return { ok: false, code: 409, error: `cannot go from ${p.status} to ${status}` };
  if (!can(user, 'publish')) return { ok: false, code: 403, error: 'no permission' };
  if (status === 'closed') for (const r of store.list('bidRequests', r => r.publicationId === p.id && r.status === 'open')) { r.status = 'closed'; store.put('bidRequests', r); }
  if (status === 'published') for (const r of store.list('bidRequests', r => r.publicationId === p.id && r.status === 'closed' && Date.parse(r.dueDate) > Date.now())) { r.status = 'open'; store.put('bidRequests', r); }
  hist(p, status, user.email); store.put('publications', p);
  store.audit({ actor: user.email, orgId: org.id, action: 'publication.' + status, target: p.id });
  return { ok: true, publication: p };
}

/** Publisher dashboard: per-package coverage. */
export function coverage(store, org, pubId) {
  const p = own(store, org, pubId); if (!p) return null;
  const packages = store.list('bidRequests', r => r.publicationId === p.id).map(r => {
    const inv = store.list('invitations', i => i.requestId === r.id);
    const docs = store.list('documents', d => d.requestId === r.id && !d.removed);
    const item = checklist(store, org, p).items.find(i => i.key === 'pkg:' + r.id);
    return { id: r.id, title: r.title, status: r.status, trades: r.trades, dueDate: r.dueDate, distribution: r.distribution, addenda: r.addendumCount || 0,
      documents: docs.length, documentsState: docs.length ? 'uploaded' : r.noDocuments ? (r.docsLater ? 'to_follow' : 'intentionally_none') : 'missing',
      currentRevision: docs.length ? (r.addendumCount ? `Addendum ${r.addendumCount}` : 'Original') : null, inviteeCount: (r.invitees || []).length,
      blockers: r.status === 'draft' && item && !item.ok ? item.detail : null,
      invited: inv.length, openedPlans: inv.filter(i => i.viewedAt).length, willBid: inv.filter(i => i.intent === 'will_bid').length, wontBid: inv.filter(i => i.intent === 'wont_bid').length,
      bids: new Set(store.list('submissions', s => s.requestId === r.id).map(s => s.sellerOrgId)).size, awarded: r.status === 'awarded' };
  });
  const sum = k => packages.reduce((n, x) => n + x[k], 0);
  return { publication: p, checklist: checklist(store, org, p), packages, totals: { packages: packages.length, invited: sum('invited'), openedPlans: sum('openedPlans'), willBid: sum('willBid'), bids: sum('bids') } };
}

/** Bidder directory for publishers: subscriber companies by trade and state (names and trades only). */
export function searchBidders(store, { q, trade, state }) {
  const ql = String(q || '').toLowerCase(), st = String(state || '').toUpperCase();
  return store.list('orgs', o => o.kind !== 'buyer' && o.status === 'active' && Array.isArray(o.trades) && o.trades.length
    && (!ql || String(o.legal?.name || o.name).toLowerCase().includes(ql)) && (!trade || o.trades.includes(trade)) && (!st || (o.territories || []).includes(st) || o.subscription?.plan === 'internal'))
    .slice(0, 50).map(o => ({ id: o.id, name: o.legal?.name || o.name, trades: o.trades, states: (o.territories || []).slice(0, 10) }));
}

export { TRADES };

// ---------- market status: is this a bid opportunity, and can THIS company bid? ----------
export function marketStatus(store, projectId, org) {
  const pr = projectId && store.get('projects', projectId);
  if (!pr) return { status: 'discovered', label: 'Discovered', canBid: false, explanation: 'Found in public records. Not a bid opportunity — no publisher has opened bidding.' };
  const reqs = store.list('projectLinks', l => l.projectId === projectId && l.kind === 'bid_request').map(l => store.get('bidRequests', l.refId)).filter(Boolean);
  const open = reqs.filter(r => r.status === 'open' && Date.parse(r.dueDate) > Date.now());
  if (open.length) {
    const mine = open.filter(r => store.list('invitations', i => i.requestId === r.id && i.sellerOrgId === org?.id).length);
    const due = open.map(r => r.dueDate).sort()[0];
    return { status: 'open_for_bids', label: 'Open for bids', canBid: mine.length > 0, packages: open.length, nextDue: due,
      explanation: mine.length ? `You're invited to ${mine.length} of ${open.length} open package(s). Bids due from ${String(due).slice(0, 10)}.`
        : `${open.length} package(s) open, but your company isn't invited. Invitations go to companies whose trades and territory match (or the publisher's list).` };
  }
  const drafts = store.list('publications', p => p.projectId === projectId && p.status === 'draft' && p.publisherOrgId === org?.id);
  if (drafts.length) return { status: 'pre_bid', label: 'Pre-bid (your draft)', canBid: false, explanation: 'Your publication is still a draft. Nothing is visible to bidders until you publish.' };
  if (reqs.length && reqs.every(r => r.status === 'awarded')) return { status: 'awarded', label: 'Awarded', canBid: false, explanation: 'All published packages have been awarded.' };
  if (reqs.some(r => ['open', 'closed', 'awarded'].includes(r.status))) return { status: 'bidding_closed', label: 'Bidding closed', canBid: false, explanation: 'Published packages are closed or past their due date.' };
  if (pr.phase === 'planning') return { status: 'planning', label: 'Planning', canBid: false, explanation: 'Early development signal (land-use filing). No bidding yet.' };
  return { status: 'discovered', label: 'Discovered', canBid: false, explanation: 'Found in public records. Not a bid opportunity — no publisher has opened bidding.' };
}

/** One-step post (single package): same rules as the full workflow — verified publisher, permission, checklist. */
export function quickPublish(store, org, user, b) {
  const pub = createPublication(store, org, user, { ...b, title: b.title, relationship: b.relationship });
  if (!pub.ok) return pub;
  const pk = addPackage(store, org, user, pub.publication.id, { ...b, description: b.description || b.title + ' — see posting details', noDocuments: true });
  if (!pk.ok) { store.remove('publications', pub.publication.id); return pk; }
  const r = store.get('bidRequests', pk.package.id); r.noDocuments = true; r.docsLater = true; store.put('bidRequests', r);   // plans can be added right after posting
  const out = publish(store, org, user, pub.publication.id);
  if (!out.ok) { for (const x of store.list('bidRequests', x => x.publicationId === pub.publication.id)) store.remove('bidRequests', x.id); store.remove('publications', pub.publication.id); return out; }
  return { ok: true, request: store.get('bidRequests', pk.package.id), publicationId: pub.publication.id, invited: out.invited };
}

// ---------- scheduled publication ----------
// A draft can be set to publish at a future time. The periodic job publishes it as the person who scheduled it.
// If the publish cannot happen (for example the checklist is no longer complete), the schedule is cleared and the
// reason is kept on the draft, so the job does not retry every cycle.
export function schedulePublication(store, org, user, pubId, publishAt) {
  const p = own(store, org, pubId); if (!p) return { ok: false, code: 404, error: 'not found' };
  if (!can(user, 'publish')) return { ok: false, code: 403, error: 'no permission to publish' };
  if (p.status !== 'draft') return { ok: false, code: 409, error: 'only a draft can be scheduled' };
  const at = Date.parse(publishAt);
  if (!(at > Date.now())) return { ok: false, code: 400, error: 'choose a time in the future' };
  if (at > Date.now() + 365 * 864e5) return { ok: false, code: 400, error: 'schedule within a year' };
  p.scheduledFor = new Date(at).toISOString(); p.scheduledBy = user.email; p.scheduleError = null;
  store.put('publications', p);
  store.audit({ actor: user.email, orgId: org.id, action: 'publication.schedule', target: p.id, detail: { publishAt: p.scheduledFor } });
  return { ok: true, scheduledFor: p.scheduledFor };
}

export function unschedulePublication(store, org, user, pubId) {
  const p = own(store, org, pubId); if (!p) return { ok: false, code: 404, error: 'not found' };
  if (!p.scheduledFor) return { ok: false, code: 409, error: 'this draft is not scheduled' };
  p.scheduledFor = null; p.scheduledBy = null; store.put('publications', p);
  store.audit({ actor: user.email, orgId: org.id, action: 'publication.unschedule', target: p.id });
  return { ok: true };
}

export function publishDue(store, { at = Date.now() } = {}) {
  const due = store.list('publications', p => p.status === 'draft' && p.scheduledFor && Date.parse(p.scheduledFor) <= at);
  const out = [];
  for (const p of due) {
    const org = store.get('orgs', p.publisherOrgId);
    const user = store.list('users', u => u.email === p.scheduledBy && u.orgId === p.publisherOrgId && !u.disabled)[0];
    const r = !org || !user ? { ok: false, error: 'the person who scheduled this can no longer publish' } : publish(store, org, user, p.id);
    const fresh = store.get('publications', p.id);
    if (fresh) { fresh.scheduledFor = null; fresh.scheduleError = r.ok ? null : r.error; store.put('publications', fresh); }
    out.push({ id: p.id, ok: !!r.ok, error: r.ok ? null : r.error });
  }
  return out;
}

/** Publisher Command Center: counts across every project this company publishes. Read-only. */
export function publisherSummary(store, org, { at = Date.now() } = {}) {
  const pubs = store.list('publications', p => p.publisherOrgId === org.id);
  const pubIds = new Set(pubs.map(p => p.id));
  const reqs = store.list('bidRequests', r => r.buyerOrgId === org.id && (!r.publicationId || pubIds.has(r.publicationId)));
  const reqIds = new Set(reqs.map(r => r.id));
  const invitations = store.list('invitations', i => i.buyerOrgId === org.id && reqIds.has(i.requestId)).length;
  const subs = store.list('submissions', s => reqIds.has(s.requestId));
  const open = reqs.filter(r => r.status === 'open');
  const horizon = at + 14 * 864e5;
  const upcoming = open.filter(r => Date.parse(r.dueDate) >= at - 864e5 && Date.parse(r.dueDate) <= horizon)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .slice(0, 5).map(r => ({ id: r.id, title: r.title, dueDate: r.dueDate, publicationId: r.publicationId || null }));
  return {
    projects: { total: pubs.length, draft: pubs.filter(p => p.status === 'draft').length, published: pubs.filter(p => p.status === 'published').length,
      closed: pubs.filter(p => p.status === 'closed').length, archived: pubs.filter(p => p.status === 'archived').length },
    activePackages: open.length,
    invitationsSent: invitations,
    bidsReceived: subs.length,
    awardsPending: open.filter(r => subs.some(s => s.requestId === r.id)).length,
    upcomingDeadlines: upcoming,
  };
}
