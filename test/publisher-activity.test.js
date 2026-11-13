import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { publisherActivity, requestVerification } from '../src/publishing.js';

test('publisher activity lists only this company\'s actions, most recent first, with readable labels', () => {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const other = store.put('orgs', { slug: 'x', name: 'Other', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const user = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id });
  requestVerification(store, gc, user, { website: 'https://abc.test', licenseNumber: 'WA-1' });
  store.audit({ actor: 'someone@x.test', orgId: other.id, action: 'publication.publish', target: 'pub_other' });
  store.audit({ actor: 'gm@abc.test', orgId: gc.id, action: 'publication.publish', target: 'pub_1' });
  const rows = publisherActivity(store, gc);
  assert.deepEqual(rows.map(r => r.action), ['publication.publish', 'publisher.request']);
  assert.equal(rows[0].label, 'Published a project');
  assert.equal(rows[0].target, 'pub_1');
  assert.equal(rows.some(r => r.target === 'pub_other'), false, 'another company\'s actions are not shown');
  assert.equal(publisherActivity(store, gc, { limit: 1 }).length, 1);
});
