import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createPublication, addPackage, checklist, decideVerification, schedulePublication, unschedulePublication, publishDue } from '../src/publishing.js';
config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-sched-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const PROJECT = { title: 'Delaware Medical Office Building', address: '1200 SE Delaware Ave', city: 'Ankeny', state: 'IA', projectType: 'medical', description: 'New 120,000 SF medical office building', estValue: 48500000 };
const PKG = { title: 'Electrical', trades: ['electrical'], dueDate: D(21), projectType: 'medical', description: 'Electrical: complete scope per drawings and specifications', noDocuments: true };
function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const owner = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id });
  decideVerification(store, { email: 'staff' }, gc.id, { status: 'verified', note: 'state business registration checked' });
  return { store, gc, owner };
}

test('a draft can be scheduled, not in the past, and unscheduled', () => {
  const w = world();
  const p = createPublication(w.store, w.gc, w.owner, PROJECT).publication;
  assert.equal(schedulePublication(w.store, w.gc, w.owner, p.id, new Date(Date.now() - 1000).toISOString()).code, 400, 'a past time is refused');
  assert.equal(schedulePublication(w.store, w.gc, w.owner, p.id, new Date(Date.now() + 400 * 864e5).toISOString()).code, 400, 'more than a year ahead is refused');
  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal(schedulePublication(w.store, w.gc, w.owner, p.id, future).ok, true);
  assert.equal(w.store.get('publications', p.id).scheduledFor, new Date(future).toISOString());
  assert.equal(unschedulePublication(w.store, w.gc, w.owner, p.id).ok, true);
  assert.equal(w.store.get('publications', p.id).scheduledFor, null);
});

test('a scheduled draft publishes when its time comes, and stays a draft until then', () => {
  const w = world();
  const p = createPublication(w.store, w.gc, w.owner, PROJECT).publication;
  const pk = addPackage(w.store, w.gc, w.owner, p.id, PKG).package;
  { const r = w.store.get('bidRequests', pk.id); r.noDocuments = true; w.store.put('bidRequests', r); }
  const at = new Date(Date.now() + 3600e3).toISOString();
  schedulePublication(w.store, w.gc, w.owner, p.id, at);
  assert.deepEqual(publishDue(w.store, { at: Date.now() }), [], 'not yet due');
  assert.equal(w.store.get('publications', p.id).status, 'draft');
  const out = publishDue(w.store, { at: Date.parse(at) + 1000 });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true, out[0].error);
  assert.equal(w.store.get('publications', p.id).status, 'published');
  assert.equal(w.store.get('publications', p.id).scheduledFor, null);
});

test('a scheduled publish that cannot happen is cleared, with the reason kept on the draft', () => {
  const w = world();
  const p = createPublication(w.store, w.gc, w.owner, PROJECT).publication;   // no packages: not ready
  schedulePublication(w.store, w.gc, w.owner, p.id, new Date(Date.now() + 3600e3).toISOString());
  const out = publishDue(w.store, { at: Date.now() + 2 * 3600e3 });
  assert.equal(out[0].ok, false);
  const fresh = w.store.get('publications', p.id);
  assert.equal(fresh.status, 'draft');
  assert.equal(fresh.scheduledFor, null, 'the schedule is cleared so the job does not retry every cycle');
  assert.match(fresh.scheduleError, /not ready/);
  assert.equal(publishDue(w.store, { at: Date.now() + 9 * 3600e3 }).length, 0, 'it is not retried');
});
