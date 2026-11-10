import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { proposeAmendment, acceptAmendment, declineAmendment, withdrawAmendment, amendmentView } from '../src/amendments.js';
import { contractDocument } from '../src/marketplace.js';
import crypto from 'node:crypto';
const PROPOSAL = '<html><body><p>Proposal</p></body></html>';

function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC Development Group', kind: 'buyer', status: 'active', settings: {} });
  const sub = store.put('orgs', { slug: 'sub', name: 'Summit Electric', kind: 'subscriber', status: 'active', settings: {} });
  const gm = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id, name: 'Dana Gray' });
  const owner = store.put('users', { email: 'owner@summit.test', role: 'owner', orgId: sub.id, name: 'Sam Lee' });
  const c = store.put('contracts', { requestId: 'r1', buyerOrgId: gc.id, sellerOrgId: sub.id, buyerName: gc.name, sellerName: sub.name,
    title: 'Medical office electrical', address: '1200 SE Delaware Ave, Ankeny, IA', total: 250000, proposalHtml: PROPOSAL,
    documentSha256: crypto.createHash('sha256').update(PROPOSAL).digest('hex'), acceptance: { signerName: 'Dana Gray', signerEmail: gm.email, at: new Date().toISOString(), consentText: 't', consentVersion: 'v', onBehalfOf: gc.name }, status: 'fully_signed', countersignature: { signerName: 'Sam Lee', signerEmail: owner.email, at: new Date().toISOString(), onBehalfOf: sub.name, consentText: 't', consentVersion: 'v' } });
  const ctx = { ip: '203.0.113.7', userAgent: 'test' };
  const sign = { signerName: 'Dana Gray', consent: true };
  return { store, gc, sub, gm, owner, c, ctx, sign };
}
const reason = 'Owner added two light fixtures to the lobby.';

test('a buyer proposal changes nothing until the provider accepts it with its own signature', () => {
  const w = world();
  const p = proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 262500, reason, ...w.sign }, w.ctx);
  assert.equal(p.ok, true);
  assert.equal(p.amendment.status, 'pending');
  assert.equal(w.store.get('contracts', w.c.id).total, 250000, 'the amount is unchanged while pending');
  const a = acceptAmendment(w.store, w.sub, w.owner, w.c.id, p.amendment.id, { signerName: 'Sam Lee', consent: true }, w.ctx);
  assert.equal(a.ok, true);
  const fresh = w.store.get('contracts', w.c.id);
  assert.equal(fresh.total, 262500, 'accepted: the amount due changes');
  assert.equal(fresh.amendments[0].status, 'accepted');
  assert.equal(fresh.amendments[0].acceptance.signerName, 'Sam Lee');
  assert.match(fresh.amendments[0].documentSha256, /^[0-9a-f]{64}$/);
  assert.equal(fresh.documentSha256, crypto.createHash('sha256').update(PROPOSAL).digest('hex'), 'the original proposal fingerprint is never rewritten');
});

test('the provider can decline, with a reason; the amount stays and the buyer may propose again', () => {
  const w = world();
  const p = proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 240000, reason, ...w.sign }, w.ctx);
  assert.equal(declineAmendment(w.store, w.sub, w.owner, w.c.id, p.amendment.id, { reason: 'Price is below our cost.' }).ok, true);
  const fresh = w.store.get('contracts', w.c.id);
  assert.equal(fresh.total, 250000);
  assert.equal(fresh.amendments[0].status, 'declined');
  assert.equal(proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 245000, reason, ...w.sign }, w.ctx).ok, true);
});

test('the buyer can withdraw a pending change; only one may be pending at a time', () => {
  const w = world();
  const p = proposeAmendment(w.store, w.gc, w.gm, w.c.id, { scope: 'Add two lobby fixtures', reason, ...w.sign }, w.ctx);
  assert.throws(() => proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 1000, reason, ...w.sign }, w.ctx), { code: 409 });
  assert.equal(withdrawAmendment(w.store, w.gc, w.gm, w.c.id, p.amendment.id).ok, true);
  assert.equal(w.store.get('contracts', w.c.id).amendments[0].status, 'withdrawn');
  assert.equal(proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 1000, reason, ...w.sign }, w.ctx).ok, true);
});

test('refusals: no change, bad price, short reason, missing signature, unsigned contract, other company', () => {
  const w = world();
  assert.throws(() => proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 250000, reason, ...w.sign }, w.ctx), { code: 400 }, 'same price is not a change');
  assert.throws(() => proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: -5, reason, ...w.sign }, w.ctx), { code: 400 });
  assert.throws(() => proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 260000, reason: 'short', ...w.sign }, w.ctx), { code: 400 });
  assert.throws(() => proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 260000, reason }, w.ctx), { code: 400 }, 'buyer must sign');
  assert.throws(() => proposeAmendment(w.store, w.sub, w.owner, w.c.id, { total: 260000, reason, ...w.sign }, w.ctx), { code: 404 }, 'provider cannot propose');
  w.store.put('contracts', { ...w.store.get('contracts', w.c.id), status: 'accepted' });
  assert.throws(() => proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 260000, reason, ...w.sign }, w.ctx), { code: 409 }, 'only a fully signed contract can be amended');
  assert.equal(w.store.get('contracts', w.c.id).amendments, undefined);
});

test('the signed record lists every amendment and keeps the original proposal', () => {
  const w = world();
  const p = proposeAmendment(w.store, w.gc, w.gm, w.c.id, { total: 262500, reason, ...w.sign }, w.ctx);
  acceptAmendment(w.store, w.sub, w.owner, w.c.id, p.amendment.id, { signerName: 'Sam Lee', consent: true }, w.ctx);
  const html = contractDocument(w.store.get('contracts', w.c.id));
  assert.match(html, /Amendments/);
  assert.match(html, /price \$250,000 to \$262,500/);
  assert.match(html, /Document unchanged since signing/);
  assert.equal(amendmentView(w.store.get('contracts', w.c.id).amendments[0]).acceptedBy, 'Sam Lee');
});
