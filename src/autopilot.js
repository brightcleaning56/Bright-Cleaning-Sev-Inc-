import { config } from './config.js';
import { now } from './store.js';
import { canCollect } from './sources/registry.js';
import { ADAPTERS } from './sources/adapters.js';
import { ingestPermits } from './permits.js';
import { activeRateCards, estimateOpportunity } from './estimate.js';
import { scoreOpportunity, resolveRecipients, transition } from './domain.js';
import { outboundIssues, renderProposal, buildEmail, sendEmail } from './outbound.js';
import { draftMarketplaceBids, dispatchMarketplaceBids, inviteMatches } from './marketplace.js';
import { sendFollowUps, runRetention } from './engagement.js';
import { credentialBlockers, proposalCredentialText } from './credentials.js';

const QUALIFY_SCORE = 70;
export const PERMIT_SERVICES = ['post_construction', 'windows', 'floor_care', 'pressure_washing'];

export async function collectSources(store, { fetchImpl, only } = {}) {   // only: one source id (admin retry)
  const results = [];
  const order = s => (s.adapter === 'license-socrata' ? 2 : ['legistar', 'signals-socrata'].includes(s.adapter) ? 1 : 0);
  for (const src of store.list('sources').sort((a, b) => order(a) - order(b))) {
    if (only && src.id !== only) continue;
    if (!src.enabled) continue;
    if (!canCollect(src)) { results.push({ source: src.key, skipped: 'not authorized' }); continue; }
    if (['license-socrata', 'legistar', 'signals-socrata'].includes(src.adapter)) {
      try {
        const { syncLicenses, syncLegistar, syncLandUseSignals } = await import('./enrichment.js');
        const fn = { legistar: syncLegistar, 'signals-socrata': syncLandUseSignals, 'license-socrata': syncLicenses }[src.adapter];
        const r = await fn(store, src, { fetchImpl });
        Object.assign(src, { lastSuccessAt: now(), lastError: null }); store.put('sources', src);
        store.put('jobs', { type: 'collect', sourceId: src.id, status: 'ok', result: r });
        results.push({ source: src.key, ...r });
      } catch (e) {
        Object.assign(src, { lastFailureAt: now(), lastError: e.message }); store.put('sources', src);
        store.put('jobs', { type: 'collect', sourceId: src.id, status: 'failed', error: e.message });   // failures belong in the import history too
        results.push({ source: src.key, error: e.message });
      }
      continue;
    }
    const adapter = ADAPTERS[src.adapter];
    if (!adapter) continue; // file_import sources are fed through the import endpoint
    try {
      const raw = await adapter(src, { since: src.adapter === 'socrata' ? src.syncCursor : src.lastRecordDate, fetchImpl });
      const r = ingestPermits(store, src, raw);
      const latest = raw.map(x => x.issuedDate || x.appliedDate).filter(Boolean).map(String).sort().pop();
      const cursor = raw.map(x => x._cursor).filter(Boolean).sort().pop();
      Object.assign(src, { lastSuccessAt: now(), lastError: null,
        lastRecordDate: latest && (!src.lastRecordDate || latest > src.lastRecordDate) ? latest : src.lastRecordDate,
        syncCursor: cursor || src.syncCursor || null });
      store.put('sources', src);
      store.put('jobs', { type: 'collect', sourceId: src.id, status: 'ok', result: r });
      results.push({ source: src.key, ...r });
    } catch (e) {
      Object.assign(src, { lastFailureAt: now(), lastError: e.message });
      store.put('sources', src);
      store.put('jobs', { type: 'collect', sourceId: src.id, status: 'failed', error: e.message });
      results.push({ source: src.key, error: e.message });
    }
  }
  return results;
}

