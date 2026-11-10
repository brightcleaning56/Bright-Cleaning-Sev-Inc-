// Two-sided side of BUILDINTEL. GCs and property managers ("buyers") post bid requests;
// subscriber companies' autopilots price them from approved rate cards and submit proposals
// straight into the buyer's inbox. The buyer asked for these bids, so delivery is internal and
// confirmed — no cold email, no DNS dependency.
import crypto from 'node:crypto';
import { now } from './store.js';
import { activeRateCards, estimateOpportunity, CATEGORIES } from './estimate.js';
import { scoreOpportunity, transition } from './domain.js';
import { renderProposal } from './outbound.js';
import { PROJECT_TYPES } from './permits.js';
import { credentialBlockers, proposalCredentialText } from './credentials.js';

export const BUYER_KINDS = ['general_contractor', 'construction_manager', 'developer', 'owner', 'property_manager', 'architect_engineer', 'public_agency'];

// Trades a GC can request and a subscriber can offer (CSI-style, plain names).
export const TRADES = [
  ['general_contracting', 'General contracting'], ['demolition', 'Demolition'], ['sitework', 'Site work & excavation'], ['concrete', 'Concrete'],
  ['masonry', 'Masonry'], ['steel', 'Structural & misc. steel'], ['carpentry', 'Framing & carpentry'], ['roofing', 'Roofing'],
  ['waterproofing', 'Waterproofing & insulation'], ['glazing', 'Doors, windows & glazing'], ['drywall', 'Drywall & ceilings'], ['flooring', 'Flooring'],
  ['painting', 'Painting & coatings'], ['specialties', 'Specialties & signage'], ['elevators', 'Elevators'], ['fire_protection', 'Fire protection'],
  ['plumbing', 'Plumbing'], ['hvac', 'HVAC / mechanical'], ['electrical', 'Electrical'], ['low_voltage', 'Low voltage, data & security'],
  ['landscaping', 'Landscaping'], ['paving', 'Paving & striping'], ['cleaning', 'Construction cleaning'], ['janitorial', 'Janitorial & facility services'],
];
const TRADE_KEYS = new Set(TRADES.map(([k]) => k));
const httpUrl = u => !u || /^https?:\/\//i.test(String(u));
const QUALIFY_SCORE = 70;

export function validateRequest(b) {
  const e = [];
  if (!b.title) e.push('title required');
  if (!b.address || !b.city || !b.state) e.push('address, city and state required');
  const trades = Array.isArray(b.trades) ? b.trades : [];
  if (!trades.length && !(Array.isArray(b.services) && b.services.length)) e.push('choose at least one trade');
  if (trades.some(t => !TRADE_KEYS.has(t))) e.push('unknown trade');
  if (!PROJECT_TYPES.includes(b.projectType)) e.push(`projectType must be one of ${PROJECT_TYPES.join(', ')}`);
  if (b.services !== undefined && b.services !== null && (!Array.isArray(b.services) || b.services.some(s => !CATEGORIES.includes(s)))) e.push(`services must be a list from ${CATEGORIES.join(', ')}`);
  // Square footage is only required when the request asks for automatic cleaning pricing.
  if (b.services?.length && !(Number(b.squareFeet) > 0)) e.push('squareFeet is required for cleaning pricing');
  if (b.squareFeet !== undefined && b.squareFeet !== null && b.squareFeet !== '' && !(Number(b.squareFeet) > 0)) e.push('squareFeet must be a positive number');
  if (!b.dueDate || Number.isNaN(Date.parse(b.dueDate)) || Date.parse(b.dueDate) < Date.now()) e.push('dueDate must be a future date');
  if (b.services?.includes('janitorial') && !(Number(b.frequencyPerMonth) > 0)) e.push('janitorial requests need frequencyPerMonth');
  if (!httpUrl(b.documentsUrl)) e.push('documentsUrl must be an http(s) link');
  return e;
}

