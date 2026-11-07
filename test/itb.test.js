import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { createRequest, inviteMatches, setIntent, submitBid, awardRequest, validateRequest } from '../src/marketplace.js';
import { runCycle } from '../src/autopilot.js';
import { contactFromProject } from '../src/outreach.js';
import { normName } from '../src/domain.js';

const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'Ryan Companies', kind: 'buyer', buyerKind: 'general_contractor', status: 'active', settings: {} });
  const gcUser = store.put('users', { email: 'pm@ryan.test', role: 'owner', orgId: gc.id });
  const mk = (slug, trades, territories, plan = 'local') => store.put('orgs', { slug, name: slug, kind: 'subscriber', trades, territories, status: 'active', settings: {}, legal: {}, subscription: { plan, status: 'active' } });
  const elec = mk('sparky-electric', ['electrical', 'low_voltage'], ['IA']);
  const roof = mk('prairie-roofing', ['roofing'], ['IA']);
  const farRoof = mk('texas-roofing', ['roofing'], ['TX']);
  const paint = mk('ia-painting', ['painting'], ['IA']);
  return { store, gc, gcUser, elec, roof, farRoof, paint };
}
const REQ = { title: 'New 3-story medical office', address: '1200 SE Delaware Ave', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['electrical', 'roofing'], dueDate: D(10), documentsUrl: 'https://plans.example/medical-office', description: 'Bid electrical and roofing scopes per plans.' };

test('GC request for any trade: validation no longer cleaning-only; square footage optional; links must be http(s)', () => {
  assert.deepEqual(validateRequest(REQ), []);
  assert.ok(validateRequest({ ...REQ, trades: [] }).some(e => /trade/.test(e)));
  assert.ok(validateRequest({ ...REQ, trades: ['plumbing', 'not_a_trade'] }).some(e => /unknown trade/.test(e)));
  assert.ok(validateRequest({ ...REQ, documentsUrl: 'javascript:alert(1)' }).some(e => /http/.test(e)));
  assert.ok(validateRequest({ ...REQ, services: ['post_construction'] }).some(e => /squareFeet is required/.test(e)));
});

test('invitations go only to matching trades in matching territory; late joiners are invited by the hourly pull', async () => {
  const w = world();
  const r = createRequest(w.store, w.gc, w.gcUser, REQ);
  assert.equal(r.invited, 2);
  const invited = w.store.list('invitations').map(i => w.store.get('orgs', i.sellerOrgId).slug).sort();
  assert.deepEqual(invited, ['prairie-roofing', 'sparky-electric']); // not Texas roofer, not painter
  const late = w.store.put('orgs', { slug: 'late-electric', name: 'Late', kind: 'subscriber', trades: ['electrical'], territories: ['IA'], status: 'active', settings: {}, legal: {}, subscription: { plan: 'trial', status: 'trialing', trialEndsAt: D(5) } });
  config.emailMode = 'dry-run'; config.platformFrom = 'alerts@buildintel.test';
  w.store.put('users', { email: 'owner@late.test', role: 'owner', orgId: late.id });
  const job = await runCycle(w.store, {});
  assert.equal(job.invited, 1);
  assert.ok(w.store.list('invitations', i => i.sellerOrgId === late.id).length === 1);
  assert.match(w.store.list('messages', m => m.kind === 'invitation_notice' && m.to === 'owner@late.test')[0].preview, /New 3-story medical office/);
  assert.equal(inviteMatches(w.store, r.request), 0); // idempotent
  config.platformFrom = '';
});

test('subcontractor: will bid → manual bid (escaped) → revise → GC compares and awards with signature', () => {
  const w = world();
  const { request } = createRequest(w.store, w.gc, w.gcUser, REQ);
  const inv = w.store.list('invitations', i => i.sellerOrgId === w.elec.id)[0];
  const sparkyUser = { email: 'est@sparky.test', id: 'u1' };
  assert.equal(setIntent(w.store, w.elec, sparkyUser, inv.id, 'will_bid').invitation.intent, 'will_bid');
  assert.equal(setIntent(w.store, w.roof, sparkyUser, inv.id, 'will_bid').code, 404); // can't touch another company's invitation
  assert.equal(submitBid(w.store, w.elec, sparkyUser, inv.id, { amount: '0', scope: 'x' }).code, 400);
  const b1 = submitBid(w.store, w.elec, sparkyUser, inv.id, { amount: '$412,500', scope: 'Complete electrical per E-series drawings <script>alert(1)</script>', documentUrl: 'https://sparky.example/bid.pdf' });
  assert.equal(b1.ok, true);
  const b2 = submitBid(w.store, w.elec, sparkyUser, inv.id, { amount: '398000', scope: 'Complete electrical per E-series drawings, value-engineered fixtures' });
  assert.equal(b2.submission.revision, 2);
  const subs = w.store.list('submissions', s => s.requestId === request.id);
  assert.equal(subs.length, 1); assert.equal(subs[0].total, 398000);
  assert.ok(!subs[0].proposalHtml.includes('<script>'));
  const awarded = awardRequest(w.store, w.gc, w.gcUser, request.id, subs[0].id, { signerName: 'Pat Manager', consent: true, ip: '1.2.3.4' });
  assert.equal(w.store.get('contracts', awarded.contractId).total, 398000);
  assert.equal(submitBid(w.store, w.elec, sparkyUser, inv.id, { amount: '1', scope: 'too late to change this' }).code, 409);
});

