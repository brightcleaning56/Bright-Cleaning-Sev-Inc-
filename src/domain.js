import { now } from './store.js';

// ---------------- Opportunity matching ----------------
export function scoreOpportunity(org, permit, estimate) {
  const s = org.settings || {};
  const reasons = []; const blockers = []; let score = 0;
  const cov = (s.coverage || []).map(c => c.toLowerCase());
  const place = `${(permit.city || '').toLowerCase()}, ${(permit.state || '').toLowerCase()}`;
  if (cov.some(c => place.startsWith(c) || c === (permit.state || '').toLowerCase())) { score += 30; reasons.push('in service area'); }
  else blockers.push('outside service area');
  if (!s.projectTypes?.length || s.projectTypes.includes(permit.projectType)) { score += 15; reasons.push(`project type ${permit.projectType}`); }
  else blockers.push(`project type ${permit.projectType} not targeted`);
  if (permit.cleaningRelevant) { score += 15; reasons.push('scope ends in a clean'); } else blockers.push('work type does not require cleaning');
  if (['issued', 'approved'].includes(permit.status)) { score += 15; reasons.push(`permit ${permit.status}`); }
  else if (permit.status === 'applied') score += 5;
  else blockers.push(`permit ${permit.status}`);
  if (permit.squareFeet) { score += 10; reasons.push('square footage reported'); }
  if (estimate.total > 0) {
    if (estimate.total >= (s.minContract || 0)) { score += 15; reasons.push(`estimate $${estimate.total.toLocaleString()}`); }
    else blockers.push(`estimate below minimum contract $${s.minContract}`);
  }
  return { score, reasons, blockers };
}

// ---------------- Contacts ----------------
export const CONTACT_STATUSES = ['verified', 'source_confirmed', 'probable', 'unverified', 'outdated', 'opted_out'];
export const SENDABLE = new Set(['verified', 'source_confirmed']);

export const normName = n => String(n || '').toLowerCase()
  .replace(/\b(inc|llc|co|corp|corporation|company|ltd|lc|construction|constructors|builders|general contractors?)\b\.?/g, '')
  .replace(/[^a-z0-9]/g, '');

const PERSONAL_DOMAINS = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|proton(mail)?)\./i;

export function validateContact(c) {
  const e = [];
  if (!c.companyId) e.push('companyId required');
  if (!c.name) e.push('name required');
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) e.push('invalid email');
  if (c.email && PERSONAL_DOMAINS.test(c.email) && !c.publishedForBusiness) e.push('personal email domain: only allowed if the person publishes it for business use');
  if (!CONTACT_STATUSES.includes(c.status)) e.push('invalid status');
  if (SENDABLE.has(c.status) && !c.evidenceUrl) e.push('verified/source_confirmed contacts need an evidenceUrl');
  if (c.evidenceUrl && !/^https?:\/\//i.test(String(c.evidenceUrl))) e.push('evidenceUrl must be an http(s) link');
  if (c.homeAddress || c.ssn || c.dob) e.push('personal data fields are not allowed');
  return e;
}

/** Resolve sendable recipients for a permit. Never fabricates a contact. */
export function resolveRecipients(store, permit) {
  if (!permit.contractorOnPermit) return { recipients: [], reason: 'no contractor named on permit' };
  const key = normName(permit.contractorOnPermit);
  const company = store.list('companies', c => c.normName === key)[0];
  if (!company) return { recipients: [], reason: `contractor "${permit.contractorOnPermit}" not in GC directory` };
  const contacts = store.list('contacts', c => c.companyId === company.id && c.email);
  const ok = contacts.filter(c => SENDABLE.has(c.status) && !store.isSuppressed(c.email));
  const preferred = ok.filter(c => /estimat|precon|project manager|bid/i.test(c.role || ''));
  const recipients = (preferred.length ? preferred : ok).slice(0, 2);
  return { company, recipients, reason: recipients.length ? null : 'no verified, non-suppressed contact on file' };
}

// ---------------- Bid state machine ----------------
export const BID_TRANSITIONS = {
  draft: ['pending_approval', 'withdrawn'],
  pending_approval: ['approved', 'draft', 'withdrawn'],
  approved: ['sending', 'withdrawn'],
  sending: ['sent', 'failed'],
  sent: ['delivered', 'failed', 'rejected', 'withdrawn', 'awarded', 'lost'],
  delivered: ['opened', 'rejected', 'withdrawn', 'awarded', 'lost'],
  opened: ['withdrawn', 'awarded', 'lost'],
  failed: ['draft'],
  rejected: [], withdrawn: [], awarded: [], lost: [],
};

export function transition(store, bid, to, actor, detail = null) {
  const allowed = BID_TRANSITIONS[bid.status] || [];
  if (!allowed.includes(to)) throw new Error(`illegal bid transition ${bid.status} -> ${to}`);
  bid.history ||= [];
  bid.history.push({ from: bid.status, to, at: now(), actor, detail });
  bid.status = to;
  store.tput('bids', bid.orgId, bid);
  store.audit({ actor, orgId: bid.orgId, action: `bid.${to}`, target: bid.id, detail });
  return bid;
}
