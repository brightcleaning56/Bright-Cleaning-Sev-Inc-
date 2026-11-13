import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { bidBreadth, remindUnanswered, inviteEligible } from '../src/breadth.js';
import { config } from '../src/config.js';

const DAY = 864e5;
const setup = ({ distribution = 'eligible', dueInDays = 10 } = {}) => {
  const store = new Store(null);
  config.emailMode = 'dry-run';
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const user = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id });
  const co = (name, trades, territories) => store.put('orgs', { slug: name, name, kind: 'subscriber', status: 'active', trades, territories, settings: {} });
  const a = co('Bright Electric', ['electrical'], ['WA']);
  const b = co('Lux Electric', ['electrical'], ['WA']);
  const c = co('Far Electric', ['electrical'], ['TX']);
  const ua = store.put('users', { email: 'ana@bright.test', role: 'owner', orgId: a.id });
  store.put('users', { email: 'lee@lux.test', role: 'owner', orgId: b.id });
  const pkg = store.put('bidRequests', { buyerOrgId: gc.id, buyerName: 'ABC', publicationId: 'pub_1', title: 'Electrical', address: '1 Main', city: 'Seattle', state: 'WA',
    status: 'open', trades: ['electrical'], dueDate: new Date(Date.now() + dueInDays * DAY).toISOString().slice(0, 10), distribution, addenda: [], addendumCount: 0, invitees: [] });
  store.put('invitations', { requestId: pkg.id, buyerOrgId: gc.id, sellerOrgId: a.id, intent: 'undecided' });
  store.put('invitations', { requestId: pkg.id, buyerOrgId: gc.id, sellerOrgId: b.id, intent: 'undecided' });
  return { store, gc, user, pkg, a, b, c, ua };
};

test('breadth counts invitations, answers and eligible companies not yet invited, and says what to do', () => {
  const w = setup();
  const b = bidBreadth(w.store, w.pkg);
  assert.equal(b.invited, 2);
  assert.equal(b.notAnswered, 2);
  assert.equal(b.eligibleNotInvited, 0, 'Far Electric is outside the area; the others are already invited');
  assert.equal(b.status, 'thin');
  assert.deepEqual(b.actions.map(x => x.key), ['remind']);
});

test('a company that matches the package but were never invited are counted as a gap', () => {
  const w = setup();
  w.store.put('orgs', { slug: 'new', name: 'Hill Electric', kind: 'subscriber', status: 'active', trades: ['electrical'], territories: ['WA'], settings: {} });
  const b = bidBreadth(w.store, w.pkg);
  assert.equal(b.eligibleNotInvited, 1);
  assert.equal(b.actions[0].key, 'invite_eligible');
});

test('reminders go only to companies that have not answered, and are limited to one every two days', async () => {
  const w = setup();
  const x = await remindUnanswered(w.store, w.gc, w.user, w.pkg, { fetchImpl: async () => ({ ok: true, json: async () => ({}), status: 200 }) });
  assert.equal(x.ok, true, x.error);
  assert.equal(x.invitations, 2);
  const msgs = w.store.list('messages', m => m.kind === 'bid_reminder');
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].preview, /Bids are due/);
  const again = await remindUnanswered(w.store, w.gc, w.user, w.store.get('bidRequests', w.pkg.id), { fetchImpl: async () => ({ ok: true, json: async () => ({}), status: 200 }) });
  assert.equal(again.code, 429, 'the second reminder is refused');
  const answered = w.store.list('invitations', i => i.sellerOrgId === w.a.id)[0];
  answered.intent = 'will_bid'; w.store.put('invitations', answered);
  const r2 = bidBreadth(w.store, w.store.get('bidRequests', w.pkg.id), { at: Date.now() + 3 * DAY });
  assert.equal(r2.notAnswered, 1, 'a company that has answered is not counted as unanswered');
});

test('inviting eligible companies adds only those that match and are not yet invited', () => {
  const w = setup();
  w.store.put('orgs', { slug: 'new', name: 'Hill Electric', kind: 'subscriber', status: 'active', trades: ['electrical'], territories: ['WA'], settings: {} });
  const r = inviteEligible(w.store, w.gc, w.user, w.pkg);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.invited, 1);
  assert.equal(inviteEligible(w.store, w.gc, w.user, w.store.get('bidRequests', w.pkg.id)).invited, 0, 'nothing more to add');
});

test('an invite-only package is not opened to eligible companies', () => {
  const w = setup({ distribution: 'invite_only' });
  assert.equal(inviteEligible(w.store, w.gc, w.user, w.pkg).code, 409);
  assert.equal(bidBreadth(w.store, w.pkg).eligibleNotInvited, 0);
});
