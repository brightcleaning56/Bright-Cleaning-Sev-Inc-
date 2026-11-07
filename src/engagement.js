import { config } from './config.js';
import { now } from './store.js';
import { outboundIssues, buildFollowUp, sendEmail } from './outbound.js';
import { validateContact, normName } from './domain.js';
import { parseCsv } from './sources/adapters.js';

const DAY = 864e5;

// ---------------- Follow-ups ----------------
/** Exactly one follow-up per email bid, after followUpDays, unless the GC replied or opted out. */
export async function sendFollowUps(store, org, { fetchImpl } = {}) {
  const stats = { sent: 0, skipped: 0 };
  const days = org.settings?.followUpDays ?? 5;
  if (!days || config.emailMode !== 'live' || !org.settings?.liveSending) return stats;
  const due = store.tlist('bids', org.id, b => b.channel !== 'marketplace' && ['sent', 'delivered', 'opened'].includes(b.status)
    && !b.followUpSentAt && !b.replies?.length && Date.now() - Date.parse(b.history?.find(h => h.to === 'sent')?.at || b.updatedAt) >= days * DAY);
  for (const bid of due) {
    const opp = store.tget('opportunities', org.id, bid.opportunityId);
    const permit = store.get('permits', opp.permitId);
    const proposal = store.tget('proposals', org.id, bid.proposalId);
    let any = false;
    for (const c of bid.recipientIds.map(id => store.get('contacts', id)).filter(Boolean)) {
      if (outboundIssues(store, org, c, { ...proposal, deadline: null }).length) { stats.skipped++; continue; }
      const r = await sendEmail(buildFollowUp(org, c, permit, bid), { fetchImpl });
      if (r.ok && r.messageId) { any = true; store.put('messages', { orgId: org.id, bidId: bid.id, contactId: c.id, messageId: r.messageId, kind: 'follow_up', dryRun: false, sentAt: now() }); }
    }
    bid.followUpSentAt = now(); // mark even on skip so a bid is never chased twice
    bid.followUpResult = any ? 'sent' : 'skipped';
    store.tput('bids', org.id, bid);
    store.audit({ actor: 'autopilot', orgId: org.id, action: 'bid.follow_up', target: bid.id, detail: { sent: any } });
    if (any) stats.sent++;
  }
  return stats;
}

// ---------------- Inbound replies (Postmark inbound webhook) ----------------
const STOP_WORDS = /\b(unsubscribe|remove me|stop emailing|take me off|do not contact|opt[- ]?out)\b/i;

export function handleInbound(store, msg) {
  const bidId = msg.MailboxHash || (msg.To || '').match(/\+([^@]+)@/)?.[1];
  const bid = bidId ? store.findBidAnyTenant(bidId) : null;
  const from = (msg.FromFull?.Email || msg.From || '').toLowerCase();
  if (STOP_WORDS.test(`${msg.Subject} ${msg.StrippedTextReply || msg.TextBody || ''}`) && from) {
    store.suppressEverywhere(from, 'reply asked to stop', 'inbound_reply');
  }
  if (!bid) return { ok: false, reason: 'no matching bid' };
  bid.replies ||= [];
  bid.replies.push({ from, subject: String(msg.Subject || '').slice(0, 300), text: String(msg.StrippedTextReply || msg.TextBody || '').slice(0, 5000), at: now() });
  bid.needsAttention = true;
  store.tput('bids', bid.orgId, bid);
  store.audit({ actor: from || 'inbound', orgId: bid.orgId, action: 'bid.reply', target: bid.id });
  return { ok: true, bidId: bid.id };
}

// ---------------- Retention ----------------
/** Enforces the retention schedule in docs/policies/privacy.md. Safe to run every cycle. */
export function runRetention(store) {
  const t = Date.now(); const out = { sessions: 0, previews: 0, staleContacts: 0, closedRequests: 0 };
  for (const s of store.list('sessions', s => Date.parse(s.expiresAt) < t)) { store.remove('sessions', s.id); out.sessions++; }
  for (const m of store.list('messages', m => m.dryRun && t - Date.parse(m.createdAt) > 90 * DAY)) { store.remove('messages', m.id); out.previews++; }
  for (const c of store.list('contacts', c => !['outdated', 'opted_out'].includes(c.status) && t - Date.parse(c.verifiedAt || c.updatedAt) > 730 * DAY)) {
    c.status = 'outdated'; store.put('contacts', c); out.staleContacts++;
  }
  for (const r of store.list('bidRequests', r => r.status === 'open' && Date.parse(r.dueDate) + 30 * DAY < t)) {
    r.status = 'expired'; store.put('bidRequests', r); out.closedRequests++;
  }
  for (const j of store.list('jobs', j => j.type === 'cycle' && t - Date.parse(j.createdAt) > 30 * DAY)) store.remove('jobs', j.id);
  return out;
}

