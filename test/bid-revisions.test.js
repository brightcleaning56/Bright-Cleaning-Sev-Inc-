import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { submitBid } from '../src/marketplace.js';
import { leveling } from '../src/prequal.js';

const setup = () => {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const sub = store.put('orgs', { slug: 'sub', name: 'Bright Electric', kind: 'subscriber', status: 'active', trades: ['electrical'], territories: ['WA'], legal: { name: 'Bright Electric LLC' }, settings: {} });
  const user = store.put('users', { email: 'ana@bright.test', role: 'owner', orgId: sub.id });
  const r = store.put('bidRequests', { buyerOrgId: gc.id, title: 'Electrical rough-in', status: 'open', trades: ['electrical'], state: 'WA', dueDate: '2030-01-01', addenda: [], addendumCount: 0, distribution: 'invite_only' });
  const inv = store.put('invitations', { requestId: r.id, buyerOrgId: gc.id, sellerOrgId: sub.id, intent: 'undecided', ackAddendum: 0 });
  return { store, gc, sub, user, r, inv };
};
const bid = (w, amount, scope, extra = {}) => submitBid(w.store, w.store.get('orgs', w.sub.id), w.user, w.inv.id, { amount, scope, documentUrl: 'https://example.com/bid.pdf', validDays: 30, ...extra });

test('a revised bid keeps the original amount, scope and receipt, and the comparison shows both', () => {
  const w = setup();
  const first = bid(w, 12500, 'Rough-in for all four floors, per drawings E-101 to E-104.', { exclusions: 'Fire alarm device trim' });
  assert.equal(first.ok, true, first.error);
  const originalReceipt = first.submission.receiptId;
  const second = bid(w, 11800, 'Rough-in and trim for all four floors, per drawings E-101 to E-104.');
  assert.equal(second.ok, true, second.error);
  const cur = w.store.get('submissions', second.submission.id);
  assert.equal(cur.revision, 2);
  assert.equal(cur.total, 11800);
  assert.equal(cur.revisionHistory.length, 1, 'the earlier bid is kept');
  assert.equal(cur.revisionHistory[0].total, 12500);
  assert.equal(cur.revisionHistory[0].receiptId, originalReceipt, 'the earlier receipt is kept');
  assert.match(cur.revisionHistory[0].scope, /four floors/);
  const row = leveling(w.store, w.gc, w.r.id).rows[0];
  assert.equal(row.total, 11800, 'the comparison uses the current bid');
  assert.equal(row.scope.startsWith('Rough-in and trim'), true);
  assert.equal(row.exclusions, null, 'the revision did not carry the old exclusions');
  assert.deepEqual(row.revisions.map(x => [x.revision, x.total, !!x.current]), [[1, 12500, false], [2, 11800, true]]);
});

test('a company that never revises shows one revision and no history', () => {
  const w = setup();
  assert.equal(bid(w, 12500, 'Rough-in for all four floors, per drawings.').ok, true);
  const row = leveling(w.store, w.gc, w.r.id).rows[0];
  assert.deepEqual(row.revisions.map(x => [x.revision, x.current]), [[1, true]]);
});