export function qualifyForOrg(store, org) {
  const cards = activeRateCards(store, org.id);
  if (!cards.length) return { evaluated: 0, skipped: 'no approved rate cards — nothing is priced until the owner approves rates' };
  const credBlock = credentialBlockers(store, org);
  if (credBlock.length) return { evaluated: 0, skipped: credBlock[0] + ' — bidding paused until one is added' };
  const seen = new Set(store.tlist('opportunities', org.id).map(o => o.permitId));
  const stats = { evaluated: 0, qualified: 0, needsMeasurement: 0, rejected: 0 };
  for (const p of store.list('permits', p => p.commercial && !p.archived && !seen.has(p.id))) {
    stats.evaluated++;
    // A permit means construction is ending: price construction-clean services only, never recurring janitorial.
    const est = estimateOpportunity(cards, p, { categories: org.settings?.permitServices || PERMIT_SERVICES });
    const m = scoreOpportunity(org, p, est);
    m.blockers.push(...credBlock);
    let status = 'rejected';
    if (m.blockers.length === 0 && est.missing.includes('squareFeet') && !est.lines.length) status = 'needs_measurement';
    else if (m.blockers.length === 0 && est.lines.length && m.score >= QUALIFY_SCORE) status = 'qualified';
    stats[status === 'qualified' ? 'qualified' : status === 'needs_measurement' ? 'needsMeasurement' : 'rejected']++;
    store.tput('opportunities', org.id, { permitId: p.id, status, score: m.score, reasons: m.reasons, blockers: m.blockers, estimate: est });
  }
  return stats;
}

export function draftBids(store, org) {
  const stats = { drafted: 0, needsContact: 0, autoApproved: 0 };
  const a = org.settings?.autoApprove || {};
  for (const opp of store.tlist('opportunities', org.id, o => o.status === 'qualified' && !o.bidId)) {
    const permit = store.get('permits', opp.permitId);
    const { company, recipients, reason } = resolveRecipients(store, permit);
    if (!recipients.length) { opp.status = 'needs_contact'; opp.contactReason = reason; store.tput('opportunities', org.id, opp); stats.needsContact++; continue; }
    const rendered = renderProposal(org, permit, opp.estimate, { recipientCompany: company.name, credentials: proposalCredentialText(store, org) });
    const proposal = store.tput('proposals', org.id, { opportunityId: opp.id, version: 1, ...rendered, deadline: permit.responseDeadline || null });
    let bid = store.tput('bids', org.id, { opportunityId: opp.id, proposalId: proposal.id, recipientIds: recipients.map(r => r.id), total: rendered.total, status: 'draft' });
    bid = transition(store, bid, 'pending_approval', 'autopilot');
    opp.bidId = bid.id; opp.status = 'bid_drafted'; store.tput('opportunities', org.id, opp);
    stats.drafted++;
    if (a.enabled && rendered.total <= (a.maxTotal || 0) && opp.score >= (a.minScore || 100)) {
      transition(store, bid, 'approved', 'autopilot', { rule: `auto-approve <= $${a.maxTotal}, score >= ${a.minScore}` });
      stats.autoApproved++;
    }
  }
  return stats;
}

export async function dispatchBids(store, org, { fetchImpl } = {}) {
  const stats = { sent: 0, failed: 0, previewed: 0 };
  for (const bid of store.tlist('bids', org.id, b => b.status === 'approved' && b.channel !== 'marketplace')) {
    const proposal = store.tget('proposals', org.id, bid.proposalId);
    const opp = store.tget('opportunities', org.id, bid.opportunityId);
    const permit = store.get('permits', opp.permitId);
    const contacts = bid.recipientIds.map(id => store.get('contacts', id)).filter(Boolean);
    const issues = contacts.length ? contacts.flatMap(c => outboundIssues(store, org, c, proposal)) : ['no recipients'];

    if (config.emailMode !== 'live' || !org.settings?.liveSending) {
      // Dry-run: render exactly what would go out; the bid stays "approved". Never marked sent.
      for (const c of contacts) store.put('messages', { orgId: org.id, bidId: bid.id, dryRun: true, issues, preview: issues.length ? null : buildEmail(org, c, permit, proposal, bid.id) });
      bid.lastDryRunAt = now(); bid.lastDryRunIssues = issues; store.tput('bids', org.id, bid);
      stats.previewed++; continue;
    }
    transition(store, bid, 'sending', 'autopilot');
    if (issues.length) { transition(store, bid, 'failed', 'autopilot', { issues }); stats.failed++; continue; }
    const receipts = [];
    for (const c of contacts) {
      const r = await sendEmail(buildEmail(org, c, permit, proposal, bid.id), { fetchImpl });
      receipts.push({ contactId: c.id, ...r });
      if (r.ok) store.put('messages', { orgId: org.id, bidId: bid.id, contactId: c.id, messageId: r.messageId, dryRun: false, sentAt: now() });
    }
    const okReceipts = receipts.filter(r => r.ok && r.messageId);
    bid.receipts = receipts; bid.submittedCopyId = proposal.id;
    if (okReceipts.length) { transition(store, bid, 'sent', 'autopilot', { messageIds: okReceipts.map(r => r.messageId) }); stats.sent++; }
    else { transition(store, bid, 'failed', 'autopilot', { receipts }); stats.failed++; }
  }
  return stats;
}

