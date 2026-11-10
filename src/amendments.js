// Contract amendments. The buyer proposes a change to an awarded contract (price and/or scope) with a reason and signs the
// proposal. Nothing changes until the awarded company accepts it with its own signature. Either side may withdraw or
// decline. The original proposal is never edited; each amendment is kept with its signatures in the contract record.
import crypto from 'node:crypto';
import { now } from './store.js';
import { consentText, CONSENT_VERSION } from './marketplace.js';
import { can } from './publishing.js';

const fail = (code, error) => Object.assign(new Error(error), { code });
const OPEN = ['fully_signed'];
const sha = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const sig = (who, org, user, { signerName, consent, ip, userAgent }) => {
  if (!signerName || String(signerName).trim().length < 3) throw fail(400, 'type your full name to sign');
  if (consent !== true) throw fail(400, 'consent to electronic records and signatures is required');
  return { signerName: String(signerName).trim().slice(0, 120), signerEmail: user.email, signerUserId: user.id, onBehalfOf: org.name,
    consentText: consentText(org.name), consentVersion: CONSENT_VERSION, ip: ip || null, userAgent: String(userAgent || '').slice(0, 300), at: now() };
};

export function proposeAmendment(store, buyerOrg, user, contractId, body = {}, ctx = {}) {
  const c = store.get('contracts', contractId);
  if (!c || c.buyerOrgId !== buyerOrg.id) throw fail(404, 'not found');
  if (!can(user, 'award')) throw fail(403, 'no permission to change an awarded contract');
  if (!OPEN.includes(c.status)) throw fail(409, 'this contract cannot be amended now');
  const list = c.amendments || [];
  if (list.some(a => a.status === 'pending')) throw fail(409, 'an amendment is already waiting for the provider; withdraw it first');
  const changes = [];
  if (body.total !== undefined && body.total !== null && body.total !== '') {
    const to = Number(body.total);
    if (!Number.isFinite(to) || to <= 0) throw fail(400, 'the new price must be a positive amount');
    if (to !== Number(c.total)) changes.push({ field: 'total', from: Number(c.total), to });
  }
  const scope = String(body.scope || '').trim().slice(0, 4000);
  if (scope) changes.push({ field: 'scope', to: scope });
  if (!changes.length) throw fail(400, 'change the price or the scope');
  const reason = String(body.reason || '').trim().slice(0, 1000);
  if (reason.length < 10) throw fail(400, 'give the provider a reason for the change (at least 10 characters)');
  const proposed = sig('buyer', buyerOrg, user, { ...body, ...ctx });
  const amendment = { id: crypto.randomUUID(), number: list.length + 1, changes, reason, status: 'pending', proposed, proposedAt: proposed.at };
  c.amendments = [...list, amendment];
  store.put('contracts', c);
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'contract.amend.propose', target: c.id, detail: { amendment: amendment.number, changes: changes.map(x => x.field) } });
  return { ok: true, contract: c, amendment };
}

function pendingOf(c, amendmentId) {
  const a = (c.amendments || []).find(x => x.id === amendmentId);
  if (!a) throw fail(404, 'amendment not found');
  if (a.status !== 'pending') throw fail(409, `this amendment is already ${a.status}`);
  return a;
}

export function acceptAmendment(store, sellerOrg, user, contractId, amendmentId, body = {}, ctx = {}) {
  const c = store.get('contracts', contractId);
  if (!c || c.sellerOrgId !== sellerOrg.id) throw fail(404, 'not found');
  if (!can(user, 'award')) throw fail(403, 'only the owner or an award manager can accept a change');
  const a = pendingOf(c, amendmentId);
  const accepted = sig('seller', sellerOrg, user, { ...body, ...ctx });
  const total = a.changes.find(x => x.field === 'total');
  if (total) c.total = total.to;
  a.status = 'accepted'; a.acceptance = accepted; a.acceptedAt = accepted.at;
  a.documentSha256 = sha({ changes: a.changes, reason: a.reason, proposed: a.proposed, accepted });
  c.amendedAt = accepted.at;
  store.put('contracts', c);
  store.audit({ actor: user.email, orgId: sellerOrg.id, action: 'contract.amend.accept', target: c.id, detail: { amendment: a.number, sha256: a.documentSha256 } });
  return { ok: true, contract: c, amendment: a };
}

export function declineAmendment(store, sellerOrg, user, contractId, amendmentId, body = {}) {
  const c = store.get('contracts', contractId);
  if (!c || c.sellerOrgId !== sellerOrg.id) throw fail(404, 'not found');
  if (!can(user, 'award')) throw fail(403, 'only the owner or an award manager can decline a change');
  const a = pendingOf(c, amendmentId);
  const reason = String(body.reason || '').trim().slice(0, 1000);
  if (reason.length < 5) throw fail(400, 'say why the change is declined');
  a.status = 'declined'; a.decline = { reason, by: user.email, at: now() };
  store.put('contracts', c);
  store.audit({ actor: user.email, orgId: sellerOrg.id, action: 'contract.amend.decline', target: c.id, detail: { amendment: a.number } });
  return { ok: true, contract: c, amendment: a };
}

export function withdrawAmendment(store, buyerOrg, user, contractId, amendmentId) {
  const c = store.get('contracts', contractId);
  if (!c || c.buyerOrgId !== buyerOrg.id) throw fail(404, 'not found');
  if (!can(user, 'award')) throw fail(403, 'no permission');
  const a = pendingOf(c, amendmentId);
  a.status = 'withdrawn'; a.withdrawnAt = now();
  store.put('contracts', c);
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'contract.amend.withdraw', target: c.id, detail: { amendment: a.number } });
  return { ok: true, contract: c, amendment: a };
}

// What both parties see about amendments, without signature internals beyond names and times.
export const amendmentView = a => ({ id: a.id, number: a.number, status: a.status, changes: a.changes, reason: a.reason,
  proposedBy: a.proposed?.signerName, proposedAt: a.proposedAt, acceptedBy: a.acceptance?.signerName || null, acceptedAt: a.acceptedAt || null,
  declinedReason: a.decline?.reason || null, documentSha256: a.documentSha256 || null });
