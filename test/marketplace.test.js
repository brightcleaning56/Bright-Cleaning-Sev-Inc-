import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { runCycle } from '../src/autopilot.js';
import { createRequest, awardRequest, validateRequest } from '../src/marketplace.js';
import { draftRateCard, approveRateCard, estimateOpportunity, activeRateCards } from '../src/estimate.js';
import { handleInbound, runRetention, analytics, importDirectory, directoryGaps, requeueNeedsContact, sendFollowUps } from '../src/engagement.js';
import { transition } from '../src/domain.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { world, authorize, RATE, DALLAS_ROWS, stubFetch } from './_fixtures.js';

const future = (d = 10) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const JAN = { ...RATE, serviceName: 'Nightly janitorial', category: 'janitorial', productionRate: 3000, mobilization: 20, minimumPrice: 90 };

function withBuyer(w, kind = 'property_manager') {
  const buyer = w.store.put('orgs', { slug: 'pm-1', name: 'Acme Property Management', kind: 'buyer', buyerKind: kind, status: 'active', legal: {}, settings: {} });
  const buyerUser = w.store.put('users', { email: 'pm@acme.test', role: 'owner', orgId: buyer.id, passwordHash: hashPassword('pm owner password') });
  return { buyer, buyerUser };
}

test('request validation: real quantities and future due dates required; janitorial needs frequency', () => {
  const base = { title: 'Office', address: '1 A St', city: 'Ankeny', state: 'IA', squareFeet: 20000, projectType: 'office', services: ['janitorial'], dueDate: future() };
  assert.ok(validateRequest(base).some(e => /frequencyPerMonth/.test(e)));
  assert.ok(validateRequest({ ...base, frequencyPerMonth: 20, squareFeet: 0 }).some(e => /squareFeet/.test(e)));
  assert.ok(validateRequest({ ...base, frequencyPerMonth: 20, dueDate: '2020-01-01' }).some(e => /dueDate/.test(e)));
  assert.deepEqual(validateRequest({ ...base, frequencyPerMonth: 20 }), []);
});

test('recurring janitorial: monthly price = per-visit price × visits', () => {
  const w = world();
  const rc = draftRateCard(w.store, w.org.id, JAN, 'o').rateCard; approveRateCard(w.store, w.org.id, rc.id, 'o', 'owner');
  const est = estimateOpportunity(activeRateCards(w.store, w.org.id), { projectType: 'office', squareFeet: 20000 }, { categories: ['janitorial'], frequencyPerMonth: 20 });
  assert.equal(est.lines.length, 1); assert.equal(est.recurring, 'monthly');
  assert.equal(est.lines[0].price, Math.round(est.lines[0].perVisit * 20 * 100) / 100);
});

test('marketplace end to end: buyer request → autopilot proposal → delivered to inbox → award; buyer never sees costs', async () => {
  const w = world(); const { buyer, buyerUser } = withBuyer(w);
  const rc = draftRateCard(w.store, w.org.id, JAN, 'o').rateCard; approveRateCard(w.store, w.org.id, rc.id, 'o', 'owner');
  w.org.settings.autoApprove = { enabled: true, maxTotal: 50000, minScore: 90 };
  const r = createRequest(w.store, buyer, buyerUser, { title: 'Nightly cleaning, 3 floors', address: '900 SW Oralabor Rd', city: 'Ankeny', state: 'IA',
    squareFeet: 24000, projectType: 'office', services: ['janitorial'], frequencyPerMonth: 20, dueDate: future() }).request;
  config.emailMode = 'dry-run'; // marketplace delivery does not depend on email
  await runCycle(w.store, {});
  const [bid] = w.store.tlist('bids', w.org.id, b => b.channel === 'marketplace');
  assert.equal(bid.status, 'delivered');
  const [sub] = w.store.list('submissions', s => s.requestId === r.id);
  assert.equal(sub.sellerName, 'Bright Clean Inc.'); assert.equal(sub.recurring, 'monthly');
  assert.ok(!('estimate' in sub) && !/laborRate|payrollBurden|targetMargin/.test(sub.proposalHtml));
  assert.match(sub.proposalHtml, /Total per month/);
  await runCycle(w.store, {}); // idempotent: no duplicate bid for the same request
  assert.equal(w.store.list('submissions', s => s.requestId === r.id).length, 1);
  assert.throws(() => awardRequest(w.store, buyer, buyerUser, r.id, sub.id, { signerName: 'Dana Ruiz' }), /consent/);
  const out = awardRequest(w.store, buyer, buyerUser, r.id, sub.id, { signerName: 'Dana Ruiz', consent: true, ip: '203.0.113.9', userAgent: 'test' });
  assert.equal(out.winner.sellerName, 'Bright Clean Inc.');
  assert.equal(w.store.tget('bids', w.org.id, bid.id).status, 'awarded');
  assert.equal(analytics(w.store, w.org.id).byChannel.marketplace.winRate, 100);
});