test('cleaning instant pricing still works, and only for requests that ask for it', async () => {
  const w = world();
  const { RATE } = await import('./_fixtures.js');
  const { draftRateCard, approveRateCard } = await import('../src/estimate.js');
  const bc = w.store.put('orgs', { slug: 'bc', name: 'Bright Cleaning', kind: undefined, trades: ['cleaning'], territories: ['IA'], status: 'active', legal: { name: 'Bright Cleaning Sev Inc.', postalAddress: '1 Main, Ankeny IA' }, senderEmail: 'b@bc.test',
    settings: { coverage: ['ankeny, ia'], minContract: 0, autoApprove: { enabled: true, maxTotal: 1e6, minScore: 0 }, requireCurrentCOI: false }, subscription: { plan: 'internal', status: 'active' } });
  approveRateCard(w.store, bc.id, draftRateCard(w.store, bc.id, RATE, 'o').rateCard.id, 'o', 'owner');
  createRequest(w.store, w.gc, w.gcUser, REQ); // electrical/roofing: no cleaning bid
  const clean = createRequest(w.store, w.gc, w.gcUser, { ...REQ, title: 'Final clean', trades: [], services: ['post_construction'], squareFeet: 30000 });
  assert.equal(clean.request.trades.includes('cleaning'), true);
  await runCycle(w.store, {});
  const subs = w.store.list('submissions', s => s.sellerOrgId === bc.id);
  assert.equal(subs.length, 1); assert.equal(subs[0].requestId, clean.request.id);
  assert.equal(w.store.list('invitations', i => i.sellerOrgId === bc.id)[0].intent, 'will_bid');
});

test('subscriber → GC outreach: needs legal identity, a verified contact tied to the project, and is logged; no duplicates', async () => {
  const store = new Store(null);
  ingestPermits(store, { id: 's', jurisdiction: 'ank', city: 'Ankeny', state: 'IA', url: 'u' }, [{ permitId: 'P1', address: '1 Main St', permitType: 'Commercial New', description: 'New office building', issuedDate: D(-5), status: 'Issued', valuation: '2000000', contractor: 'Weitz Company LLC' }]);
  const p = store.list('permits')[0];
  const co = store.put('companies', { name: 'Weitz', normName: normName('Weitz Company LLC') });
  const c = store.put('contacts', { companyId: co.id, name: 'Estimating', email: 'bids@weitz.test', status: 'source_confirmed', evidenceUrl: 'https://weitz.test' });
  const other = store.put('contacts', { companyId: store.put('companies', { name: 'Other', normName: 'other' }).id, name: 'X', email: 'x@other.test', status: 'verified', evidenceUrl: 'https://o.test' });
  const org = store.put('orgs', { slug: 's', name: 'Sparky', kind: 'subscriber', trades: ['electrical'], territories: ['IA'], status: 'active', legal: {}, settings: {}, subscription: { plan: 'local', status: 'active' } });
  const user = { email: 'est@sparky.test', id: 'u' };
  const msg = 'We are a licensed electrical contractor and would like to bid the electrical scope.';
  assert.match((await contactFromProject(store, org, user, p.id, { contactId: c.id, message: msg })).error, /legal name and postal address/);
  org.legal = { name: 'Sparky Electric LLC', postalAddress: '9 Elm St, Ankeny, IA' };
  assert.match((await contactFromProject(store, org, user, p.id, { contactId: other.id, message: msg })).error, /not tied to this project/);
  config.emailMode = 'dry-run'; config.platformFrom = 'alerts@buildintel.test';
  const r = await contactFromProject(store, org, user, p.id, { contactId: c.id, message: msg });
  assert.equal(r.queued, true);
  const m = store.list('messages', x => x.kind === 'outreach')[0];
  assert.match(m.preview, /Sparky Electric LLC\n9 Elm St/); assert.match(m.preview, /Unsubscribe: https/);
  assert.equal(store.tlist('tracked', org.id)[0].stage, 'contacted');
  assert.equal((await contactFromProject(store, org, user, p.id, { contactId: c.id, message: msg })).code, 409);
  store.suppressEverywhere('bids@weitz.test', 'x', 'y');
  config.platformFrom = '';
});

test('platform company gets cleaning trades once at startup (and keeps any trades it already set)', async () => {
  const { bootstrap } = await import('../src/server.js');
  const store = new Store(null);
  const bc = store.put('orgs', { slug: 'bc', name: 'Bright Cleaning', status: 'onboarding', subscription: { plan: 'internal', status: 'active' } });
  const custom = store.put('orgs', { slug: 'x', name: 'X', status: 'active', trades: ['painting'], subscription: { plan: 'internal', status: 'active' } });
  bootstrap(store);
  assert.deepEqual(store.get('orgs', bc.id).trades, ['cleaning', 'janitorial']);
  assert.deepEqual(store.get('orgs', custom.id).trades, ['painting']);
});
