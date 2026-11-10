import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { decideVerification } from '../src/publishing.js';
import { changeDeadline } from '../src/deadline.js';
config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-deadline-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const owner = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id });
  decideVerification(store, { email: 'staff' }, gc.id, { status: 'verified', note: 'state business registration checked' });
  const req = store.put('bidRequests', { buyerOrgId: gc.id, title: 'Electrical', status: 'open', dueDate: D(10), addendumCount: 0, addenda: [], trades: ['electrical'] });
  return { store, gc, owner, req };
}

test('a deadline change is recorded as a numbered addendum with the old and new date and the reason', () => {
  const w = world();
  const to = D(20);
  const r = changeDeadline(w.store, w.gc, w.owner, w.req.id, { dueDate: to, note: 'Owner added a week for the structural revision.' });
  assert.equal(r.ok, true, r.error);
  const fresh = w.store.get('bidRequests', w.req.id);
  assert.equal(fresh.dueDate, to);
  assert.equal(fresh.addendumCount, 1);
  assert.equal(fresh.addenda[0].kind, 'deadline');
  assert.match(fresh.addenda[0].note, /changed from .* to /);
  assert.match(fresh.addenda[0].note, /structural revision/);
});

test('refuses a past date, the same date, a missing reason, a draft, and a request of another company', () => {
  const w = world();
  assert.equal(changeDeadline(w.store, w.gc, w.owner, w.req.id, { dueDate: D(-2), note: 'x' }).code, 400);
  assert.equal(changeDeadline(w.store, w.gc, w.owner, w.req.id, { dueDate: D(10), note: 'x' }).code, 400, 'same date');
  assert.equal(changeDeadline(w.store, w.gc, w.owner, w.req.id, { dueDate: D(20) }).code, 400, 'reason required');
  const other = w.store.put('orgs', { slug: 'other', name: 'Other', kind: 'buyer', status: 'active', settings: {} });
  assert.equal(changeDeadline(w.store, other, w.owner, w.req.id, { dueDate: D(20), note: 'x' }).code, 404);
  w.store.put('bidRequests', { ...w.store.get('bidRequests', w.req.id), status: 'draft' });
  assert.equal(changeDeadline(w.store, w.gc, w.owner, w.req.id, { dueDate: D(20), note: 'x' }).code, 409, 'drafts are edited directly, not by addendum');
  assert.equal(w.store.get('bidRequests', w.req.id).addendumCount, 0, 'nothing changed on refusal');
});