export function createRequest(store, buyerOrg, user, b, opts = {}) {
  if (buyerOrg.kind !== 'buyer') throw new Error('only buyer accounts can post requests');
  if (buyerOrg.status !== 'active') throw new Error('verify your account before posting requests');
  const errors = validateRequest(b);
  if (errors.length) return { ok: false, errors };
  const r = store.put('bidRequests', {
    buyerOrgId: buyerOrg.id, buyerName: buyerOrg.name, buyerKind: buyerOrg.buyerKind, postedBy: user.email,
    title: String(b.title).slice(0, 200), description: String(b.description || '').slice(0, 4000),
    address: b.address, city: b.city, state: String(b.state).toUpperCase(), squareFeet: Number(b.squareFeet) || null,
    projectType: b.projectType, services: Array.isArray(b.services) && b.services.length ? b.services : null,
    trades: [...new Set([...(b.trades || []), ...((b.services || []).length ? ['cleaning'] : [])])],
    documentsUrl: b.documentsUrl || null, frequencyPerMonth: Number(b.frequencyPerMonth) || null,
    dueDate: b.dueDate, status: opts.draft ? 'draft' : 'open', awardedSubmissionId: null,
    publicationId: opts.publicationId || null, distribution: b.distribution === 'invite_only' ? 'invite_only' : 'eligible',
    invitees: Array.isArray(b.invitees) ? [...new Set(b.invitees.map(String))].slice(0, 500) : [],
    inclusions: b.inclusions ? String(b.inclusions).slice(0, 4000) : null, exclusions: b.exclusions ? String(b.exclusions).slice(0, 4000) : null,
    instructions: b.instructions ? String(b.instructions).slice(0, 4000) : null, contactName: b.contactName ? String(b.contactName).slice(0, 120) : null,
  });
  const invited = r.status === 'open' ? openPackageInvites(store, r) : 0;   // drafts invite nobody
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'request.create', target: r.id, detail: { invited } });
  return { ok: true, request: r, invited };
}

// ---------------- invitations to bid ----------------
/** Invite every active company whose trades and territory match. Safe to re-run: catches companies that join later. */
/** Invitations when a package opens: invite-only → the publisher's list; eligible → matching subscribers (+ the list). */
export function openPackageInvites(store, r) { return inviteCompanies(store, r, r.invitees || []) + (r.distribution === 'invite_only' ? 0 : inviteMatches(store, r)); }
export function inviteCompanies(store, r, orgIds) {
  let n = 0; const already = new Set(store.list('invitations', i => i.requestId === r.id).map(i => i.sellerOrgId));
  for (const id of orgIds) { const o = store.get('orgs', id); if (!o || o.kind === 'buyer' || o.id === r.buyerOrgId || already.has(id)) continue;
    store.put('invitations', { requestId: r.id, buyerOrgId: r.buyerOrgId, sellerOrgId: id, intent: 'undecided', invitedAt: now(), notifiedAt: null, viewedAt: null, via: 'publisher list', reason: "You were added by name to this company's invitee list." }); already.add(id); n++; }
  return n;
}
/** Plain-language reason for a match, so a subscriber can see why a project reached them. */
export function whyInvited(org, r) {
  const shared = (org.trades || []).filter(t => (r.trades || []).includes(t));
  const territory = org.subscription?.plan === 'internal' || org.subscription?.plan === 'national' ? 'nationwide coverage' : `your service area (${r.state})`;
  return `Matches your trades (${shared.join(', ') || 'none listed'}) and ${territory}.`;
}
export function inviteMatches(store, r) {
  if (r.status !== 'open' || r.distribution === 'invite_only') return 0;   // invite-only packages never auto-match
  const already = new Set(store.list('invitations', i => i.requestId === r.id).map(i => i.sellerOrgId));
  let n = 0;
  for (const org of store.list('orgs', o => o.kind !== 'buyer' && o.status !== 'pending_verification' && Array.isArray(o.trades) && o.trades.length)) {
    if (already.has(org.id) || org.id === r.buyerOrgId) continue;
    if (!org.trades.some(t => r.trades.includes(t))) continue;
    const states = org.subscription?.plan === 'internal' || org.subscription?.plan === 'national' ? null : (org.territories || []);
    if (states && !states.includes(r.state)) continue;
    store.put('invitations', { requestId: r.id, buyerOrgId: r.buyerOrgId, sellerOrgId: org.id, intent: 'undecided', invitedAt: now(), notifiedAt: null, viewedAt: null, reason: whyInvited(org, r) });
    n++;
  }
  return n;
}

export const INTENTS = ['undecided', 'will_bid', 'wont_bid'];
export function setIntent(store, org, user, invitationId, intent) {
  const inv = store.get('invitations', invitationId);
  if (!inv || inv.sellerOrgId !== org.id) return { ok: false, code: 404, error: 'not found' };
  if (!INTENTS.includes(intent)) return { ok: false, code: 400, error: `intent must be ${INTENTS.join('|')}` };
  inv.intent = intent; inv.intentAt = now(); inv.intentBy = user.email; store.put('invitations', inv);
  store.audit({ actor: user.email, orgId: org.id, action: 'invitation.intent', target: inv.id, detail: { intent } });
  return { ok: true, invitation: inv };
}

