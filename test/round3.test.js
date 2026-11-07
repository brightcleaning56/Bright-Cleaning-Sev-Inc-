import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { runCycle } from '../src/autopilot.js';
import { createRequest, awardRequest, contractDocument } from '../src/marketplace.js';
import { addCredential, verifyCredential, credentialBlockers, proposalCredentialText, expiringSoon } from '../src/credentials.js';
import { buildDigest, sendDigests } from '../src/digest.js';
import { hashPassword } from '../src/security.js';
import { world, authorize, DALLAS_ROWS, stubFetch } from './_fixtures.js';

const future = (d = 10) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const socrata = stubFetch([['dallasopendata.com', () => ({ body: DALLAS_ROWS })]]);

test('credentials: expired insurance pauses all bidding; adding a current certificate resumes it', async () => {
  const w = world(); authorize(w.store, 'dallas-socrata');
  for (const c of w.store.tlist('credentials', w.org.id)) { c.expiresAt = '2020-01-01'; w.store.tput('credentials', w.org.id, c); }
  assert.match(credentialBlockers(w.store, w.org)[0], /certificate of insurance/);
  await runCycle(w.store, { fetchImpl: socrata });
  assert.equal(w.store.tlist('bids', w.org.id).length, 0);
  assert.equal(expiringSoon(w.store, w.org.id)[0].expired, true);
  const r = addCredential(w.store, w.org.id, { type: 'coi', issuer: 'EMC Insurance', number: 'GL-2027', coverages: [{ type: 'general_liability', limit: 2000000 }], expiresAt: '2027-11-01' }, 'eric');
  assert.equal(r.ok, true);
  await runCycle(w.store, { fetchImpl: socrata });
  assert.equal(w.store.tlist('bids', w.org.id).length, 1);
});

test('credentials: proposals say "on file" until independently verified; verification needs evidence', () => {
  const w = world();
  const bad = addCredential(w.store, w.org.id, { type: 'coi', issuer: 'X', number: '1', coverages: [], expiresAt: '2027-01-01' }, 'e');
  assert.equal(bad.ok, false);
  const lic = addCredential(w.store, w.org.id, { type: 'license', issuer: 'City of Dallas', number: 'CL-77', classification: 'Commercial cleaning', expiresAt: '2027-06-01' }, 'e').credential;
  assert.match(proposalCredentialText(w.store, w.org), /CL-77, City of Dallas — certificate on file/);
  assert.doesNotMatch(proposalCredentialText(w.store, w.org), /CL-77[^;]*verified/);
  assert.equal(verifyCredential(w.store, w.org.id, lic.id, 'eric', { method: 'state lookup' }).ok, false);
  verifyCredential(w.store, w.org.id, lic.id, 'eric', { method: 'city license lookup', evidence: 'https://dallas.example/lookup/CL-77' });
  assert.match(proposalCredentialText(w.store, w.org), /CL-77, City of Dallas — verified with issuer \d{4}-\d{2}-\d{2}/);
});

test('e-signature: award records signer, consent, IP and document hash; tampering is detected', async () => {
  const w = world();
  const buyer = w.store.put('orgs', { slug: 'gc', name: 'Ryan Companies', kind: 'buyer', buyerKind: 'general_contractor', status: 'active', legal: {}, settings: {} });
  const bu = w.store.put('users', { email: 'sam@ryan.test', role: 'owner', orgId: buyer.id, passwordHash: hashPassword('buyer password 1') });
  w.org.settings.autoApprove = { enabled: true, maxTotal: 100000, minScore: 90 };
  const req = createRequest(w.store, buyer, bu, { title: 'Final clean, clinic', address: '1200 SE Delaware Ave', city: 'Ankeny', state: 'IA', squareFeet: 15000, projectType: 'medical', services: ['post_construction'], dueDate: future() }).request;
  await runCycle(w.store, {});
  const [sub] = w.store.list('submissions');
  assert.match(sub.proposalHtml, /GL-1, Test Mutual|Test Mutual/); // insurance statement carried into the proposal
  assert.throws(() => awardRequest(w.store, buyer, bu, req.id, sub.id, { consent: true }), /signerName/);
  const out = awardRequest(w.store, buyer, bu, req.id, sub.id, { signerName: 'Sam Ortiz', consent: true, ip: '198.51.100.4', userAgent: 'Safari' });
  const c = w.store.get('contracts', out.contractId);
  assert.equal(c.acceptance.signerName, 'Sam Ortiz'); assert.equal(c.acceptance.ip, '198.51.100.4');
  assert.match(c.acceptance.consentText, /electronic records and signatures/);
  assert.match(contractDocument(c), /Document unchanged since signing/);
  assert.match(contractDocument({ ...c, proposalHtml: c.proposalHtml.replace('Total', 'TOTAL') }), /DOES NOT MATCH/);
  assert.equal(w.store.tget('bids', w.org.id, sub.bidId).status, 'awarded');
});

test('digest: approvals, gaps, expiring insurance; sent once per week; platform owner also sees gates', async () => {
  const w = world(); authorize(w.store, 'dallas-socrata');
  w.store.put('users', { email: 'eric@test', role: 'platform_owner', orgId: w.org.id, passwordHash: 'x' });
  addCredential(w.store, w.org.id, { type: 'license', issuer: 'State of Iowa', number: 'IA-9', classification: 'Contractor registration', expiresAt: future(10) }, 'e');
  const rows = DALLAS_ROWS.map(r => r.permit_number === 'BU-1003' ? { ...r, area: '18000', contractor: 'Turner Construction Co' } : r);
  await runCycle(w.store, { fetchImpl: stubFetch([['dallasopendata.com', () => ({ body: rows })]]) });
  const d = buildDigest(w.store, w.org, { includePlatform: true });
  assert.match(d.subject, /^BUILDINTEL: 1 to approve/);
  assert.match(d.text, /Turner Construction Co: 1 project/);
  assert.match(d.text, /IA-9 \(State of Iowa\) expires/);
  assert.match(d.text, /Launch gates: NO-GO/);
  config.emailMode = 'dry-run';
  assert.equal((await sendDigests(w.store, { force: true })).length, 1);
  assert.equal((await sendDigests(w.store)).length, 0); // already sent this week
});

test('store change tracking marks every write path, including cross-tenant suppression', () => {
  const s = new Store(null);
  s.put('contacts', { id: 'c1', email: 'a@b.test', status: 'verified' });
  s.tput('bids', 'o1', { id: 'b1' });
  s.dirty.clear();
  s.suppressEverywhere('a@b.test', 'x', 'y');
  assert.ok(s.dirty.has('suppression\u0000a@b.test')); assert.ok(s.dirty.has('contacts\u0000c1'));
  s.remove('contacts', 'c1'); assert.equal(s.dirty.get('contacts\u0000c1'), 'del');
  assert.ok(s.pendingAudit.length >= 1);
});
