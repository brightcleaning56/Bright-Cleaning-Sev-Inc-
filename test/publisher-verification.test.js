import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { requestVerification, decideVerification } from '../src/publishing.js';

const setup = () => {
  const store = new Store(null);
  const org = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'pending_verification', settings: {} });
  const user = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: org.id });
  return { store, org, user };
};

test('a verification request keeps the contact person and records each step in the review history', () => {
  const { store, org, user } = setup();
  const r = requestVerification(store, org, user, { website: 'https://abc.test', licenseNumber: 'WA-123', phone: '206-555-0100', contactName: 'Dana Gray', title: 'Managing Member' });
  assert.equal(r.ok, true, r.error);
  const fresh = store.get('orgs', org.id);
  assert.equal(fresh.publisher.evidence.contactName, 'Dana Gray');
  assert.equal(fresh.publisher.evidence.title, 'Managing Member');
  assert.deepEqual(fresh.publisher.history.map(h => h.event), ['requested']);
});

test('a rejected company resubmits, and the history shows the rejection, the reason and the new request', () => {
  const { store, org, user } = setup();
  requestVerification(store, org, user, { website: 'https://abc.test', licenseNumber: 'WA-123' });
  decideVerification(store, { email: 'staff@bc.test' }, org.id, { status: 'rejected', note: 'license number not found on the state register' });
  assert.equal(store.get('orgs', org.id).publisher.status, 'rejected');
  requestVerification(store, store.get('orgs', org.id), user, { website: 'https://abc.test', licenseNumber: 'WA-1234' });
  const h = store.get('orgs', org.id).publisher.history;
  assert.deepEqual(h.map(x => x.event), ['requested', 'rejected', 'resubmitted']);
  assert.equal(h[1].note, 'license number not found on the state register');
  assert.equal(h[1].by, 'staff@bc.test');
});

test('approval is recorded in the history with who approved it and how it was checked', () => {
  const { store, org, user } = setup();
  requestVerification(store, org, user, { website: 'https://abc.test', licenseNumber: 'WA-123' });
  decideVerification(store, { email: 'staff@bc.test' }, org.id, { status: 'verified', note: 'license verified on state register' });
  const p = store.get('orgs', org.id).publisher;
  assert.equal(p.status, 'verified');
  assert.deepEqual(p.history.map(h => h.event), ['requested', 'verified']);
  assert.equal(p.history[1].note, 'license verified on state register');
});

test('a project keeps its owner, developer, architect, general contractor and schedule; the dates must make sense', async () => {
  const { createPublication } = await import('../src/publishing.js');
  const { store, org, user } = setup();
  const base = { title: 'Clinic', address: '1 Main St', city: 'Ankeny', state: 'IA', projectType: 'medical', owner: 'Harbor Health', developer: 'ABC Development', architect: 'Stone Arch', gc: 'Ryan Companies', scheduleStart: '2027-03-01', scheduleCompletion: '2027-11-30' };
  const ok = createPublication(store, org, user, base);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.publication.team, { owner: 'Harbor Health', developer: 'ABC Development', architect: 'Stone Arch', gc: 'Ryan Companies' });
  assert.deepEqual(ok.publication.schedule, { start: '2027-03-01', completion: '2027-11-30' });
  assert.equal(createPublication(store, org, user, { ...base, scheduleCompletion: '2026-01-01' }).ok, false, 'completion before start is refused');
  assert.equal(createPublication(store, org, user, { ...base, scheduleStart: 'next spring' }).ok, false, 'dates must be dates');
});
