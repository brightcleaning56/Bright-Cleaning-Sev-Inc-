import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { enqueueEmail, drainOutbox, outboxCounts, MAX_ATTEMPTS } from '../src/outbox.js';
import { config } from '../src/config.js';

const ok = async () => ({ ok: true, json: async () => ({ MessageID: 'm-1' }), status: 200 });
const down = async () => { throw new Error('mail service unavailable'); };
const T0 = Date.now() + 1000;   // just after the enqueue time, so the message is due
const mins = n => T0 + n * 60e3;

test('a queued message is sent once and logged; a second drain does not resend it', async () => {
  const store = new Store(null);
  config.emailMode = 'live'; config.postmarkToken = 't'; config.emailDomainVerified = true;
  const row = enqueueEmail(store, { orgId: 'o1', kind: 'award_notice', to: 'a@x.test', subject: 'Hi', text: 'Body' });
  assert.equal(row.status, 'pending');
  const r1 = await drainOutbox(store, { fetchImpl: ok, at: T0 });
  assert.equal(r1.sent, 1);
  assert.equal(store.get('outbox', row.id).status, 'sent');
  assert.equal(store.list('messages', m => m.kind === 'award_notice' && m.messageId === 'm-1').length, 1);
  const r2 = await drainOutbox(store, { fetchImpl: ok, at: mins(60) });
  assert.equal(r2.sent, 0, 'nothing is sent twice');
});

test('a failed send is kept and retried later, with a growing wait, and succeeds when mail recovers', async () => {
  const store = new Store(null);
  config.emailMode = 'live'; config.postmarkToken = 't'; config.emailDomainVerified = true;
  const row = enqueueEmail(store, { orgId: 'o1', kind: 'regret_notice', to: 'b@x.test', subject: 'Hi', text: 'Body' });
  const first = await drainOutbox(store, { fetchImpl: down, at: T0 });
  assert.equal(first.retrying, 1);
  const kept = store.get('outbox', row.id);
  assert.equal(kept.status, 'pending');
  assert.equal(kept.attempts, 1);
  assert.match(kept.lastError, /unavailable/);
  assert.equal(await drainOutbox(store, { fetchImpl: ok, at: T0 + 30e3 }).then(r => r.sent), 0, 'not yet due');
  assert.equal((await drainOutbox(store, { fetchImpl: ok, at: T0 + 61e3 })).sent, 1, 'due after the first wait, and mail is back');
  assert.equal(store.get('outbox', row.id).status, 'sent');
});

test('after the last attempt the message is marked failed and the reason is in the log', async () => {
  const store = new Store(null);
  config.emailMode = 'live'; config.postmarkToken = 't'; config.emailDomainVerified = true;
  const row = enqueueEmail(store, { orgId: 'o1', kind: 'rfi_answer', to: 'c@x.test', subject: 'Hi', text: 'Body' });
  let at = T0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) { await drainOutbox(store, { fetchImpl: down, at }); at += 40 * 60e3; }
  assert.equal(store.get('outbox', row.id).status, 'failed');
  assert.equal(store.get('outbox', row.id).attempts, MAX_ATTEMPTS);
  assert.equal(store.list('messages', m => m.kind === 'rfi_answer' && m.error).length, 1);
  assert.equal(outboxCounts(store).failed, 1);
  assert.equal((await drainOutbox(store, { fetchImpl: ok, at })).sent, 0, 'a failed message is not retried by itself');
});

test('in dry-run mode the message is logged with its preview and nothing is sent', async () => {
  const store = new Store(null);
  config.emailMode = 'dry-run';
  enqueueEmail(store, { orgId: 'o1', kind: 'award_notice', to: 'd@x.test', subject: 'Hi', text: 'Preview text' });
  let called = false;
  await drainOutbox(store, { fetchImpl: async () => { called = true; return ok(); }, at: Date.now() });
  assert.equal(called, false);
  assert.equal(store.list('messages', m => m.kind === 'award_notice')[0].preview, 'Preview text');
});
