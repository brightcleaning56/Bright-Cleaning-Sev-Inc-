'use strict';

const { newId } = require('./util');
const { audit } = require('./store');
const { syncSource, loadSourceRegistry } = require('./ingest/sources');
const { matchPermit } = require('./domain/matching');
const { estimate, selectRateCard } = require('./domain/estimating');
const { renderProposal } = require('./domain/proposal');
const { transitionBid } = require('./domain/bids');
const { checkOutbound, BID_SENDABLE_STATUSES } = require('./domain/compliance');
const { isSuppressed, buildBidMessage, dispatchBid } = require('./service');

/** Syncs every authorised source in the registry. Blocked sources are reported, not run. */
function syncAllSources(store, config, now) {
  const registry = loadSourceRegistry(config.sourcesFile);
  return registry.map((source) => syncSource(store, source, { allowSample: config.allowSampleData, now }));
}

/**
 * Finds a recipient for a permit's GC. The GC must already exist as a
 * contact the owner has verified. An AI or the system never invents one.
 */
function pickRecipient(store, orgId, permit) {
  if (!permit.gc) return null;
  const company = String(permit.gc).trim().toLowerCase();
  return store.list('contacts', orgId, (c) => (
    String(c.company).trim().toLowerCase() === company && BID_SENDABLE_STATUSES.includes(c.status)
  ))[0] || null;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Turns one matched opportunity into a priced proposal and a bid. It stops at
 * the first point where a human must decide (pricing missing, no verified
 * recipient, compliance problem, or above the auto-approval limit).
 */
async function processOpportunity({ store, config, transport, org, permit, opportunity, now }) {
  const outcome = (status, detail) => {
    store.update('opportunities', org.id, opportunity.id, { status, statusDetail: detail || null });
    return { opportunityId: opportunity.id, status, detail: detail || null };
  };

  const card = selectRateCard(org.pricing && org.pricing.rateCards, permit.projectType);
  if (!card) return outcome('needs_pricing', 'no rate card covers this project type');
  if (!permit.squareFeet) return outcome('needs_square_footage', 'permit does not state square footage');

  const est = estimate({
    squareFeet: permit.squareFeet,
    productionRate: card.productionRate,
    laborRate: card.laborRate,
    burdenPct: card.burdenPct ?? 0,
    supervisionPct: card.supervisionPct ?? 0,
    overheadPct: card.overheadPct ?? 0,
    marginPct: card.marginPct ?? 0,
    materialsPerSqFt: card.materialsPerSqFt ?? 0,
    equipmentPerDay: card.equipmentPerDay ?? 0,
    days: card.days ?? 1,
    travelFee: card.travelFee ?? 0,
    minimumBid: card.minimumBid ?? 0,
  });

  const rendered = renderProposal({
    org,
    opportunity,
    permit,
    estimate: est,
    validUntil: addDays(now, 30),
  });
  const proposal = store.insert('proposals', {
    orgId: org.id,
    opportunityId: opportunity.id,
    version: 1,
    status: 'draft',
    estimate: est,
    subject: rendered.subject,
    html: rendered.html,
    hash: rendered.hash,
  });

  const recipient = pickRecipient(store, org.id, permit);
  if (!recipient) {
    store.insert('bids', {
      orgId: org.id, opportunityId: opportunity.id, proposalId: proposal.id,
      recipientContactId: null, status: 'draft', total: est.total, history: [], receipt: null,
      blockers: ['no verified recipient for the GC'],
    });
    return outcome('needs_recipient', 'verify the GC contact before a bid can be sent');
  }

  const message = buildBidMessage(org, opportunity, permit, proposal, recipient, rendered);
  const problems = checkOutbound({
    message, recipient, org, suppressed: isSuppressed(store, recipient.email),
  });
  let bid = store.insert('bids', {
    orgId: org.id, opportunityId: opportunity.id, proposalId: proposal.id,
    recipientContactId: recipient.id, status: 'draft', total: est.total, history: [], receipt: null,
    blockers: problems,
  });
  if (problems.length) return outcome('blocked_compliance', problems.join('; '));

  const policy = org.autopilot || {};
  const needsOwner = !policy.enabled
    || opportunity.needsReview
    || est.total > (policy.autoApproveMaxTotal || 0);

  if (needsOwner) {
    bid = store.update('bids', org.id, bid.id, transitionBid(bid, 'pending_approval', {
      actor: 'autopilot', note: 'routed to owner approval queue',
    }));
    return outcome('awaiting_owner', 'bid is in the owner approval queue');
  }

  bid = store.update('bids', org.id, bid.id, transitionBid(bid, 'approved', {
    actor: 'autopilot', note: `auto-approved under policy (limit ${policy.autoApproveMaxTotal})`,
  }));
  audit(store, org.id, 'autopilot', 'bid.auto_approved', bid.id, { total: est.total });
  const dispatch = await dispatchBid({ store, config, transport, orgId: org.id, bidId: bid.id });
  return outcome(dispatch.status === 'sent' ? 'sent' : 'approved', dispatch.mode || dispatch.status);
}

/**
 * One full autonomous cycle: ingest, match, price, draft, approve or queue, and
 * dispatch. Every decision is written to the audit log and returned in the report.
 */
async function runCycle({ store, config, transport, now = new Date() }) {
  const report = {
    startedAt: now.toISOString(),
    sources: syncAllSources(store, config, now),
    orgs: [],
  };

  const orgs = store.list('orgs', null, (o) => o.status === 'active');
  for (const org of orgs) {
    const orgReport = { orgId: org.id, name: org.name, matched: 0, results: [] };
    report.orgs.push(orgReport);
    if (!(org.autopilot && org.autopilot.enabled)) {
      orgReport.skipped = 'autopilot disabled for this organisation';
      continue;
    }
    const permits = store.list('permits', null, (p) => config.allowSampleData || !p.isSample);
    for (const permit of permits) {
      const already = store.list('opportunities', org.id, (o) => o.permitId === permit.id).length > 0;
      if (already) continue;
      const m = matchPermit(permit, org.profile, { allowSample: config.allowSampleData });
      if (!m.match) continue;
      const opportunity = store.insert('opportunities', {
        id: newId('opp'),
        orgId: org.id,
        permitId: permit.id,
        score: m.score,
        reasons: m.reasons,
        needsReview: m.needsReview,
        status: 'new',
        statusDetail: null,
      });
      orgReport.matched += 1;
      const result = await processOpportunity({ store, config, transport, org, permit, opportunity, now });
      orgReport.results.push({ permit: permit.permitId, ...result });
    }
  }

  report.finishedAt = new Date().toISOString();
  store.insert('jobs', { type: 'autopilot.cycle', summary: summarize(report), finishedAt: report.finishedAt });
  return report;
}

function summarize(report) {
  const count = (status) => report.orgs.reduce(
    (n, o) => n + o.results.filter((r) => r.status === status).length, 0,
  );
  return {
    sourcesRun: report.sources.filter((s) => s.status === 'ok').length,
    sourcesBlocked: report.sources.filter((s) => s.status === 'blocked').length,
    awaitingOwner: count('awaiting_owner'),
    needsPricing: count('needs_pricing'),
    needsRecipient: count('needs_recipient'),
    blockedCompliance: count('blocked_compliance'),
    sent: count('sent'),
  };
}

module.exports = { runCycle, syncAllSources, pickRecipient, addDays };