// One pull at a time, shared by the hourly schedule and "run now", with a watchdog so a stuck pull can't block forever.
let cycleState = { running: false, startedAt: null };
export function cycleStatus() { return { ...cycleState }; }
export async function runCycleGuarded(store, opts = {}, { maxMinutes = 20 } = {}) {
  if (cycleState.running && Date.now() - Date.parse(cycleState.startedAt) < maxMinutes * 60e3) return { skipped: 'a pull is already running', since: cycleState.startedAt };
  cycleState = { running: true, startedAt: new Date().toISOString() };
  try {
    const r = await store.withLock('cycle', () => runCycle(store, opts));
    return r.ran ? r.result : { skipped: r.skipped };
  }
  catch (e) { store.put('jobs', { type: 'cycle', status: 'failed', error: e.message }); store.save(); throw e; }
  finally { cycleState = { running: false, startedAt: null }; }
}

export async function runCycle(store, opts = {}) {
  const started = now();
  const collect = await collectSources(store, opts);
  const orgs = [];
  for (const org of store.list('orgs', o => o.status === 'active' && o.kind !== 'buyer')) {
    orgs.push({ org: org.slug,
      qualify: qualifyForOrg(store, org), draft: draftBids(store, org),
      marketplace: { ...draftMarketplaceBids(store, org), ...dispatchMarketplaceBids(store, org) },
      dispatch: await dispatchBids(store, org, opts),
      followUps: await sendFollowUps(store, org, opts) });
  }
  // Project Intelligence Core: link anything new (idempotent).
  let core = null; try { const { backfillCore } = await import('./core.js'); core = backfillCore(store); } catch (e) { console.error('core linking failed', e.message); }
  let planRoom = null; try { const { syncPlanRoom } = await import('./planroom.js'); planRoom = await syncPlanRoom(store); } catch (e) { console.error('plan room sync failed', e.message); }
  // Open requests reach companies that joined or added trades since the request was posted.
  let invited = 0;
  for (const r of store.list('bidRequests', x => x.status === 'open' && Date.parse(x.dueDate) > Date.now())) invited += inviteMatches(store, r);
  let invitationNotices = [];
  try { const { sendInvitationNotices } = await import('./digest.js'); invitationNotices = await sendInvitationNotices(store, opts); } catch (e) { console.error('invitation notices failed', e.message); }
  const retention = runRetention(store);
  const job = store.put('jobs', { type: 'cycle', status: 'ok', started, finished: now(), collect, orgs, retention, invited, invitationNotices: invitationNotices.length, core, planRoom });
  store.save();
  return job;
}

/** Postmark delivery/bounce/spam webhook. Delivery evidence moves bids forward; complaints suppress. */
export function handleEmailEvent(store, ev) {
  const msg = store.list('messages', m => m.messageId && m.messageId === ev.MessageID)[0];
  if (!msg) return { ok: false, reason: 'unknown message' };
  const bid = store.tget('bids', msg.orgId, msg.bidId);
  const contact = store.get('contacts', msg.contactId);
  switch (ev.RecordType) {
    case 'Delivery': if (bid?.status === 'sent') transition(store, bid, 'delivered', 'postmark', { at: ev.DeliveredAt }); break;
    case 'Open': if (bid?.status === 'delivered') transition(store, bid, 'opened', 'postmark'); break;
    case 'Bounce':
      if (ev.Type === 'HardBounce' && contact) { contact.status = 'outdated'; store.put('contacts', contact); }
      if (bid?.status === 'sent') transition(store, bid, 'failed', 'postmark', { bounce: ev.Type });
      break;
    case 'SpamComplaint': case 'SubscriptionChange':
      if (contact?.email) store.suppressEverywhere(contact.email, ev.RecordType, 'postmark');
      break;
  }
  return { ok: true };
}
