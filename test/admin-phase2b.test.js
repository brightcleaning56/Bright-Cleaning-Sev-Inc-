import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { lastMonths, platformAnalytics, actionQueue } from '../src/admin/phase2b.js';

const PW = 'correct horse battery 1';
const AS_OF = new Date('2026-11-08T12:00:00Z');

test('the window is twelve consecutive UTC months ending at the as-of month', () => {
  const m = lastMonths(12, AS_OF);
  assert.equal(m.length, 12);
  assert.equal(m[0], '2025-12');
  assert.equal(m[11], '2026-11');
});

test('analytics count stored records by month, show zeros honestly, and exclude the platform company', () => {
  const store = new Store(null);
  store.put('orgs', { slug: 'bc', name: 'Bright Clean', subscription: { plan: 'internal' }, createdAt: '2026-10-03T00:00:00Z' });
  store.put('orgs', { slug: 'sp', name: 'Sparky', subscription: { plan: 'local' }, createdAt: '2026-10-05T00:00:00Z' });
  store.put('orgs', { slug: 'old', name: 'Old', subscription: { plan: 'local' }, createdAt: '2025-01-01T00:00:00Z' });
  const a = platformAnalytics(store, { asOf: AS_OF });
  const companies = a.series.find(s => s.key === 'companies');
  assert.equal(companies.total, 2, 'platform company excluded');
  assert.equal(companies.values.find(v => v.month === '2026-10').count, 1);
  assert.equal(companies.values.find(v => v.month === '2026-09').count, 0, 'empty month is zero');
  assert.equal(companies.inWindow, 1, 'the 2025 record is outside the window');
  assert.equal(a.timezone, 'UTC');
});

test('analytics report sources with their last success and last error, never invented numbers', () => {
  const store = new Store(null);
  store.put('sources', { name: 'Austin', enabled: true, lastSuccessAt: '2026-11-07T10:00:00Z', lastError: null });
  store.put('sources', { name: 'Chicago', enabled: false, lastError: 'timeout' });
  const a = platformAnalytics(store, { asOf: AS_OF });
  assert.deepEqual(a.sources.map(s => s.name), ['Austin', 'Chicago']);
  assert.equal(a.sources[1].lastError, 'timeout');
});

test('the action queue lists only items that need a decision, oldest first', () => {
  const store = new Store(null);
  store.put('orgs', { name: 'Pending GC', kind: 'buyer', publisher: { status: 'pending' }, createdAt: '2026-11-02T00:00:00Z' });
  store.put('orgs', { name: 'Verified GC', kind: 'buyer', publisher: { status: 'verified' }, createdAt: '2026-11-01T00:00:00Z' });
  store.put('sources', { name: 'Austin', enabled: true, authorization: {}, updatedAt: '2026-11-03T00:00:00Z' });
  store.put('sources', { name: 'Seattle', enabled: true, lastError: 'HTTP 503', lastFailureAt: '2026-11-04T00:00:00Z', authorization: { reviewedBy: 'owner', reviewedAt: '2026-10-01', evidence: 'Public Domain' } });
  store.put('sources', { name: 'Off', enabled: false, authorization: {}, lastError: 'ignored while disabled' });
  store.put('privacyRequests', { type: 'delete', email: 'a@x.test', status: 'open', createdAt: '2026-11-05T00:00:00Z' });
  store.put('privacyRequests', { type: 'access', email: 'b@x.test', status: 'closed', createdAt: '2026-11-05T00:00:00Z' });
  const q = actionQueue(store, { asOf: AS_OF });
  const kinds = q.items.map(i => i.kind);
  assert.equal(q.count, q.items.length);
  assert.ok(kinds.includes('publisher_review'));
  assert.ok(kinds.includes('source_compliance'), 'enabled source with no reviewer is flagged');
  assert.ok(kinds.includes('source_failing'));
  assert.ok(kinds.includes('privacy_request'));
  assert.ok(!q.items.some(i => i.title === 'Verified GC'));
  assert.ok(!q.items.some(i => i.title === 'Off'), 'disabled sources are not flagged');
  assert.ok(!q.items.some(i => i.title === 'access request'), 'closed requests are not flagged');
  const dates = q.items.map(i => i.since).filter(Boolean);
  assert.deepEqual(dates, [...dates].sort(), 'oldest first');
});

test('over HTTP: the admin pages are permission-gated', async t => {
  const store = new Store(null);
  const bc = store.put('orgs', { slug: 'bc', name: 'Bright Clean', status: 'active', settings: {}, subscription: { plan: 'internal', status: 'active' } });
  store.put('users', { email: 'owner@bc.test', orgId: bc.id, role: 'platform_owner', passwordHash: hashPassword(PW) });
  store.put('users', { email: 'member@bc.test', orgId: bc.id, role: 'member', passwordHash: hashPassword(PW) });
  const srv = createServer(store).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async email => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).json()).token;
  const owner = await login('owner@bc.test');
  const member = await login('member@bc.test');
  for (const p of ['/api/admin/analytics', '/api/admin/action-queue']) {
    const ok = await fetch(base + p, { headers: { authorization: 'Bearer ' + owner } });
    assert.equal(ok.status, 200, p);
    const denied = await fetch(base + p, { headers: { authorization: 'Bearer ' + member } });
    assert.ok([401, 403].includes(denied.status), `${p} denied for a non-admin: ${denied.status}`);
    const anon = await fetch(base + p);
    assert.equal(anon.status, 401, `${p} needs a sign-in`);
  }
});
