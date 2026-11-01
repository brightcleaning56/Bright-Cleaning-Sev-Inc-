'use strict';

const { ValidationError, ConflictError } = require('../util');

// Legal bid lifecycle. A bid moves only along these edges.
const TRANSITIONS = {
  draft: ['pending_approval', 'approved', 'withdrawn'],
  pending_approval: ['approved', 'rejected', 'withdrawn'],
  approved: ['sending', 'withdrawn'],
  sending: ['sent', 'failed'],
  failed: ['approved', 'withdrawn'], // a retry must be approved again
  sent: ['delivered', 'rejected', 'withdrawn', 'awarded', 'lost'],
  delivered: ['awarded', 'lost', 'rejected', 'withdrawn'],
  rejected: [],
  withdrawn: [],
  awarded: [],
  lost: [],
};

const STATUSES = Object.keys(TRANSITIONS);

/**
 * Applies a status change and records it in history. Enforces the rules that
 * stop false success messages:
 *   - "sent" needs a provider acceptance receipt (clicking Send is not enough)
 *   - "delivered" needs a delivery receipt
 *   - approval needs an attached approved proposal
 */
function transitionBid(bid, to, { actor, note, receipt } = {}) {
  if (!actor) throw new ValidationError('actor is required for a bid transition');
  const allowed = TRANSITIONS[bid.status] || [];
  if (!allowed.includes(to)) {
    throw new ConflictError(`Cannot move bid from "${bid.status}" to "${to}"`);
  }
  if (to === 'approved' && !bid.proposalId) {
    throw new ValidationError('A bid needs an approved proposal before it can be approved');
  }
  if (to === 'sent' && !(receipt && receipt.providerMessageId && receipt.acceptedAt)) {
    throw new ValidationError('A bid can only be marked sent with a provider acceptance receipt');
  }
  if (to === 'delivered' && !(receipt && receipt.deliveredAt)) {
    throw new ValidationError('A bid can only be marked delivered with a delivery receipt');
  }
  const at = new Date().toISOString();
  const entry = { from: bid.status, to, actor, note: note || null, at };
  return {
    ...bid,
    status: to,
    receipt: receipt || bid.receipt || null,
    history: [...(bid.history || []), entry],
  };
}

module.exports = { TRANSITIONS, STATUSES, transitionBid };