// ---------------- Analytics ----------------
export function analytics(store, orgId) {
  const bids = store.tlist('bids', orgId);
  const opps = store.tlist('opportunities', orgId);
  const by = k => bids.filter(b => b.status === k);
  const sum = arr => Math.round(arr.reduce((s, b) => s + (b.total || 0), 0) * 100) / 100;
  const won = by('awarded'), lost = by('lost');
  const outstanding = bids.filter(b => ['sent', 'delivered', 'opened'].includes(b.status));
  const channel = ch => { const b = bids.filter(x => (x.channel || 'email') === ch); const w = b.filter(x => x.status === 'awarded').length; const d = b.filter(x => ['awarded', 'lost'].includes(x.status)).length; return { bids: b.length, won: w, decided: d, winRate: d ? Math.round((w / d) * 100) : null }; };
  return {
    opportunities: { total: opps.length, ...Object.fromEntries(['qualified', 'bid_drafted', 'needs_contact', 'needs_measurement', 'rejected'].map(s => [s, opps.filter(o => o.status === s).length])) },
    bids: Object.fromEntries(['pending_approval', 'approved', 'sent', 'delivered', 'opened', 'awarded', 'lost', 'failed', 'withdrawn'].map(s => [s, by(s).length])),
    value: { awaitingApproval: sum(by('pending_approval')), outstanding: sum(outstanding), won: sum(won), lost: sum(lost) },
    winRate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : null,
    needsAttention: bids.filter(b => b.needsAttention).length,
    byChannel: { email: channel('email'), marketplace: channel('marketplace') },
  };
}

// ---------------- GC directory ----------------
/**
 * Bulk import. CSV columns: company,website,companyEvidenceUrl,contactName,role,email,phone,status,evidenceUrl
 * Each row validated like the single-contact API; bad rows are reported, never half-saved.
 */
export function importDirectory(store, csvText, actor) {
  const rows = parseCsv(csvText);
  const out = { rows: rows.length, companies: 0, contacts: 0, errors: [] };
  rows.forEach((r, i) => {
    if (!r.company) { out.errors.push({ row: i + 2, errors: ['company required'] }); return; }
    const key = normName(r.company);
    let co = store.list('companies', c => c.normName === key)[0];
    const contact = r.contactName || r.email ? { name: r.contactName || r.role || 'Estimating', role: r.role || null, email: r.email || null, phone: r.phone || null, status: r.status || 'unverified', evidenceUrl: r.evidenceUrl || r.companyEvidenceUrl || null } : null;
    if (contact) {
      const errs = validateContact({ ...contact, companyId: co?.id || 'pending' });
      if (errs.length) { out.errors.push({ row: i + 2, errors: errs }); return; }
      if (contact.email && store.list('contacts', c => (c.email || '').toLowerCase() === contact.email.toLowerCase()).length) { out.errors.push({ row: i + 2, errors: ['email already in directory'] }); return; }
    }
    if (!co) { co = store.put('companies', { name: r.company, normName: key, website: r.website || null, kind: 'general_contractor', evidenceUrl: r.companyEvidenceUrl || null }); out.companies++; }
    if (contact) {
      if (store.isSuppressed(contact.email)) contact.status = 'opted_out';
      store.put('contacts', { ...contact, companyId: co.id, verifiedAt: ['verified', 'source_confirmed'].includes(contact.status) ? now() : null });
      out.contacts++;
    }
  });
  store.audit({ actor, action: 'directory.import', detail: { ...out, errors: out.errors.length } });
  return out;
}

/** Which contractors to add next: ranked by the bid value currently blocked on a missing contact. */
export function directoryGaps(store, orgId) {
  const groups = new Map();
  for (const o of store.tlist('opportunities', orgId, o => o.status === 'needs_contact')) {
    const p = store.get('permits', o.permitId); if (!p) continue;
    const name = p.contractorOnPermit || '(no contractor on permit)';
    const g = groups.get(name) || { contractor: name, projects: 0, blockedValue: 0, cities: new Set(), reason: o.contactReason };
    g.projects++; g.blockedValue += o.estimate?.total || 0; g.cities.add(p.city);
    groups.set(name, g);
  }
  return [...groups.values()].map(g => ({ ...g, blockedValue: Math.round(g.blockedValue * 100) / 100, cities: [...g.cities] }))
    .sort((a, b) => b.blockedValue - a.blockedValue);
}

/** Once a contact is added, put blocked opportunities back in the queue for the next cycle. */
export function requeueNeedsContact(store) {
  let n = 0;
  for (const org of store.list('orgs', o => o.status === 'active' && o.kind !== 'buyer')) {
    for (const o of store.tlist('opportunities', org.id, o => o.status === 'needs_contact')) { o.status = 'qualified'; delete o.contactReason; store.tput('opportunities', org.id, o); n++; }
  }
  return n;
}