const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A subcontractor's own bid (any trade). Replaces their earlier bid on the same request until it's awarded. */
export function submitBid(store, org, user, invitationId, b) {
  const inv = store.get('invitations', invitationId);
  if (!inv || inv.sellerOrgId !== org.id) return { ok: false, code: 404, error: 'not found' };
  const r = store.get('bidRequests', inv.requestId);
  if (!r || r.status !== 'open') return { ok: false, code: 409, error: 'this request is no longer open' };
  if (Date.parse(r.dueDate) + 864e5 < Date.now()) return { ok: false, code: 409, error: 'the bid due date has passed' };
  if ((r.addendumCount || 0) > (inv.ackAddendum || 0)) return { ok: false, code: 409, error: `acknowledge addendum ${r.addendumCount} before bidding (open the plan room to review it)` };
  const amount = Number(String(b.amount ?? '').replace(/[$,\s]/g, ''));
  if (!(amount > 0)) return { ok: false, code: 400, error: 'amount must be a positive number' };
  if (!b.scope || String(b.scope).trim().length < 10) return { ok: false, code: 400, error: 'describe your scope (at least a sentence)' };
  if (!httpUrl(b.documentUrl)) return { ok: false, code: 400, error: 'documentUrl must be an http(s) link' };
  const legal = org.legal || {};
  const name = legal.name || org.name;
  const creds = proposalCredentialText(store, org);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bid — ${escH(r.title)}</title><style>body{font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:32px auto;color:#1d2731;line-height:1.5}.t{font-size:22px;font-weight:700}</style></head><body>
<h1>${escH(name)} — Bid</h1><p><strong>Project:</strong> ${escH(r.title)}<br><strong>Location:</strong> ${escH(r.address)}, ${escH(r.city)}, ${escH(r.state)}<br><strong>Prepared for:</strong> ${escH(r.buyerName)}</p>
<p class="t">$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}${b.recurring ? ' per month' : ''}</p>
<h3>Scope</h3><p>${escH(b.scope).replace(/\n/g, '<br>')}</p>${b.exclusions ? `<h3>Exclusions & assumptions</h3><p>${escH(b.exclusions).replace(/\n/g, '<br>')}</p>` : ''}
${b.documentUrl ? `<p>Supporting documents: <a href="${escH(b.documentUrl)}">${escH(b.documentUrl)}</a></p>` : ''}
${r.addendumCount ? `<p><strong>Acknowledges addenda 1–${r.addendumCount}.</strong></p>` : ''}<p style="font-size:12px;color:#555">${creds ? escH(creds) + '. ' : ''}Valid for ${Number(b.validDays) > 0 ? Number(b.validDays) : 30} days. Not a contract until accepted in writing.</p>
<p>${escH(name)}${legal.postalAddress ? '<br>' + escH(legal.postalAddress) : ''}${org.profile?.phone ? '<br>' + escH(org.profile.phone) : ''}<br>${escH(user.email)}</p></body></html>`;
  const prior = store.list('submissions', s => s.requestId === r.id && s.sellerOrgId === org.id && s.status === 'submitted')[0];
  const sub = store.put('submissions', { ...(prior || {}), requestId: r.id, buyerOrgId: r.buyerOrgId, sellerOrgId: org.id, bidId: prior?.bidId || null,
    sellerName: name, sellerEmail: user.email, total: amount, recurring: b.recurring ? 'monthly' : null, proposalHtml: html, submittedAt: now(), status: 'submitted',
    channel: 'manual', revision: (prior?.revision || 0) + 1,
    receiptId: 'R-' + crypto.randomBytes(5).toString('hex').toUpperCase(), sha256: crypto.createHash('sha256').update(html).digest('hex') });
  inv.intent = 'will_bid'; inv.submissionId = sub.id; inv.submittedAt = sub.submittedAt; store.put('invitations', inv);
  store.audit({ actor: user.email, orgId: org.id, action: prior ? 'bid.revise' : 'bid.submit', target: sub.id, detail: { requestId: r.id, amount } });
  return { ok: true, submission: { id: sub.id, total: sub.total, revision: sub.revision, submittedAt: sub.submittedAt, receiptId: sub.receiptId, sha256: sub.sha256 } };
}

// Shape a request like a permit so matching + estimating reuse the same engines.
const asProject = r => ({
  id: r.id, permitId: `REQ-${r.id.slice(-6).toUpperCase()}`, projectName: r.title, description: r.description || r.title,
  address: r.address, city: r.city, state: r.state, projectType: r.projectType, squareFeet: r.squareFeet,
  status: 'approved', cleaningRelevant: true, contractorOnPermit: r.buyerName, responseDeadline: r.dueDate, sourceUrl: null,
});

/** For one subscriber org: price every open request it qualifies for and queue a bid. */
export function draftMarketplaceBids(store, org) {
  const stats = { evaluated: 0, drafted: 0, autoApproved: 0 };
  const cards = activeRateCards(store, org.id);
  if (!cards.length || org.kind === 'buyer') return stats;
  if (credentialBlockers(store, org).length) return { ...stats, skipped: credentialBlockers(store, org)[0] };
  const done = new Set(store.tlist('opportunities', org.id, o => o.requestId).map(o => o.requestId));
  const a = org.settings?.autoApprove || {};
  for (const r of store.list('bidRequests', x => x.status === 'open' && x.services?.length && !done.has(x.id) && Date.parse(x.dueDate) > Date.now())) {
    stats.evaluated++;
    const p = asProject(r);
    const est = estimateOpportunity(cards, p, { categories: r.services, frequencyPerMonth: r.frequencyPerMonth });
    const m = scoreOpportunity(org, p, est);
    const qualified = !m.blockers.length && est.lines.length && m.score >= QUALIFY_SCORE;
    const opp = store.tput('opportunities', org.id, { requestId: r.id, permitId: null, project: p, status: qualified ? 'qualified' : 'rejected', score: m.score, reasons: m.reasons, blockers: est.lines.length ? m.blockers : [...m.blockers, 'no approved rate card for requested services'], estimate: est, channel: 'marketplace' });
    if (!qualified) continue;
    const rendered = renderProposal(org, p, est, { recipientCompany: r.buyerName, credentials: proposalCredentialText(store, org) });
    const proposal = store.tput('proposals', org.id, { opportunityId: opp.id, version: 1, ...rendered, deadline: r.dueDate });
    let bid = store.tput('bids', org.id, { opportunityId: opp.id, proposalId: proposal.id, requestId: r.id, channel: 'marketplace', recipientIds: [], total: rendered.total, recurring: est.recurring, status: 'draft' });
    bid = transition(store, bid, 'pending_approval', 'autopilot');
    opp.bidId = bid.id; opp.status = 'bid_drafted'; store.tput('opportunities', org.id, opp);
    stats.drafted++;
    if (a.enabled && rendered.total <= (a.maxTotal || 0) && m.score >= (a.minScore || 100)) {
      transition(store, bid, 'approved', 'autopilot', { rule: `auto-approve <= $${a.maxTotal}, score >= ${a.minScore}` }); stats.autoApproved++;
    }
  }
  return stats;
}

/** Deliver approved marketplace bids into the buyer's inbox. Delivery is confirmed by the write itself. */
export function dispatchMarketplaceBids(store, org) {
  const stats = { submitted: 0, failed: 0 };
  for (const bid of store.tlist('bids', org.id, b => b.status === 'approved' && b.channel === 'marketplace')) {
    transition(store, bid, 'sending', 'autopilot');
    const r = store.get('bidRequests', bid.requestId);
    const proposal = store.tget('proposals', org.id, bid.proposalId);
    if (!r || r.status !== 'open' || Date.parse(r.dueDate) < Date.now()) {
      transition(store, bid, 'failed', 'autopilot', { reason: !r ? 'request removed' : r.status !== 'open' ? `request ${r.status}` : 'past due date' }); stats.failed++; continue;
    }
    // The submission is the only thing the buyer can see: no costs, margins or rate cards.
    const sub = store.put('submissions', { requestId: r.id, buyerOrgId: r.buyerOrgId, sellerOrgId: org.id, bidId: bid.id,
      sellerName: org.legal?.name || org.name, sellerEmail: org.senderEmail || null, total: bid.total, recurring: bid.recurring || null,
      proposalHtml: proposal.html, submittedAt: now(), status: 'submitted' });
    const inv = store.list('invitations', i => i.requestId === r.id && i.sellerOrgId === org.id)[0];
    if (inv) { inv.intent = 'will_bid'; inv.submissionId = sub.id; inv.submittedAt = sub.submittedAt; store.put('invitations', inv); }
    transition(store, bid, 'sent', 'autopilot', { submissionId: sub.id });
    transition(store, bid, 'delivered', 'marketplace', { submissionId: sub.id, at: sub.submittedAt });
    stats.submitted++;
  }
  return stats;
}

export const CONSENT_VERSION = '2026-11-01';
export const consentText = company =>
  `I agree to conduct this transaction electronically and to use electronic records and signatures. I am authorized to accept this proposal on behalf of ${company}. I can download a copy of the accepted proposal and this record at any time.`;

/**
 * Buyer awards one submission with an electronic acceptance (ESIGN-style record: signer identity,
 * consent wording, time, IP, user agent, and a SHA-256 of the exact document accepted).
 * Winner's bid -> awarded, others -> lost, request closed, contract record created for both parties.
 */
export function awardRequest(store, buyerOrg, user, requestId, submissionId, acceptance = {}) {
  if (!acceptance.signerName || String(acceptance.signerName).trim().length < 3) throw Object.assign(new Error('signerName required: type your full name to sign'), { code: 400 });
  if (acceptance.consent !== true) throw Object.assign(new Error('consent to electronic records and signatures is required'), { code: 400 });
  const r = store.get('bidRequests', requestId);
  if (!r || r.buyerOrgId !== buyerOrg.id) throw Object.assign(new Error('not found'), { code: 404 });
  if (r.status !== 'open') throw Object.assign(new Error(`request already ${r.status}`), { code: 409 });
  const subs = store.list('submissions', s => s.requestId === r.id);
  const winner = subs.find(s => s.id === submissionId);
  if (!winner) throw Object.assign(new Error('submission not found'), { code: 404 });
  for (const s of subs) {
    s.status = s.id === winner.id ? 'awarded' : 'not_selected'; store.put('submissions', s);
    const bid = store.tget('bids', s.sellerOrgId, s.bidId);
    if (bid && ['delivered', 'opened', 'sent'].includes(bid.status)) transition(store, bid, s.id === winner.id ? 'awarded' : 'lost', `buyer:${user.email}`);
  }
  const signedAt = now();
  const contract = store.put('contracts', {
    requestId: r.id, submissionId: winner.id, bidId: winner.bidId, buyerOrgId: buyerOrg.id, sellerOrgId: winner.sellerOrgId,
    buyerName: buyerOrg.name, sellerName: winner.sellerName, title: r.title, address: `${r.address}, ${r.city}, ${r.state}`,
    total: winner.total, recurring: winner.recurring || null, proposalHtml: winner.proposalHtml,
    documentSha256: crypto.createHash('sha256').update(winner.proposalHtml).digest('hex'),
    acceptance: { signerName: String(acceptance.signerName).trim().slice(0, 120), signerEmail: user.email, signerUserId: user.id,
      onBehalfOf: buyerOrg.name, consentText: consentText(buyerOrg.name), consentVersion: CONSENT_VERSION,
      ip: acceptance.ip || null, userAgent: String(acceptance.userAgent || '').slice(0, 300), at: signedAt },
    status: 'accepted',
  });
  Object.assign(r, { status: 'awarded', awardedSubmissionId: winner.id, awardedAt: signedAt, contractId: contract.id }); store.put('bidRequests', r);
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'request.award', target: r.id, detail: { submissionId, contractId: contract.id, sha256: contract.documentSha256 } });
  return { request: r, contractId: contract.id, winner: { sellerName: winner.sellerName, sellerEmail: winner.sellerEmail, total: winner.total } };
}

// The awarded company countersigns the same contract. Its signature is kept separately from the buyer's,
// with its own consent and time, and the contract becomes fully signed once both have signed.
export function countersignContract(store, sellerOrg, user, contractId, acceptance = {}) {
  const c = store.get('contracts', contractId);
  if (!c || c.sellerOrgId !== sellerOrg.id) throw Object.assign(new Error('not found'), { code: 404 });
  if (c.countersignature) throw Object.assign(new Error('this contract is already countersigned'), { code: 409 });
  if (!acceptance.signerName || String(acceptance.signerName).trim().length < 3) throw Object.assign(new Error('type your full name to countersign'), { code: 400 });
  if (acceptance.consent !== true) throw Object.assign(new Error('consent to electronic records and signatures is required'), { code: 400 });
  c.countersignature = { signerName: String(acceptance.signerName).trim().slice(0, 120), signerEmail: user.email, signerUserId: user.id,
    onBehalfOf: sellerOrg.name, consentText: consentText(sellerOrg.name), consentVersion: CONSENT_VERSION,
    ip: acceptance.ip || null, userAgent: String(acceptance.userAgent || '').slice(0, 300), at: now() };
  c.status = 'fully_signed';
  store.put('contracts', c);
  store.audit({ actor: user.email, orgId: sellerOrg.id, action: 'contract.countersign', target: c.id, detail: { requestId: c.requestId } });
  return { ok: true, contract: c };
}

export function closeRequest(store, buyerOrg, user, requestId) {
  const r = store.get('bidRequests', requestId);
  if (!r || r.buyerOrgId !== buyerOrg.id) throw Object.assign(new Error('not found'), { code: 404 });
  if (r.status !== 'open') throw Object.assign(new Error(`request already ${r.status}`), { code: 409 });
  r.status = 'closed'; store.put('bidRequests', r);
  for (const s of store.list('submissions', s => s.requestId === r.id)) {
    s.status = 'not_selected'; store.put('submissions', s);
    const bid = store.tget('bids', s.sellerOrgId, s.bidId);
    if (bid && ['delivered', 'opened', 'sent'].includes(bid.status)) transition(store, bid, 'lost', `buyer:${user.email}`, { reason: 'request closed' });
  }
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'request.close', target: r.id });
  return r;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The downloadable signed record: accepted proposal + acceptance certificate + integrity check. */
export function contractDocument(c) {
  const intact = crypto.createHash('sha256').update(c.proposalHtml).digest('hex') === c.documentSha256;
  const a = c.acceptance;
  const cert = `<section style="font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:40px auto;border-top:3px solid #1d2731;padding-top:16px">
<h2>Electronic acceptance record</h2>
<table style="border-collapse:collapse;font-size:14px">${[
    ['Accepted by', `${esc(a.signerName)} (${esc(a.signerEmail)})`], ['On behalf of', esc(a.onBehalfOf)], ['Provider', esc(c.sellerName)],
    ['Project', `${esc(c.title)} — ${esc(c.address)}`], ['Amount', `$${Number(c.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}${c.recurring ? ' per month' : ''}`],
    ['Signed at (UTC)', esc(a.at)], ['IP address', esc(a.ip || 'not recorded')], ['Browser', esc(a.userAgent || 'not recorded')],
    ['Consent', esc(a.consentText) + ` (v${esc(a.consentVersion)})`],
    ...(c.countersignature ? [['Countersigned by', `${esc(c.countersignature.signerName)} (${esc(c.countersignature.signerEmail)}) for ${esc(c.countersignature.onBehalfOf)}`], ['Countersigned at (UTC)', esc(c.countersignature.at)], ['Countersignature consent', esc(c.countersignature.consentText) + ` (v${esc(c.countersignature.consentVersion)})`]] : [['Countersignature', 'awaiting the provider']]),
    ['Document SHA-256', `<code>${c.documentSha256}</code>`], ['Integrity check', intact ? 'Document unchanged since signing' : '<strong>DOCUMENT DOES NOT MATCH SIGNED HASH</strong>'],
  ].map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;vertical-align:top;color:#555;white-space:nowrap">${k}</td><td style="padding:6px 0">${v}</td></tr>`).join('')}</table></section>`;
  const amends = (c.amendments || []).map(x => `<tr><td style="padding:6px 0;vertical-align:top">#${x.number}</td><td style="padding:6px 0">${esc(x.status)} · ${x.changes.map(ch => ch.field === 'total' ? `price $${Number(ch.from).toLocaleString('en-US')} to $${Number(ch.to).toLocaleString('en-US')}` : 'scope: ' + esc(ch.to)).join('; ')}<br><small>Reason: ${esc(x.reason)}</small><br><small>Proposed by ${esc(x.proposed?.signerName)} at ${esc(x.proposedAt)}${x.acceptance ? ' · accepted by ' + esc(x.acceptance.signerName) + ' at ' + esc(x.acceptedAt) + ' · record SHA-256 ' + esc(x.documentSha256) : ''}${x.decline ? ' · declined: ' + esc(x.decline.reason) : ''}</small></td></tr>`).join('');
  const amendSection = amends ? `<section style="font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:24px auto"><h2>Amendments</h2><table style="border-collapse:collapse;font-size:14px;width:100%">${amends}</table><p><small>The original proposal above is unchanged. Only accepted amendments change the amount due.</small></p></section>` : '';
  return c.proposalHtml.replace('</body>', amendSection + cert + '</body>');
}
