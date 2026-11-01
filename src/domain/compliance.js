'use strict';

// Contact statuses. Only confirmed contacts may receive a bid.
const CONTACT_STATUSES = ['verified', 'source_confirmed', 'probable', 'unverified', 'outdated', 'opted_out'];
const BID_SENDABLE_STATUSES = ['verified', 'source_confirmed'];

const TRANSACTIONAL_PURPOSES = ['bid_submission', 'proposal_response', 'bid_clarification'];

/**
 * Bid replies to a specific opportunity are transactional. Everything else
 * (newsletters, promotions, cold outreach) is marketing and needs consent,
 * an unsubscribe link and a physical postal address under CAN-SPAM.
 */
function classifyMessage(message) {
  if (TRANSACTIONAL_PURPOSES.includes(message.purpose) && message.opportunityId) {
    return 'transactional';
  }
  return 'marketing';
}

/**
 * Checks one outbound message before it is allowed to leave the platform.
 * Returns a list of blocking problems. An empty list means it may be sent.
 */
function checkOutbound({ message, recipient, org, suppressed }) {
  const problems = [];
  const kind = classifyMessage(message);

  if (suppressed) problems.push('recipient is on the suppression (opt-out) list');
  if (!recipient) problems.push('no recipient on record');
  if (recipient && recipient.status === 'opted_out') problems.push('recipient has opted out');
  if (recipient && kind === 'transactional' && !BID_SENDABLE_STATUSES.includes(recipient.status)) {
    problems.push(`recipient status "${recipient.status}" is not verified enough to receive a bid`);
  }
  if (recipient && kind === 'marketing' && !BID_SENDABLE_STATUSES.includes(recipient.status)) {
    problems.push(`recipient status "${recipient.status}" does not allow marketing email`);
  }

  if (!org || !org.legal || !org.legal.legalName) problems.push('sender legal name is missing');
  const addr = org && org.legal && org.legal.postalAddress;
  if (!addr || !addr.line1 || !addr.city || !addr.state || !addr.postalCode) {
    problems.push('a valid physical postal address is required on commercial email');
  }

  if (!message.subject || message.subject.length > 200) {
    problems.push('subject is required and must be 200 characters or fewer');
  }
  if (!message.isReply && /^\s*(re|fwd?):/i.test(message.subject || '')) {
    problems.push('subject imitates a reply or forward, which is deceptive');
  }
  if (kind === 'marketing' && !message.unsubscribeUrl) {
    problems.push('marketing email must include a working unsubscribe link');
  }
  if (kind === 'transactional' && !message.proposalId) {
    problems.push('bid email must attach an approved proposal');
  }

  return problems;
}

module.exports = {
  CONTACT_STATUSES,
  BID_SENDABLE_STATUSES,
  classifyMessage,
  checkOutbound,
};