test('unverified buyers cannot post; outside service area is not bid', async () => {
  const w = world(); const { buyer, buyerUser } = withBuyer(w);
  buyer.status = 'pending_verification';
  assert.throws(() => createRequest(w.store, buyer, buyerUser, {}), /verify/);
  buyer.status = 'active';
  createRequest(w.store, buyer, buyerUser, { title: 'Phoenix job', address: '1 Main', city: 'Phoenix', state: 'AZ', squareFeet: 10000, projectType: 'retail', services: ['post_construction'], dueDate: future() });
  await runCycle(w.store, {});
  assert.equal(w.store.list('submissions').length, 0);
  assert.ok(w.store.tlist('opportunities', w.org.id, o => o.requestId)[0].blockers.includes('outside service area'));
});

test('inbound reply attaches to the bid, flags it, and "remove me" suppresses the sender', () => {
  const w = world();
  const bid = w.store.tput('bids', w.org.id, { status: 'sent', total: 1, recipientIds: [] });
  assert.equal(handleInbound(w.store, { MailboxHash: bid.id, FromFull: { Email: 'pat@weitz.test' }, Subject: 'Re: proposal', StrippedTextReply: 'Can you walk it Tuesday?' }).ok, true);
  assert.equal(w.store.tget('bids', w.org.id, bid.id).needsAttention, true);
  assert.equal(w.store.isSuppressed('pat@weitz.test'), false);
  handleInbound(w.store, { MailboxHash: bid.id, FromFull: { Email: 'pat@weitz.test' }, Subject: 'Re', StrippedTextReply: 'Please remove me from your list' });
  assert.equal(w.store.isSuppressed('pat@weitz.test'), true);
});

test('follow-up: exactly one, only after the delay, never after a reply', async () => {
  const w = world(); authorize(w.store, 'dallas-socrata');
  w.org.settings = { ...w.org.settings, autoApprove: { enabled: true, maxTotal: 10000, minScore: 90 }, liveSending: true, followUpDays: 5 };
  Object.assign(config, { emailMode: 'live', postmarkToken: 't', emailDomainVerified: true, inboundReplyAddress: 'abc@inbound.postmarkapp.com' });
  const sent = []; let n = 0;
  const fetchImpl = stubFetch([['dallasopendata.com', () => ({ body: DALLAS_ROWS })], ['postmarkapp.com', (u, o) => { sent.push(JSON.parse(o.body)); return { body: { MessageID: 'm' + (++n) } }; }]]);
  try {
    await runCycle(w.store, { fetchImpl });
    const [bid] = w.store.tlist('bids', w.org.id);
    assert.equal(sent[0].ReplyTo, `abc+${bid.id}@inbound.postmarkapp.com`);
    assert.equal((await sendFollowUps(w.store, w.org, { fetchImpl })).sent, 0); // too early
    bid.history.find(h => h.to === 'sent').at = new Date(Date.now() - 6 * 864e5).toISOString();
    assert.equal((await sendFollowUps(w.store, w.org, { fetchImpl })).sent, 1);
    assert.match(sent.at(-1).Subject, /^Following up/); assert.match(sent.at(-1).TextBody, /100 Test St/);
    assert.equal((await sendFollowUps(w.store, w.org, { fetchImpl })).sent, 0); // never twice
    // a different bid with a reply is never chased
    const b2 = w.store.tput('bids', w.org.id, { ...bid, id: undefined, followUpSentAt: null, replies: [{ from: 'x' }] });
    assert.equal((await sendFollowUps(w.store, w.org, { fetchImpl })).sent, 0);
  } finally { Object.assign(config, { emailMode: 'dry-run', postmarkToken: '', emailDomainVerified: false, inboundReplyAddress: '' }); }
});

