import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { normalizePermit, ingestPermits, validatePermit } from '../src/permits.js';
import { estimateLine, draftRateCard, approveRateCard, validateRateCard } from '../src/estimate.js';
import { transition, resolveRecipients, validateContact } from '../src/domain.js';
import { canCollect, sourceComplianceIssues } from '../src/sources/registry.js';
import { parseCsv } from '../src/sources/adapters.js';
import { world, RATE, authorize } from './_fixtures.js';

test('tenant isolation: tenant collections require orgId and block cross-org access', () => {
  const s = new Store(null);
  const a = s.tput('bids', 'orgA', { total: 1 });
  assert.throws(() => s.tlist('bids'), /orgId required/);
  assert.equal(s.tget('bids', 'orgB', a.id), null);
  assert.deepEqual(s.tlist('bids', 'orgB'), []);
  assert.throws(() => s.tput('bids', 'orgB', a), /cross-org/);
  assert.throws(() => s.put('bids', {}), /not a global/);
});

test('permits: normalize never invents values; residential skipped; dedupe updates', () => {
  const src = { id: 'src1', jurisdiction: 'dallas-tx', city: 'Dallas', state: 'TX', url: 'https://x' };
  const p = normalizePermit({ permitId: 'P1', address: '1 Main', permitType: 'Commercial New', description: 'new retail store', issuedDate: '2026-10-01' }, src);
  assert.equal(p.squareFeet, null); assert.equal(p.valuation, null);
  assert.equal(p.confidence, 'probable'); assert.equal(p.projectType, 'retail'); assert.equal(p.status, 'issued');
  assert.equal(validatePermit({ ...p, address: null }).ok, false);
  const s = new Store(null);
  const r1 = ingestPermits(s, src, [
    { permitId: 'P1', address: '1 Main', permitType: 'Commercial New', description: 'new retail store', issuedDate: '2026-10-01' },
    { permitId: 'P2', address: '2 Oak', permitType: 'Residential', description: 'single family fence' },
    { permitId: 'P3', permitType: 'Commercial', description: 'new office' },
  ]);
  assert.deepEqual([r1.inserted, r1.skippedNonCommercial, r1.rejected], [1, 1, 1]);
  const r2 = ingestPermits(s, src, [{ permitId: 'P1', address: '1 Main', permitType: 'Commercial New', description: 'new retail store', squareFeet: '9,000', issuedDate: '2026-10-01' }]);
  assert.equal(r2.updated, 1); assert.equal(s.list('permits').length, 1);
  assert.equal(s.list('permits')[0].squareFeet, 9000);
});

test('estimating: hand-checked numbers, minimum price, refusal without quantity or approval', () => {
  const { store, org, rc } = world();
  const card = store.tget('rateCards', org.id, rc.id);
  const l = estimateLine(card, 42000);
  assert.equal(l.laborHours, 42); assert.equal(l.labor, 907.2); assert.equal(l.cost, 2676.37); assert.equal(l.price, 3823.38);
  assert.equal(estimateLine(card, 1000).price, 750); // minimum applies
  assert.throws(() => estimateLine(card, 0), /no measured quantity/);
  assert.throws(() => estimateLine({ ...card, status: 'draft' }, 100), /not approved/);
  assert.ok(validateRateCard({ ...RATE, payrollBurdenPct: 20 }).length);
});

test('rate cards: members cannot approve; new approval retires prior version', () => {
  const { store, org, rc } = world();
  const v2 = draftRateCard(store, org.id, { ...RATE, laborRate: 20 }, 'm@test').rateCard;
  assert.equal(v2.version, 2);
  assert.equal(approveRateCard(store, org.id, v2.id, 'm@test', 'member').ok, false);
  assert.equal(approveRateCard(store, org.id, v2.id, 'o@test', 'owner').ok, true);
  assert.equal(store.tget('rateCards', org.id, rc.id).status, 'retired');
});

test('bid state machine rejects illegal transitions and records history', () => {
  const s = new Store(null);
  const bid = s.tput('bids', 'o1', { status: 'draft' });
  assert.throws(() => transition(s, bid, 'sent', 'x'), /illegal/);
  transition(s, bid, 'pending_approval', 'x'); transition(s, bid, 'approved', 'x');
  assert.throws(() => transition(s, bid, 'failed', 'x'), /illegal/); // must go through sending
  transition(s, bid, 'sending', 'x'); transition(s, bid, 'failed', 'x');
  assert.equal(bid.history.length, 4);
});

test('contacts: no invented recipients; unverified and suppressed are excluded; personal data refused', () => {
  const { store, contact } = world();
  const permit = { contractorOnPermit: 'The Weitz Company LLC' };
  assert.equal(resolveRecipients(store, permit).recipients[0].id, contact.id);
  assert.equal(resolveRecipients(store, { contractorOnPermit: 'Nobody LLC' }).recipients.length, 0);
  store.suppressEverywhere('pat@weitz.test', 'test', 'test');
  assert.equal(resolveRecipients(store, permit).recipients.length, 0);
  assert.equal(store.get('contacts', contact.id).status, 'opted_out');
  assert.ok(validateContact({ companyId: 'c', name: 'A', email: 'a@gmail.com', status: 'unverified' }).some(e => /personal email/.test(e)));
  assert.ok(validateContact({ companyId: 'c', name: 'A', status: 'verified' }).some(e => /evidenceUrl/.test(e)));
  assert.ok(validateContact({ companyId: 'c', name: 'A', status: 'unverified', homeAddress: 'x' }).some(e => /personal data/.test(e)));
});

test('sources: nothing collects until terms are reviewed; scraping refused', () => {
  const { store } = world();
  assert.equal(store.list('sources').some(canCollect), false);
  const s = authorize(store, 'dallas-socrata');
  assert.equal(canCollect(s), true);
  assert.ok(sourceComplianceIssues({ ...s, method: 'scrape' }).some(i => /scraping/.test(i)));
});

test('csv parser handles quotes, commas and CRLF', () => {
  const rows = parseCsv('permitId,address,description\r\n"C-1","1 Main St, Ste 2","Said ""new"" office"\r\n');
  assert.deepEqual(rows, [{ permitId: 'C-1', address: '1 Main St, Ste 2', description: 'Said "new" office' }]);
});
