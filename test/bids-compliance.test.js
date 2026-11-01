'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transitionBid } = require('../src/domain/bids');
const { checkOutbound, classifyMessage } = require('../src/domain/compliance');
const { renderProposal } = require('../src/domain/proposal');
const { estimate } = require('../src/domain/estimating');

const bid = (status, extra = {}) => ({ id: 'b1', status, proposalId: 'p1', history: [], receipt: null, ...extra });
const receipt = { providerMessageId: 'msg-123', acceptedAt: '2026-11-01T10:00:00Z' };

test('a bid cannot be marked sent without a provider acceptance receipt', () => {
  assert.throws(
    () => transitionBid(bid('sending'), 'sent', { actor: 'system' }),
    /acceptance receipt/,
  );
  const sent = transitionBid(bid('sending'), 'sent', { actor: 'system', receipt });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.receipt.providerMessageId, 'msg-123');
});

test('a bid cannot skip approval, and approved cannot jump to failed', () => {
  assert.throws(() => transitionBid(bid('draft'), 'sent', { actor: 'x', receipt }), /Cannot move/);
  assert.throws(() => transitionBid(bid('approved'), 'failed', { actor: 'x' }), /Cannot move/);
});

test('delivered requires a delivery receipt and terminal states are final', () => {
  assert.throws(() => transitionBid(bid('sent'), 'delivered', { actor: 'x' }), /delivery receipt/);
  assert.throws(() => transitionBid(bid('awarded'), 'lost', { actor: 'x' }), /Cannot move/);
});

test('approval requires an attached proposal and every transition is recorded', () => {
  assert.throws(() => transitionBid(bid('draft', { proposalId: null }), 'approved', { actor: 'x' }), /proposal/);
  const approved = transitionBid(bid('pending_approval'), 'approved', { actor: 'owner', note: 'ok' });
  assert.equal(approved.history.length, 1);
  assert.deepEqual(
    { from: approved.history[0].from, to: approved.history[0].to, actor: approved.history[0].actor },
    { from: 'pending_approval', to: 'approved', actor: 'owner' },
  );
});

test('every transition needs an actor for the audit trail', () => {
  assert.throws(() => transitionBid(bid('draft'), 'approved', {}), /actor/);
});

test('bid email to a verified GC is transactional and passes compliance', () => {
  const message = {
    purpose: 'bid_submission', opportunityId: 'o1', proposalId: 'p1', subject: 'Proposal: Tower (BP-7)', isReply: false,
  };
  assert.equal(classifyMessage(message), 'transactional');
  const problems = checkOutbound({
    message,
    recipient: { status: 'verified' },
    org: { legal: { legalName: 'Bright Clean Inc.', senderEmail: 'o@x.com' } },
    suppressed: false,
  });
  assert.ok(problems.some((p) => /physical postal address/.test(p)), 'address required');
  const orgOk = { legal: { legalName: 'Bright Clean Inc.', postalAddress: { line1: '1', city: 'DM', state: 'IA', postalCode: '50309' } } };
  assert.deepEqual(checkOutbound({ message, recipient: { status: 'verified' }, org: orgOk, suppressed: false }), []);
});

test('suppressed, opted-out, unverified and probable recipients are all blocked', () => {
  const message = { purpose: 'bid_submission', opportunityId: 'o1', proposalId: 'p1', subject: 'Bid', isReply: false };
  const org = { legal: { legalName: 'X', postalAddress: { line1: '1', city: 'a', state: 'IA', postalCode: '1' } } };
  assert.ok(checkOutbound({ message, recipient: { status: 'verified' }, org, suppressed: true }).length > 0);
  assert.ok(checkOutbound({ message, recipient: { status: 'opted_out' }, org, suppressed: false }).length > 0);
  assert.ok(checkOutbound({ message, recipient: { status: 'unverified' }, org, suppressed: false }).length > 0);
  assert.ok(checkOutbound({ message, recipient: { status: 'probable' }, org, suppressed: false }).length > 0);
  assert.ok(checkOutbound({ message, recipient: null, org, suppressed: false }).length > 0);
});

test('marketing email without an unsubscribe link is blocked, and fake reply subjects are refused', () => {
  const org = { legal: { legalName: 'X', postalAddress: { line1: '1', city: 'a', state: 'IA', postalCode: '1' } } };
  const marketing = { purpose: 'newsletter', subject: 'Our news', isReply: false };
  const problems = checkOutbound({ message: marketing, recipient: { status: 'verified' }, org, suppressed: false });
  assert.ok(problems.some((p) => /unsubscribe/.test(p)));
  const fake = { purpose: 'newsletter', subject: 'RE: your bid', isReply: false, unsubscribeUrl: 'https://u' };
  const p2 = checkOutbound({ message: fake, recipient: { status: 'verified' }, org, suppressed: false });
  assert.ok(p2.some((p) => /imitates a reply/.test(p)));
});

test('proposal HTML escapes project names and carries the no-guarantee disclaimer', () => {
  const est = estimate({
    squareFeet: 1000, productionRate: 1000, laborRate: 30, burdenPct: 0, supervisionPct: 0, overheadPct: 0, marginPct: 0.2,
  });
  const { html, subject } = renderProposal({
    org: { legal: { legalName: 'Bright Clean Inc.', postalAddress: { line1: '1 St', city: 'DM', state: 'IA', postalCode: '50309' } }, proposal: { scope: '' } },
    opportunity: { id: 'opp_1' },
    permit: { projectName: '<script>alert(1)</script>', permitId: 'BP-1', propertyAddress: 'x', city: 'DM', state: 'IA', sourceUrl: 'https://c.example/p', squareFeet: 1000 },
    estimate: est,
    validUntil: '2026-12-01',
  });
  assert.ok(!html.includes('<script>alert'), 'raw script must not appear');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /not a guarantee of project award/);
  assert.match(subject, /Proposal:/);
});
