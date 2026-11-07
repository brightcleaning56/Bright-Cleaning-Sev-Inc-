import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { runCycle, handleEmailEvent } from '../src/autopilot.js';
import { transition } from '../src/domain.js';
import { createBackup, restoreTest } from '../src/backup.js';
import { readiness } from '../src/readiness.js';
import { samgov } from '../src/sources/adapters.js';
import { world, authorize, DALLAS_ROWS, stubFetch } from './_fixtures.js';

const socrata = stubFetch([['dallasopendata.com', () => ({ body: DALLAS_ROWS })]]);

test('full cycle in dry-run: collect → qualify → estimate → draft → approve → preview, never marked sent', async () => {
  const { store, org } = world();
  authorize(store, 'dallas-socrata');
  config.emailMode = 'dry-run';
  const job = await runCycle(store, { fetchImpl: socrata });
  const c = job.collect.find(x => x.source === 'dallas-socrata');
  assert.deepEqual([c.inserted, c.skippedNonCommercial], [2, 1]);

  const opps = store.tlist('opportunities', org.id);
  const byPermit = Object.fromEntries(opps.map(o => [store.get('permits', o.permitId).permitId, o]));
  assert.equal(byPermit['BU-1001'].status, 'bid_drafted');
  assert.equal(byPermit['BU-1001'].estimate.total, 3823.38);
  assert.equal(byPermit['BU-1003'].status, 'needs_measurement'); // no sqft → no invented quantity

  const [bid] = store.tlist('bids', org.id);
  assert.equal(bid.status, 'pending_approval'); // human approval by default
  transition(store, bid, 'approved', 'owner@test');
  await runCycle(store, { fetchImpl: socrata });
  assert.equal(store.tget('bids', org.id, bid.id).status, 'approved'); // dry-run never marks sent
  const preview = store.list('messages', m => m.bidId === bid.id && m.dryRun && m.preview).pop().preview;
  assert.match(preview.TextBody, /100 Test St, Ankeny, IA 50023/);
  assert.match(preview.TextBody, /Unsubscribe: https:\/\/app\.buildintel\.test\/u\//);
  assert.ok(preview.Headers.some(h => h.Name === 'List-Unsubscribe'));
});

test('auto-approve rule approves only within owner limits', async () => {
  const { store, org } = world();
  authorize(store, 'dallas-socrata');
  org.settings.autoApprove = { enabled: true, maxTotal: 3000, minScore: 90 };
  await runCycle(store, { fetchImpl: socrata });
  assert.equal(store.tlist('bids', org.id)[0].status, 'pending_approval'); // $3,823 > $3,000 limit
  const { store: s2, org: o2 } = world();
  authorize(s2, 'dallas-socrata');
  o2.settings.autoApprove = { enabled: true, maxTotal: 5000, minScore: 90 };
  config.emailMode = 'dry-run';
  await runCycle(s2, { fetchImpl: socrata });
  assert.equal(s2.tlist('bids', o2.id)[0].status, 'approved');
});

test('live sending: sent only with a provider MessageID; webhooks drive delivery, bounce and suppression', async () => {
  const { store, org, contact } = world();
  authorize(store, 'dallas-socrata');
  org.settings.autoApprove = { enabled: true, maxTotal: 10000, minScore: 90 };
  org.settings.liveSending = true;
  Object.assign(config, { emailMode: 'live', postmarkToken: 'tok', emailDomainVerified: true });
  const sent = [];
  const fetchImpl = stubFetch([
    ['dallasopendata.com', () => ({ body: DALLAS_ROWS })],
    ['postmarkapp.com', (u, o) => { sent.push(JSON.parse(o.body)); return { body: { MessageID: 'pm-123', ErrorCode: 0 } }; }],
  ]);
  try {
    await runCycle(store, { fetchImpl });
    const [bid] = store.tlist('bids', org.id);
    assert.equal(bid.status, 'sent');
    assert.equal(sent.length, 1); assert.equal(sent[0].To, 'pat@weitz.test');
    handleEmailEvent(store, { RecordType: 'Delivery', MessageID: 'pm-123', DeliveredAt: '2026-11-01' });
    assert.equal(store.tget('bids', org.id, bid.id).status, 'delivered');
    handleEmailEvent(store, { RecordType: 'SpamComplaint', MessageID: 'pm-123' });
    assert.equal(store.isSuppressed(contact.email), true);
  } finally { Object.assign(config, { emailMode: 'dry-run', postmarkToken: '', emailDomainVerified: false }); }
});

test('live sending: provider error marks bid failed, not sent; missing postal address blocks sending', async () => {
  const { store, org } = world();
  authorize(store, 'dallas-socrata');
  org.settings.autoApprove = { enabled: true, maxTotal: 10000, minScore: 90 };
  org.settings.liveSending = true;
  Object.assign(config, { emailMode: 'live', postmarkToken: 'tok', emailDomainVerified: true });
  const fetchImpl = stubFetch([
    ['dallasopendata.com', () => ({ body: DALLAS_ROWS })],
    ['postmarkapp.com', () => ({ status: 422, body: { ErrorCode: 300, Message: 'Invalid email' } })],
  ]);
  try {
    await runCycle(store, { fetchImpl });
    const [bid] = store.tlist('bids', org.id);
    assert.equal(bid.status, 'failed');
    assert.equal(bid.receipts[0].error, 'Invalid email');

    const w2 = world(); authorize(w2.store, 'dallas-socrata');
    w2.org.legal.postalAddress = '';
    w2.org.settings.autoApprove = { enabled: true, maxTotal: 10000, minScore: 90 }; w2.org.settings.liveSending = true;
    await runCycle(w2.store, { fetchImpl });
    const b2 = w2.store.tlist('bids', w2.org.id)[0];
    assert.equal(b2.status, 'failed');
    assert.ok(b2.history.at(-1).detail.issues.some(i => /postal address/.test(i)));
  } finally { Object.assign(config, { emailMode: 'dry-run', postmarkToken: '', emailDomainVerified: false }); }
});

test('source failures are recorded, not swallowed', async () => {
  const { store } = world();
  authorize(store, 'dallas-socrata');
  await runCycle(store, { fetchImpl: stubFetch([['dallasopendata.com', () => ({ status: 503, body: {} })]]) });
  const s = store.list('sources', x => x.key === 'dallas-socrata')[0];
  assert.equal(s.lastError, 'socrata 503'); assert.ok(s.lastFailureAt);
});

test('SAM.gov adapter maps federal solicitations with deadlines and source links', async () => {
  process.env.SAM_API_KEY = 'k';
  const { store } = world();
  const src = { ...authorize(store, 'sam-gov'), rateLimitPerMin: 100000, adapterConfig: { naics: ['561720'], states: ['IA'] } };
  const rows = await samgov(src, { fetchImpl: stubFetch([['api.sam.gov', () => ({ body: { opportunitiesData: [
    { solicitationNumber: 'W9128F-26-Q-0001', title: 'Janitorial services, Camp Dodge', type: 'Solicitation', postedDate: '2026-10-28',
      responseDeadLine: '2026-11-20T17:00:00-05:00', uiLink: 'https://sam.gov/opp/abc/view', placeOfPerformance: { city: { name: 'Johnston' } } }] } })]]) });
  assert.equal(rows[0].permitId, 'W9128F-26-Q-0001');
  assert.equal(rows[0].responseDeadline, '2026-11-20T17:00:00-05:00');
  assert.equal(rows[0].sourceUrl, 'https://sam.gov/opp/abc/view');
  delete process.env.SAM_API_KEY;
});

test('backup: encrypted, restorable with matching checksum; tampering detected', () => {
  const { store } = world();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-'));
  const k = crypto.randomBytes(32).toString('hex');
  const b = createBackup(store, dir, k);
  assert.ok(!fs.readFileSync(b.file).toString('latin1').includes('Bright Clean')); // not plaintext
  assert.equal(restoreTest(b.file, b.checksum, k).ok, true);
  const buf = fs.readFileSync(b.file); buf[buf.length - 1] ^= 0xff; fs.writeFileSync(b.file, buf);
  assert.equal(restoreTest(b.file, b.checksum, k).ok, false);
});

test('readiness: fresh deployment is NO-GO and every gate carries evidence + an owner', () => {
  const { store } = world();
  const r = readiness(store);
  assert.equal(r.verdict, 'NO-GO');
  for (const g of r.gates) { assert.ok(g.evidence); assert.ok(g.owner); }
  assert.equal(r.gates.find(g => g.id === 'attorney').status, 'owner_action');
  assert.equal(r.gates.find(g => g.id === 'rates').status, 'pass');
});
