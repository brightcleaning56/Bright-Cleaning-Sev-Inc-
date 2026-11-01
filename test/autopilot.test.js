'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { makeEnv, makeStore, seedBrightClean } = require('./helpers');
const { runCycle } = require('../src/autopilot');
const { createTransport } = require('../src/transport');
const { addContact, verifyContact, unsubscribe, approveBid, dispatchBid } = require('../src/service');

function setup(opts = {}) {
  const { env, dir } = makeEnv();
  const { store, config } = makeStore(env);
  const seeded = seedBrightClean(store, opts);
  const transport = createTransport(config); // dry_run by default
  return { store, config, transport, dir, ...seeded };
}

const statusOf = (report, permitId) => {
  for (const org of report.orgs) {
    const r = org.results.find((x) => x.permit === permitId);
    if (r) return r.status;
  }
  return undefined;
};

test('full cycle: matches, prices, drafts, routes to owner, previews, and never claims a send', async () => {
  const { store, config, transport, org } = setup();
  const report = await runCycle({ store, config, transport, now: new Date('2026-11-01T12:00:00Z') });

  assert.equal(report.sources.find((s) => s.sourceId === 'sample-demo').status, 'ok');
  assert.ok(report.sources.filter((s) => s.status === 'blocked').length >= 2, 'unreviewed sources stay blocked');

  // DEMO-0001 is unconfirmed, so it needs a human even though it has a verified GC.
  assert.equal(statusOf(report, 'DEMO-2026-0001'), 'awaiting_owner');
  // DEMO-0002 is probable, under the auto-approval limit, and to a verified GC, so it is previewed (not sent).
  assert.equal(statusOf(report, 'DEMO-2026-0002'), 'approved');
  // DEMO-0003 has no square footage and the tenant has a 5,000 sq ft minimum, so it is
  // excluded at matching. The system must not guess a size to make it qualify.
  assert.equal(statusOf(report, 'DEMO-2026-0003'), undefined);
  const demo3 = store.list('permits', null).find((p) => p.permitId === 'DEMO-2026-0003');
  assert.equal(store.list('opportunities', org.id, (o) => o.permitId === demo3.id).length, 0, 'no opportunity created for an unsized permit');

  const bids = store.list('bids', org.id);
  assert.ok(bids.every((b) => b.status !== 'sent'), 'nothing is marked sent in dry-run mode');
  const previewed = bids.find((b) => b.dispatch && b.dispatch.mode === 'dry_run');
  assert.ok(previewed, 'approved bid was previewed');
  assert.ok(fs.existsSync(previewed.dispatch.previewFile));
  const preview = JSON.parse(fs.readFileSync(previewed.dispatch.previewFile, 'utf8'));
  assert.equal(preview.purpose, 'bid_submission');
  assert.equal(preview.to, 'estimator@demo-gc.example');
  assert.equal(preview.from, 'owner@brightclean.example');
});

test('re-running the cycle does not duplicate opportunities or bids', async () => {
  const { store, config, transport, org } = setup();
  await runCycle({ store, config, transport, now: new Date('2026-11-01T12:00:00Z') });
  const before = store.list('opportunities', org.id).length;
  const bidsBefore = store.list('bids', org.id).length;
  const second = await runCycle({ store, config, transport, now: new Date('2026-11-01T12:30:00Z') });
  assert.equal(store.list('opportunities', org.id).length, before);
  assert.equal(store.list('bids', org.id).length, bidsBefore);
  assert.equal(second.orgs[0].matched, 0);
});

test('without rate cards nothing is priced: the system needs owner pricing first', async () => {
  const { store, config, transport, org } = setup({ withPricing: false });
  const report = await runCycle({ store, config, transport, now: new Date('2026-11-01T12:00:00Z') });
  assert.equal(statusOf(report, 'DEMO-2026-0002'), 'needs_pricing');
  assert.equal(store.list('bids', org.id).length, 0, 'no bid is created without a price');
  assert.equal(store.list('proposals', org.id).length, 0);
});

test('without a verified GC contact no recipient is invented', async () => {
  const { store, config, transport, org } = setup({ withContact: false });
  const report = await runCycle({ store, config, transport, now: new Date('2026-11-01T12:00:00Z') });
  assert.equal(statusOf(report, 'DEMO-2026-0002'), 'needs_recipient');
  const bid = store.list('bids', org.id)[0];
  assert.equal(bid.status, 'draft');
  assert.equal(bid.recipientContactId, null);
});

