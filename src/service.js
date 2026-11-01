'use strict';

const {
  newId, sha256, safeEqual, normEmail, isEmail, hmac,
  ValidationError, NotFoundError, ConflictError,
} = require('./util');
const { audit } = require('./store');
const { estimate } = require('./domain/estimating');
const { transitionBid } = require('./domain/bids');
const { CONTACT_STATUSES, BID_SENDABLE_STATUSES, checkOutbound } = require('./domain/compliance');
const { renderProposal } = require('./domain/proposal');
const { PROJECT_TYPES } = require('./domain/permits');

const ORG_STATUSES = ['active', 'paused'];

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`, [`${field} is required`]);
  }
  return value.trim();
}

function publicOrg(org) {
  const { apiKeyHash, ...rest } = org;
  return rest;
}

// ---------- organisations ----------

function createOrg(store, input) {
  const errors = [];
  // Template placeholders must never become a live tenant with fake legal or contact details.
  if (JSON.stringify(input).includes('REPLACE')) {
    errors.push('placeholder values (REPLACE) must be replaced with real details before creating the organisation');
  }
  const legalName = input.legalName || input.name;
  if (!legalName) errors.push('legalName is required');
  if (!input.email || !isEmail(normEmail(input.email))) errors.push('a valid contact email is required');
  const addr = input.postalAddress || {};
  for (const f of ['line1', 'city', 'state', 'postalCode']) {
    if (!addr[f]) errors.push(`postalAddress.${f} is required (CAN-SPAM)`);
  }
  if (!Array.isArray(input.territories) || input.territories.length === 0) {
    errors.push('at least one service territory is required');
  }
  for (const t of input.territories || []) {
    if (!t || !/^[A-Za-z]{2}$/.test(String(t.state || ''))) errors.push('each territory needs a two-letter state');
  }
  for (const pt of input.projectTypes || []) {
    if (!PROJECT_TYPES.includes(pt)) errors.push(`unknown project type "${pt}"`);
  }
  if (errors.length) throw new ValidationError('Invalid organisation', errors);

  const apiKey = newId('bik') + newId('k');
  const org = store.insert('orgs', {
    id: newId('org'),
    name: input.name || legalName,
    status: 'active',
    legal: {
      legalName,
      senderEmail: normEmail(input.email),
      postalAddress: {
        line1: String(addr.line1), line2: addr.line2 || '', city: String(addr.city),
        state: String(addr.state).toUpperCase(), postalCode: String(addr.postalCode),
      },
    },
    profile: {
      territories: input.territories.map((t) => ({
        state: String(t.state).toUpperCase(),
        cities: Array.isArray(t.cities) ? t.cities : [],
      })),
      projectTypes: input.projectTypes || [],
      minSquareFeet: input.minSquareFeet || 0,
      services: input.services || [],
    },
    pricing: { rateCards: [] },
    proposal: { scope: input.scope || '' },
    autopilot: input.autopilot || { enabled: false, autoApproveMaxTotal: 0 },
    apiKeyHash: sha256(apiKey),
  });
  audit(store, org.id, 'platform', 'org.created', org.id, { name: org.name });
  return { org: publicOrg(org), apiKey };
}

function findOrgByApiKey(store, apiKey) {
  if (!apiKey) return null;
  const hash = sha256(apiKey);
  return store.list('orgs', null, (o) => safeEqual(o.apiKeyHash, hash) && o.status === 'active')[0] || null;
}

function updateProfile(store, orgId, patch) {
  const org = store.get('orgs', null, orgId);
  if (!org) throw new NotFoundError('Organisation not found');
  const allowed = {};
  if (patch.territories) allowed.territories = patch.territories.map((t) => ({
    state: String(t.state).toUpperCase(), cities: t.cities || [],
  }));
  if (patch.projectTypes) {
    const bad = patch.projectTypes.filter((p) => !PROJECT_TYPES.includes(p));
    if (bad.length) throw new ValidationError('Unknown project types', bad.map((b) => `unknown project type "${b}"`));
    allowed.projectTypes = patch.projectTypes;
  }
  if (patch.minSquareFeet !== undefined) {
    if (!(Number.isFinite(patch.minSquareFeet) && patch.minSquareFeet >= 0)) {
      throw new ValidationError('minSquareFeet must be >= 0', ['minSquareFeet must be >= 0']);
    }
    allowed.minSquareFeet = patch.minSquareFeet;
  }
  const next = { ...org.profile, ...allowed };
  const updated = store.update('orgs', null, orgId, { profile: next });
  audit(store, orgId, `user:${orgId}`, 'profile.updated', orgId, Object.keys(allowed));
  return publicOrg(updated);
}

/**
 * Rate cards are the tenant's own pricing. Each one is validated by running a
 * test estimate, so a bad rate is rejected at save time, not at bid time.
 */
function setPricing(store, orgId, rateCards) {
  if (!Array.isArray(rateCards)) throw new ValidationError('rateCards must be an array', ['rateCards must be an array']);
  rateCards.forEach((card, i) => {
    if (!card.service) throw new ValidationError('Invalid rate card', [`rateCards[${i}].service is required`]);
    estimate({
      squareFeet: 1000,
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
  });
  store.update('orgs', null, orgId, { pricing: { rateCards } });
  audit(store, orgId, `user:${orgId}`, 'pricing.updated', orgId, { cards: rateCards.length });
  return rateCards;
}

// ---------- contacts ----------

function addContact(store, orgId, input) {
  const email = normEmail(input.email);
  const errors = [];
  if (!isEmail(email)) errors.push('a valid email is required');
  requireString(input.company || '', 'company');
  if (errors.length) throw new ValidationError('Invalid contact', errors);
  // Every contact starts unverified. Nothing outbound can use it until a source confirms it.
  return store.insert('contacts', {
    orgId,
    company: String(input.company).trim(),
    name: input.name || null,
    role: input.role || null,
    email,
    status: 'unverified',
    source: null,
  });
}

function verifyContact(store, orgId, contactId, { status, source, actor }) {
  const contact = store.get('contacts', orgId, contactId);
  if (!contact) throw new NotFoundError('Contact not found');
  if (!CONTACT_STATUSES.includes(status) || status === 'unverified') {
    throw new ValidationError('Invalid status', [`status must be one of ${CONTACT_STATUSES.filter((s) => s !== 'unverified').join(', ')}`]);
  }
  if (['verified', 'source_confirmed'].includes(status) && !source) {
    throw new ValidationError('A source is required to verify a contact', ['source is required']);
  }
  const updated = store.update('contacts', orgId, contactId, { status, source: source || null });
  audit(store, orgId, actor, 'contact.status', contactId, { status });
  return updated;
}

// ---------- suppression / unsubscribe ----------

function isSuppressed(store, email) {
  const e = normEmail(email);
  return store.list('suppressions', null, (s) => s.email === e).length > 0;
}

/**
 * Processes an opt-out immediately across the whole platform. The FTC allows up
 * to 10 business days, so immediate processing is the safe choice.
 */
function unsubscribe(store, email, reason = 'unsubscribe_link') {
  const e = normEmail(email);
  if (!isEmail(e)) throw new ValidationError('Invalid email', ['invalid email']);
  if (!isSuppressed(store, e)) {
    store.insert('suppressions', { email: e, reason, at: new Date().toISOString() });
  }
  for (const contact of store.listAllTenants('contacts', (c) => c.email === e)) {
    store.update('contacts', contact.orgId, contact.id, { status: 'opted_out' });
    audit(store, contact.orgId, 'system', 'contact.opted_out', contact.id, { reason });
  }
  return { email: e, suppressed: true };
}

function unsubscribeToken(secret, email) {
  return hmac(secret, normEmail(email));
}

// ---------- bids ----------

function listBids(store, orgId) {
  return store.list('bids', orgId);
}

function getBid(store, orgId, bidId) {
  const bid = store.get('bids', orgId, bidId);
  if (!bid) throw new NotFoundError('Bid not found');
  return bid;
}

function approveBid(store, orgId, bidId, actor) {
  const bid = getBid(store, orgId, bidId);
  const next = transitionBid(bid, 'approved', { actor, note: 'approved by owner' });
  const saved = store.update('bids', orgId, bidId, next);
  const proposal = store.get('proposals', orgId, bid.proposalId);
  if (proposal) store.update('proposals', orgId, proposal.id, { status: 'approved' });
  audit(store, orgId, actor, 'bid.approved', bidId, null);
  return saved;
}

function withdrawBid(store, orgId, bidId, actor) {
  const bid = getBid(store, orgId, bidId);
  const next = transitionBid(bid, 'withdrawn', { actor, note: 'withdrawn by owner' });
  const saved = store.update('bids', orgId, bidId, next);
  audit(store, orgId, actor, 'bid.withdrawn', bidId, null);
  return saved;
}

function buildBidMessage(org, opportunity, permit, proposal, recipient, rendered) {
  return {
    to: recipient.email,
    toCompany: recipient.company,
    from: org.legal.senderEmail,
    fromName: org.legal.legalName,
    subject: rendered.subject,
    html: rendered.html,
    purpose: 'bid_submission',
    opportunityId: opportunity.id,
    proposalId: proposal.id,
    isReply: false,
    unsubscribeUrl: null,
    postalAddress: org.legal.postalAddress,
    permitId: permit.permitId,
  };
}

/**
 * Dispatches one approved bid. In dry_run it previews the message and leaves the
 * bid "approved". In live mode it moves through sending to sent (with the
 * provider's acceptance receipt) or to failed. It is never marked sent without
 * a receipt.
 */
async function dispatchBid({ store, config, transport, orgId, bidId }) {
  const org = store.get('orgs', null, orgId);
  const bid = getBid(store, orgId, bidId);
  if (bid.status !== 'approved') throw new ConflictError(`Bid is "${bid.status}", not approved`);
  const opportunity = store.get('opportunities', orgId, bid.opportunityId);
  const permit = store.get('permits', null, opportunity.permitId);
  const proposal = store.get('proposals', orgId, bid.proposalId);
  const recipient = store.get('contacts', orgId, bid.recipientContactId);
  const rendered = { subject: proposal.subject, html: proposal.html };
  const message = buildBidMessage(org, opportunity, permit, proposal, recipient, rendered);

  const problems = checkOutbound({
    message,
    recipient,
    org,
    suppressed: isSuppressed(store, recipient ? recipient.email : ''),
  });
  if (problems.length) {
    // approved -> sending -> failed is the only legal path; approved cannot fail directly.
    let next = transitionBid(bid, 'sending', { actor: 'system', note: 'compliance check' });
    next = transitionBid(next, 'failed', { actor: 'system', note: problems.join('; ') });
    store.update('bids', orgId, bidId, next);
    audit(store, orgId, 'system', 'bid.blocked', bidId, problems);
    return { status: 'failed', problems };
  }

  if (config.sendMode !== 'live') {
    const preview = await transport.preview(message);
    store.update('bids', orgId, bidId, {
      dispatch: { mode: 'dry_run', previewFile: preview.file, at: new Date().toISOString() },
    });
    audit(store, orgId, 'system', 'bid.previewed', bidId, { file: preview.file });
    return { status: 'approved', mode: 'dry_run', previewFile: preview.file };
  }

  let next = transitionBid(bid, 'sending', { actor: 'system', note: 'dispatching' });
  store.update('bids', orgId, bidId, next);
  try {
    const res = await transport.send(message);
    if (!res || !res.providerMessageId || !res.acceptedAt) {
      throw new Error('provider returned no acceptance receipt');
    }
    next = transitionBid(next, 'sent', {
      actor: 'system',
      note: 'accepted by provider',
      receipt: { providerMessageId: res.providerMessageId, acceptedAt: res.acceptedAt },
    });
    store.update('bids', orgId, bidId, next);
    audit(store, orgId, 'system', 'bid.sent', bidId, { providerMessageId: res.providerMessageId });
    return { status: 'sent' };
  } catch (err) {
    next = transitionBid(next, 'failed', { actor: 'system', note: err.message });
    store.update('bids', orgId, bidId, next);
    audit(store, orgId, 'system', 'bid.failed', bidId, { error: err.message });
    return { status: 'failed', error: err.message };
  }
}

module.exports = {
  ORG_STATUSES,
  BID_SENDABLE_STATUSES,
  createOrg,
  findOrgByApiKey,
  publicOrg,
  updateProfile,
  setPricing,
  addContact,
  verifyContact,
  isSuppressed,
  unsubscribe,
  unsubscribeToken,
  listBids,
  getBid,
  approveBid,
  withdrawBid,
  dispatchBid,
  buildBidMessage,
};