test('directory: bulk import validates rows, gaps rank blocked value, adding a contact requeues bids', async () => {
  const w = world(); authorize(w.store, 'dallas-socrata');
  const rows = DALLAS_ROWS.map(r => r.permit_number === 'BU-1003' ? { ...r, area: '18000', contractor: 'Turner Construction Co' } : r);
  await runCycle(w.store, { fetchImpl: stubFetch([['dallasopendata.com', () => ({ body: rows })]]) });
  const gaps = directoryGaps(w.store, w.org.id);
  assert.equal(gaps[0].contractor, 'Turner Construction Co'); assert.ok(gaps[0].blockedValue > 0);
  const r = importDirectory(w.store, [
    'company,website,contactName,role,email,status,evidenceUrl',
    'Turner Construction Company,https://turner.test,Dallas Estimating,Estimating,bids-dallas@turner.test,source_confirmed,https://turner.test/subcontractors',
    'Bad Row Inc,,Joe,PM,joe@gmail.com,verified,',
  ].join('\n'), 'eric');
  assert.deepEqual([r.companies, r.contacts, r.errors.length], [1, 1, 1]);
  assert.equal(requeueNeedsContact(w.store), 1);
  config.emailMode = 'dry-run';
  await runCycle(w.store, { fetchImpl: stubFetch([['dallasopendata.com', () => ({ body: rows })]]) });
  assert.equal(w.store.tlist('bids', w.org.id).length, 2);
  assert.equal(directoryGaps(w.store, w.org.id).length, 0);
});

test('retention: expired sessions and old previews removed; stale contacts marked outdated', () => {
  const w = world();
  w.store.put('sessions', { id: 's1', userId: 'u', expiresAt: '2020-01-01T00:00:00Z' });
  const m = w.store.put('messages', { dryRun: true }); m.createdAt = '2020-01-01T00:00:00Z';
  w.contact.verifiedAt = '2020-01-01T00:00:00Z';
  const r = runRetention(w.store);
  assert.deepEqual([r.sessions, r.previews, r.staleContacts], [1, 1, 1]);
  assert.equal(w.store.get('contacts', w.contact.id).status, 'outdated');
});

test('HTTP: buyer signup → email verification link → post request; buyers blocked from seller data', async (t) => {
  const w = world();
  const srv = createServer(w.store).listen(0); await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) }); const tx = await r.text(); try { return { status: r.status, body: JSON.parse(tx) }; } catch { return { status: r.status, body: tx }; } };
  assert.equal((await call('POST', '/api/signup/buyer', { company: 'Ryan Companies', kind: 'general_contractor', name: 'Sam', email: 'sam@ryan.test', password: 'long enough password' })).status, 200);
  const tok = (await call('POST', '/api/login', { email: 'sam@ryan.test', password: 'long enough password' })).body.token;
  const req = { title: 'Final clean, new clinic', address: '1200 SE Delaware Ave', city: 'Ankeny', state: 'IA', squareFeet: 15000, projectType: 'medical', services: ['post_construction'], dueDate: future() };
  assert.equal((await call('POST', '/api/requests', req, tok)).status, 400); // not verified yet
  const link = w.store.list('messages', m => m.kind === 'verification')[0].link;
  assert.equal((await fetch(link.replace(config.baseUrl, base))).status, 200);
  // A confirmed email is not authority to publish construction projects: BUILDINTEL staff verify the company first.
  const blocked = await call('POST', '/api/requests', req, tok);
  assert.equal(blocked.status, 409); assert.match(blocked.body.error, /Company verified as a publisher/);
  assert.equal((await call('POST', '/api/publisher/verification', { website: 'https://www.ryancompanies.com', licenseNumber: 'IA-C123' }, tok)).body.status, 'pending');
  const { decideVerification } = await import('../src/publishing.js');
  decideVerification(w.store, { email: 'staff@buildintel.test' }, w.store.list('users', u => u.email === 'sam@ryan.test')[0].orgId, { status: 'verified', note: 'Iowa contractor registration checked' });
  const posted = await call('POST', '/api/requests', req, tok);
  assert.equal(posted.status, 200); assert.ok(posted.body.publicationId);
  assert.equal((await call('POST', '/api/rate-cards', RATE, tok)).status, 403);
  assert.equal((await call('GET', '/api/rate-cards', undefined, tok)).body.length, 0);
});

test('permit bids never include recurring janitorial lines', async () => {
  const w = world(); authorize(w.store, 'dallas-socrata');
  const rc = draftRateCard(w.store, w.org.id, JAN, 'o').rateCard; approveRateCard(w.store, w.org.id, rc.id, 'o', 'owner');
  await runCycle(w.store, { fetchImpl: stubFetch([['dallasopendata.com', () => ({ body: DALLAS_ROWS })]]) });
  const opp = w.store.tlist('opportunities', w.org.id).find(o => o.status === 'bid_drafted');
  assert.deepEqual(opp.estimate.lines.map(l => l.service), ['Final construction clean']);
  assert.equal(opp.estimate.total, 3823.38);
});