test('an unsubscribe immediately blocks bids to that address across tenants', async () => {
  const { store, config, transport, org, contact } = setup();
  unsubscribe(store, 'estimator@demo-gc.example');
  const report = await runCycle({ store, config, transport, now: new Date('2026-11-01T12:00:00Z') });
  assert.equal(store.get('contacts', org.id, contact.id).status, 'opted_out');
  assert.notEqual(statusOf(report, 'DEMO-2026-0002'), 'approved');
});

test('a bid above the auto-approval limit waits for the owner, and owner approval previews it', async () => {
  const { store, config, transport, org } = setup({ autopilot: { enabled: true, autoApproveMaxTotal: 100 } });
  const report = await runCycle({ store, config, transport, now: new Date('2026-11-01T12:00:00Z') });
  assert.equal(statusOf(report, 'DEMO-2026-0002'), 'awaiting_owner');
  const pending = store.list('bids', org.id, (b) => b.status === 'pending_approval')[0];
  assert.ok(pending);
  approveBid(store, org.id, pending.id, 'user:owner');
  const result = await dispatchBid({ store, config, transport, orgId: org.id, bidId: pending.id });
  assert.equal(result.status, 'approved');
  assert.equal(result.mode, 'dry_run');
  assert.equal(store.get('bids', org.id, pending.id).status, 'approved', 'dry run never moves a bid to sent');
});

test('the organisation with autopilot disabled is skipped entirely', async () => {
  const { store, config, transport, org } = setup({ autopilot: { enabled: false, autoApproveMaxTotal: 0 } });
  const report = await runCycle({ store, config, transport, now: new Date('2026-11-01T12:00:00Z') });
  assert.match(report.orgs[0].skipped, /disabled/);
  assert.equal(store.list('opportunities', org.id).length, 0);
});

test('live send mode with no provider adapter refuses to start', () => {
  const { env } = makeEnv({ BUILDINTEL_SEND_MODE: 'live' });
  const { config } = makeStore(env);
  assert.throws(() => createTransport(config), /needs an email provider adapter/);
});

async function approvedBidAfterCycle() {
  const ctx = setup();
  await runCycle({ store: ctx.store, config: ctx.config, transport: ctx.transport, now: new Date('2026-11-01T12:00:00Z') });
  const bid = ctx.store.list('bids', ctx.org.id, (b) => b.status === 'approved')[0];
  assert.ok(bid, 'precondition: an approved bid exists');
  return { ...ctx, bid, liveConfig: { ...ctx.config, sendMode: 'live' } };
}

test('live mode marks a bid sent only with a provider acceptance receipt', async () => {
  const { store, org, bid, liveConfig } = await approvedBidAfterCycle();
  const okTransport = {
    async send() { return { providerMessageId: 'prov-1', acceptedAt: '2026-11-01T12:00:00Z' }; },
    async preview() { throw new Error('preview must not be used in live mode'); },
  };
  const result = await dispatchBid({ store, config: liveConfig, transport: okTransport, orgId: org.id, bidId: bid.id });
  assert.equal(result.status, 'sent');
  const sent = store.get('bids', org.id, bid.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.receipt.providerMessageId, 'prov-1');
});

test('live mode fails the bid when the provider returns no receipt', async () => {
  const { store, org, bid, liveConfig } = await approvedBidAfterCycle();
  const silentTransport = {
    async send() { return {}; },
    async preview() { return { file: 'x' }; },
  };
  const result = await dispatchBid({ store, config: liveConfig, transport: silentTransport, orgId: org.id, bidId: bid.id });
  assert.equal(result.status, 'failed');
  const failed = store.get('bids', org.id, bid.id);
  assert.equal(failed.status, 'failed', 'a bid with no receipt must never read as sent');
  assert.equal(failed.receipt, null);
});

test('dispatch refuses a bid that is not approved', async () => {
  const { store, org, config, transport } = setup();
  const bid = store.insert('bids', {
    orgId: org.id, opportunityId: 'none', proposalId: null, recipientContactId: null,
    status: 'draft', total: 1, history: [], receipt: null,
  });
  await assert.rejects(dispatchBid({ store, config, transport, orgId: org.id, bidId: bid.id }), /not approved/);
});

test('the store refuses cross-tenant reads: tenant data is scoped to its own org', async () => {
  const { store, org } = setup();
  assert.throws(() => store.list('bids', undefined), /orgId is required/);
  assert.equal(store.list('bids', 'some-other-org').length, 0);
  assert.ok(org.id);
});
