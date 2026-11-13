import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { searchBidders } from '../src/publishing.js';

const world = () => {
  const store = new Store(null);
  const elec = store.put('orgs', { slug: 'a', name: 'Bright Electric', kind: 'subscriber', status: 'active', trades: ['electrical'], territories: ['WA'], settings: {} });
  const plumb = store.put('orgs', { slug: 'b', name: 'Coastal Plumbing', kind: 'subscriber', status: 'active', trades: ['plumbing'], territories: ['WA', 'OR'], settings: {} });
  const far = store.put('orgs', { slug: 'c', name: 'Texas Electric', kind: 'subscriber', status: 'active', trades: ['electrical'], territories: ['TX'], settings: {} });
  const paused = store.put('orgs', { slug: 'd', name: 'Paused Electric', kind: 'subscriber', status: 'suspended', trades: ['electrical'], territories: ['WA'], settings: {} });
  const pkg = store.put('bidRequests', { buyerOrgId: 'gc-1', title: 'Electrical', status: 'open', trades: ['electrical'], state: 'WA', dueDate: '2030-01-01' });
  store.put('invitations', { requestId: pkg.id, buyerOrgId: 'gc-1', sellerOrgId: elec.id, intent: 'undecided' });
  return { store, elec, plumb, far, paused, pkg };
};

test('the directory lists only active companies, and filters by trade and state', () => {
  const { store } = world();
  assert.deepEqual(searchBidders(store, {}).map(r => r.name).sort(), ['Bright Electric', 'Coastal Plumbing', 'Texas Electric']);
  assert.deepEqual(searchBidders(store, { trade: 'electrical' }).map(r => r.name), ['Bright Electric', 'Texas Electric']);
  assert.deepEqual(searchBidders(store, { state: 'OR' }).map(r => r.name), ['Coastal Plumbing']);
  assert.deepEqual(searchBidders(store, { q: 'texas' }).map(r => r.name), ['Texas Electric']);
});

test('with a package, each company shows whether it is eligible, why, and whether it is already invited', () => {
  const { store, pkg } = world();
  const rows = Object.fromEntries(searchBidders(store, { packageId: pkg.id }).map(r => [r.name, r]));
  assert.equal(rows['Bright Electric'].eligible, true);
  assert.equal(rows['Bright Electric'].invited, true);
  assert.equal(rows['Texas Electric'].eligible, false);
  assert.match(rows['Texas Electric'].eligibility, /Does not cover WA/);
  assert.equal(rows['Coastal Plumbing'].eligible, false);
  assert.match(rows['Coastal Plumbing'].eligibility, /Does not perform a trade/);
  assert.equal(rows['Coastal Plumbing'].invited, false);
});

test('the limit is respected and capped', () => {
  const { store } = world();
  assert.equal(searchBidders(store, { limit: 1 }).length, 1);
  assert.equal(searchBidders(store, { limit: 9999 }).length, 3);
});
