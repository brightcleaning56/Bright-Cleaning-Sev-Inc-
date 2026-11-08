import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { notificationPrefs, batchingGate, recordNotificationSent } from '../src/digest.js';

const at = iso => new Date(iso);

test('defaults are immediate with a cap of 3 emails a day, and out-of-range values are clamped', () => {
  assert.deepEqual(notificationPrefs({}), { mode: 'immediate', maxPerDay: 3 });
  assert.deepEqual(notificationPrefs({ settings: { notifications: { mode: 'daily_digest', maxPerDay: 500 } } }), { mode: 'daily_digest', maxPerDay: 20 });
  assert.equal(notificationPrefs({ settings: { notifications: { maxPerDay: 0 } } }).maxPerDay, 3);
});

test('a daily digest sends at most one batch per 24 hours; immediate mode sends each batch', () => {
  const org = { settings: {} };
  const digest = { mode: 'daily_digest', maxPerDay: 10 };
  assert.equal(batchingGate(org, digest, at('2026-11-08T09:00:00Z')).send, true);
  recordNotificationSent(org, at('2026-11-08T09:00:00Z'));
  const later = batchingGate(org, digest, at('2026-11-08T18:00:00Z'));
  assert.equal(later.send, false);
  assert.match(later.reason, /24 hours/);
  assert.equal(batchingGate(org, digest, at('2026-11-09T09:30:00Z')).send, true, 'next day it goes out');
  const immediate = { mode: 'immediate', maxPerDay: 10 };
  recordNotificationSent(org, at('2026-11-09T09:30:00Z'));
  assert.equal(batchingGate(org, immediate, at('2026-11-09T10:00:00Z')).send, true, 'immediate mode is not held back by the digest window');
});

test('the daily cap stops emails once reached, and resets the next day', () => {
  const org = { settings: {} };
  const prefs = { mode: 'immediate', maxPerDay: 2 };
  recordNotificationSent(org, at('2026-11-08T08:00:00Z'));
  recordNotificationSent(org, at('2026-11-08T09:00:00Z'));
  const capped = batchingGate(org, prefs, at('2026-11-08T10:00:00Z'));
  assert.equal(capped.send, false);
  assert.match(capped.reason, /limit/);
  assert.equal(batchingGate(org, prefs, at('2026-11-09T08:00:00Z')).send, true);
});

test('over HTTP: only a company owner can read or change the setting, and bad values are refused', async t => {
  const store = new Store(null);
  const co = store.put('orgs', { slug: 'sp', name: 'Sparky', status: 'active', subscription: { plan: 'local' }, settings: {} });
  store.put('users', { email: 'owner@sp.test', orgId: co.id, role: 'owner', passwordHash: hashPassword('correct horse battery 1') });
  store.put('users', { email: 'member@sp.test', orgId: co.id, role: 'member', passwordHash: hashPassword('correct horse battery 1') });
  const srv = createServer(store).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async email => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery 1' }) })).json()).token;
  const owner = await login('owner@sp.test');
  const member = await login('member@sp.test');
  const H = tok => ({ 'content-type': 'application/json', authorization: 'Bearer ' + tok });
  const put = (tok, body) => fetch(base + '/api/me/notifications', { method: 'PUT', headers: H(tok), body: JSON.stringify(body) });
  assert.equal((await put(owner, { mode: 'urgent' })).status, 400);
  assert.equal((await put(owner, { mode: 'daily_digest', maxPerDay: 99 })).status, 400);
  assert.equal((await put(member, { mode: 'daily_digest' })).status, 403, 'a team member cannot change it');
  const ok = await put(owner, { mode: 'daily_digest', maxPerDay: 5 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { mode: 'daily_digest', maxPerDay: 5 });
  const got = await (await fetch(base + '/api/me/notifications', { headers: H(owner) })).json();
  assert.equal(got.mode, 'daily_digest');
  assert.equal(got.maxPerDay, 5);
  assert.ok(store.data.audit.some(e => e.action === 'notifications.updated'), 'the change is audited');
});

test('every match states the trades it shares and the territory, in plain language', async () => {
  const { whyInvited } = await import('../src/marketplace.js');
  const why = whyInvited({ trades: ['electrical', 'plumbing'], subscription: { plan: 'local' } }, { trades: ['electrical', 'hvac'], state: 'IA' });
  assert.match(why, /Matches your trades \(electrical\)/);
  assert.match(why, /service area \(IA\)/);
  const national = whyInvited({ trades: ['cleaning'], subscription: { plan: 'national' } }, { trades: ['cleaning'], state: 'TX' });
  assert.match(national, /nationwide coverage/);
});
