import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { awardRequest, submitBid } from '../src/marketplace.js';

const setup = () => {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const gm = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id });
  const sub = store.put('orgs', { slug: 'sub', name: 'Bright Electric', kind: 'subscriber', status: 'active', trades: ['electrical'], territories: ['WA'], settings: {} });
  const su = store.put('users', { email: 'ana@bright.test', role: 'owner', orgId: sub.id });
  const r = store.put('bidRequests', { buyerOrgId: gc.id, title: 'Electrical', status: 'open', trades: ['electrical'], state: 'WA', dueDate: '2030-01-01', addenda: [], addendumCount: 0, distribution: 'invite_only', insuranceRequirements: { generalLiabilityMin: 1000000, workersComp: false } });
  const inv = store.put('invitations', { requestId: r.id, buyerOrgId: gc.id, sellerOrgId: sub.id, intent: 'undecided', ackAddendum: 0 });
  const bid = submitBid(store, store.get('orgs', sub.id), su, inv.id, { amount: 90000, scope: 'Rough-in and trim per the drawings.', documentUrl: 'https://example.com/b.pdf', validDays: 30 });
  return { store, gc, gm, r, sub, submissionId: bid.submission.id };
};

test('awarding a company with no insurance on file needs a recorded reason, and the reason is kept on the contract', () => {
  const w = setup();
  assert.throws(() => awardRequest(w.store, w.gc, w.gm, w.r.id, w.submissionId, { signerName: 'Dana Gray', consent: true }), { code: 409, message: /does not meet the insurance minimum/ });
  assert.equal(w.store.get('bidRequests', w.r.id).status, 'open', 'nothing was awarded');
  const a = awardRequest(w.store, w.gc, w.gm, w.r.id, w.submissionId, { signerName: 'Dana Gray', consent: true, insuranceReason: 'Owner accepted the bid; COI arrives Monday.' });
  const c = w.store.get('contracts', a.contractId);
  assert.equal(c.insuranceException.reason, 'Owner accepted the bid; COI arrives Monday.');
  assert.match(c.insuranceException.shortfalls[0], /no general liability/);
});

test('a package without a minimum is awarded as before', () => {
  const w = setup();
  w.store.put('bidRequests', { ...w.store.get('bidRequests', w.r.id), insuranceRequirements: null });
  const a = awardRequest(w.store, w.gc, w.gm, w.r.id, w.submissionId, { signerName: 'Dana Gray', consent: true });
  assert.equal(w.store.get('contracts', a.contractId).insuranceException, null);
});
