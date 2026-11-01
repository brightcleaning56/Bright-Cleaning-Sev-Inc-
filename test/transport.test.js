'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, makeStore } = require('./helpers');
const { createTransport, toPostmarkBody, POSTMARK_URL } = require('../src/transport');
const { dispatchBid } = require('../src/service');
const { createOrg, addContact, verifyContact } = require('../src/service');
const { transitionBid } = require('../src/domain/bids');

const MESSAGE = {
  to: 'estimator@demo-gc.example', toCompany: 'Demo General Builders',
  from: 'owner@brightclean.example', fromName: 'Bright Clean Inc.',
  subject: 'Proposal: Demo Retail (DEMO-2026-0002)', html: '<p>Proposal</p>',
  purpose: 'bid_submission', opportunityId: 'opp_1', proposalId: 'prop_1', isReply: false,
  unsubscribeUrl: null, postalAddress: { line1: '1 St' }, permitId: 'DEMO-2026-0002',
};

function stubFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

function liveConfig(extra = {}) {
  const { env } = makeEnv({ BUILDINTEL_SEND_MODE: 'live', BUILDINTEL_EMAIL_PROVIDER: 'postmark', BUILDINTEL_POSTMARK_TOKEN: 'pm-test-token', ...extra });
  return makeStore(env).config;
}

test('the Postmark request has the right endpoint, auth header, stream, and body', async () => {
  const calls = [];
  const t = createTransport(liveConfig(), { fetchImpl: stubFetch(200, { ErrorCode: 0, Message: 'OK', MessageID: 'm-1', SubmittedAt: '2026-11-01T12:00:00Z' }, calls) });
  await t.send(MESSAGE);
  assert.equal(calls[0].url, POSTMARK_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Postmark-Server-Token'], 'pm-test-token');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.From, 'Bright Clean Inc. <owner@brightclean.example>');
  assert.equal(body.To, 'estimator@demo-gc.example');
  assert.equal(body.MessageStream, 'outbound');
  assert.equal(body.Subject, MESSAGE.subject);
});

test('a successful send returns the MessageID and SubmittedAt as the receipt', async () => {
  const t = createTransport(liveConfig(), { fetchImpl: stubFetch(200, { ErrorCode: 0, MessageID: 'm-42', SubmittedAt: '2026-11-01T12:00:00Z' }) });
  const receipt = await t.send(MESSAGE);
  assert.deepEqual(receipt, { providerMessageId: 'm-42', acceptedAt: '2026-11-01T12:00:00Z' });
});

test('a Postmark error code is a failure, never a receipt', async () => {
  const t = createTransport(liveConfig(), { fetchImpl: stubFetch(422, { ErrorCode: 300, Message: 'Invalid email request' }) });
  await assert.rejects(t.send(MESSAGE), /Postmark rejected.*300/);
});

test('a success response without a MessageID is not counted as sent', async () => {
  const t = createTransport(liveConfig(), { fetchImpl: stubFetch(200, { ErrorCode: 0, Message: 'OK' }) });
  await assert.rejects(t.send(MESSAGE), /not counted as sent/);
});

test('a network failure is a failure', async () => {
  const t = createTransport(liveConfig(), { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(t.send(MESSAGE), /ECONNRESET/);
});

test('live mode refuses to start without a provider or a token', () => {
  const { config: noProvider } = makeStore(makeEnv({ BUILDINTEL_SEND_MODE: 'live' }).env);
  assert.throws(() => createTransport(noProvider), /BUILDINTEL_EMAIL_PROVIDER=postmark/);
  const { config: noToken } = makeStore(makeEnv({ BUILDINTEL_SEND_MODE: 'live', BUILDINTEL_EMAIL_PROVIDER: 'postmark' }).env);
  assert.throws(() => createTransport(noToken), /BUILDINTEL_POSTMARK_TOKEN is required/);
});

test('dry run never calls the network', async () => {
  let called = false;
  const { env } = makeEnv();
  const { config } = makeStore(env);
  const t = createTransport(config, { fetchImpl: async () => { called = true; throw new Error('no'); } });
  assert.equal(t.mode, 'dry_run');
  await assert.rejects(t.send(MESSAGE), /cannot send/);
  assert.equal(called, false);
});

test('toPostmarkBody falls back to the bare sender address when no name is given', () => {
  const body = toPostmarkBody({ ...MESSAGE, fromName: null }, 'outbound');
  assert.equal(body.From, 'owner@brightclean.example');
});

test('a live dispatch with a Postmark receipt marks the bid sent, end to end', async () => {
  const { env } = makeEnv({ BUILDINTEL_SEND_MODE: 'live', BUILDINTEL_EMAIL_PROVIDER: 'postmark', BUILDINTEL_POSTMARK_TOKEN: 'pm-test-token' });
  const { store, config } = makeStore(env);
  const { org } = createOrg(store, {
    name: 'Bright Clean Inc.', legalName: 'Bright Clean Inc.', email: 'owner@brightclean.example',
    postalAddress: { line1: '123 Main St', city: 'Des Moines', state: 'IA', postalCode: '50309' },
    territories: [{ state: 'IA', cities: [] }],
  });
  const contact = verifyContact(store, org.id, addContact(store, org.id, { company: 'GC', email: 'gc@demo-gc.example' }).id, { status: 'verified', source: 'test', actor: 'owner' });
  // Build the state a real cycle produces: an approved bid with a proposal and a verified recipient.
  const permit = store.insert('permits', { id: 'permit_x', permitId: 'X-1', projectName: 'X', propertyAddress: '1 St', city: 'Des Moines', state: 'IA', projectType: 'office', sourceUrl: 'https://x.example', confidence: 'verified', permitStatus: 'issued', isSample: false, squareFeet: 9000, dedupeKey: 'k', lastVerifiedAt: '2026-10-30T00:00:00Z', gc: 'GC' });
  const opp = store.insert('opportunities', { orgId: org.id, permitId: permit.id, status: 'new', reasons: [], needsReview: false });
  const proposal = store.insert('proposals', { orgId: org.id, opportunityId: opp.id, status: 'approved', subject: 'Proposal: X', html: '<p>x</p>', estimate: {} });
  const recipient = store.list('contacts', org.id)[0];
  const bid = store.insert('bids', {
    orgId: org.id, opportunityId: opp.id, proposalId: proposal.id, recipientContactId: recipient.id,
    status: 'draft', total: 100, history: [], receipt: null, blockers: [],
  });
  store.update('bids', org.id, bid.id, transitionBid(bid, 'approved', { actor: 'owner', note: 'test' }));
  const transport = createTransport(config, { fetchImpl: stubFetch(200, { ErrorCode: 0, MessageID: 'm-e2e', SubmittedAt: '2026-11-01T12:00:00Z' }) });
  const result = await dispatchBid({ store, config, transport, orgId: org.id, bidId: bid.id });
  assert.equal(result.status, 'sent');
  const sent = store.get('bids', org.id, bid.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.receipt.providerMessageId, 'm-e2e');
});
