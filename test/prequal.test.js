import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Store } from '../src/store.js';
import { createRequest, submitBid } from '../src/marketplace.js';
import { addCredential, verifyCredential } from '../src/credentials.js';
import { prequalProfile, setPrequal, leveling } from '../src/prequal.js';
import { acknowledgeAddenda, saveDocument } from '../src/documents.js';
import { config } from '../src/config.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-pq-'));

const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'Acme GC', kind: 'buyer', status: 'active' });
  const gc2 = store.put('orgs', { slug: 'gc2', name: 'Other GC', kind: 'buyer', status: 'active' });
  const mk = slug => store.put('orgs', { slug, name: slug, kind: 'subscriber', trades: ['electrical'], territories: ['IA'], status: 'active', legal: { name: slug + ' LLC' }, settings: {}, subscription: { plan: 'local', status: 'active' } });
  const a = mk('alpha'), b = mk('bravo'), c = mk('charlie');
  const { request } = createRequest(store, gc, { email: 'pm@acme.test' }, { title: 'Clinic electrical', address: '1 A', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['electrical'], dueDate: D(10) });
  const inv = o => store.list('invitations', i => i.sellerOrgId === o.id)[0];
  return { store, gc, gc2, a, b, c, request, inv };
}
const bid = (amount) => ({ amount, scope: 'Complete electrical scope per drawings and specifications.' });

test('prequalification profile: only what was filed; "verified" only when checked with the issuer; gaps flagged', () => {
  const w = world();
  assert.deepEqual(prequalProfile(w.store, w.a).flags, ['no general liability certificate on file', 'no workers comp certificate on file', 'no current license on file']);
  const gl = addCredential(w.store, w.a.id, { type: 'coi', issuer: 'Acuity', number: 'GL-1', expiresAt: D(200), coverages: [{ type: 'general_liability', limit: 2000000 }, { type: 'workers_comp', limit: 1000000 }] }, 'x').credential;
  addCredential(w.store, w.a.id, { type: 'license', issuer: 'Iowa DIAL', number: 'EL-55', classification: 'Electrical contractor', expiresAt: D(300) }, 'x');
  let p = prequalProfile(w.store, w.a);
  assert.equal(p.insurance.generalLiability.limit, 2000000); assert.equal(p.insurance.generalLiability.verified, false); assert.deepEqual(p.flags, []);
  verifyCredential(w.store, w.a.id, gl.id, 'eric', { method: 'called agent', evidence: 'spoke with agent, policy active' });
  assert.equal(prequalProfile(w.store, w.a).insurance.generalLiability.verified, true);
  addCredential(w.store, w.b.id, { type: 'coi', issuer: 'X', number: 'old', expiresAt: D(-5), coverages: [{ type: 'general_liability', limit: 1000000 }] }, 'x');
  assert.ok(prequalProfile(w.store, w.b).flags.includes('general liability certificate expired'));
});

test('bid leveling: latest revision per bidder, spread vs low, median, addenda acknowledged; receipts fingerprint the exact bid', () => {
  const w = world();
  submitBid(w.store, w.a, { email: 'a' }, w.inv(w.a).id, bid('120000'));
  const revised = submitBid(w.store, w.a, { email: 'a' }, w.inv(w.a).id, bid('110000')).submission; // revision replaces
  submitBid(w.store, w.b, { email: 'b' }, w.inv(w.b).id, bid('99,000'));
  submitBid(w.store, w.c, { email: 'c' }, w.inv(w.c).id, bid('130000'));
  const L = leveling(w.store, w.gc, w.request.id);
  assert.deepEqual(L.rows.map(r => [r.company, r.total, r.pctAboveLow]), [['bravo LLC', 99000, 0], ['alpha LLC', 110000, 11.1], ['charlie LLC', 130000, 31.3]]);
  assert.deepEqual([L.stats.low, L.stats.median, L.stats.high], [99000, 110000, 130000]);
  assert.equal(L.rows[1].revision, 2);
  const sub = w.store.get('submissions', revised.id);
  assert.match(revised.receiptId, /^R-[0-9A-F]{10}$/);
  assert.equal(revised.sha256, crypto.createHash('sha256').update(sub.proposalHtml).digest('hex'));
  assert.equal(leveling(w.store, w.gc2, w.request.id), null); // another GC can't see these bids
});

test('addenda show in leveling; prequal decisions are private to the GC and limited to its own bidders', () => {
  const w = world();
  saveDocument(w.store, w.gc, { email: 'pm' }, w.request.id, { name: 'E1.pdf', buffer: Buffer.from('%PDF-1.4 a'), addendum: true, note: 'rev' });
  acknowledgeAddenda(w.store, w.a, { email: 'a' }, w.inv(w.a).id);
  submitBid(w.store, w.a, { email: 'a' }, w.inv(w.a).id, bid('100000'));
  assert.equal(leveling(w.store, w.gc, w.request.id).rows[0].addendaAcknowledged, 1);
  assert.equal(setPrequal(w.store, w.gc, { email: 'pm' }, w.a.id, { status: 'approved', note: 'COI checked' }).ok, true);
  assert.equal(leveling(w.store, w.gc, w.request.id).rows[0].decision.status, 'approved');
  assert.equal(setPrequal(w.store, w.gc2, { email: 'x' }, w.a.id, { status: 'rejected' }).code, 404); // not their bidder
  assert.equal(setPrequal(w.store, w.gc, { email: 'pm' }, w.a.id, { status: 'maybe' }).code, 400);
  assert.equal(w.store.tlist('prequal', w.gc2.id).length, 0);
});
