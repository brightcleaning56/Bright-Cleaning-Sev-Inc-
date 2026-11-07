import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createRequest } from '../src/marketplace.js';
import { startFromAnalysis, startManual, updateEstimate, submitEstimateAsBid, computeEstimate } from '../src/takeoff.js';
import { draftRateCard, approveRateCard } from '../src/estimate.js';
import { RATE } from './_fixtures.js';

const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'GC', kind: 'buyer', status: 'active' });
  const sub = store.put('orgs', { slug: 'floor', name: 'Prairie Flooring', kind: 'subscriber', trades: ['flooring'], territories: ['IA'], status: 'active', legal: { name: 'Prairie Flooring LLC' }, settings: {}, subscription: { plan: 'local', status: 'active' } });
  const user = { email: 'est@prairie.test', id: 'u' };
  const { request } = createRequest(store, gc, { email: 'pm@gc.test' }, { title: 'Clinic', address: '1 A', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['flooring'], dueDate: D(9) });
  const inv = store.list('invitations', i => i.sellerOrgId === sub.id)[0];
  const analysis = store.tput('analyses', sub.id, { documentId: 'doc1', requestId: request.id, documentName: 'A2.1.pdf', status: 'unverified', model: 'm', result: { rooms: [
    { number: '101', name: 'LOBBY', areaSqFt: 2450, basis: 'printed', sheet: 'A2.1' },
    { number: '102', name: 'EXAM', areaSqFt: 1200, basis: 'printed', sheet: 'A2.1' },
    { number: '103', name: 'STORAGE', areaSqFt: null, basis: 'not_stated', sheet: 'A2.1' }], totals: {} } });
  return { store, gc, sub, user, request, inv, analysis };
}

test('takeoff only from a confirmed analysis; printed areas become lines with their sheet and room', () => {
  const w = world();
  assert.match(startFromAnalysis(w.store, w.sub, w.user, { analysisId: w.analysis.id, invitationId: w.inv.id }).error, /confirm the AI analysis/);
  w.analysis.status = 'verified'; w.analysis.verifiedBy = 'est@prairie.test'; w.store.tput('analyses', w.sub.id, w.analysis);
  const e = startFromAnalysis(w.store, w.sub, w.user, { analysisId: w.analysis.id, invitationId: w.inv.id }).estimate;
  assert.deepEqual(e.lines.map(l => [l.description, l.qty, l.source.sheet, l.source.room]), [['101 LOBBY', 2450, 'A2.1', '101'], ['102 EXAM', 1200, 'A2.1', '102']]); // storage (not printed) excluded
  const other = w.store.put('orgs', { slug: 'x', kind: 'subscriber' });
  assert.equal(startFromAnalysis(w.store, other, w.user, { analysisId: w.analysis.id }).code, 404); // another company's analysis
});

test('estimate math checked by hand; quantity edits are flagged as adjusted; validation', () => {
  const w = world(); w.analysis.status = 'verified'; w.store.tput('analyses', w.sub.id, w.analysis);
  const e = startFromAnalysis(w.store, w.sub, w.user, { analysisId: w.analysis.id, invitationId: w.inv.id }).estimate;
  const r = updateEstimate(w.store, w.sub, w.user, e.id, { overheadPct: 0.1, profitPct: 0.15, lines: [
    { ...e.lines[0], laborUnit: 2, materialUnit: 4, wastePct: 0.05 },          // 2450 × 1.05 × 6 = 15,435.00
    { ...e.lines[1], qty: 1250, laborUnit: 2, materialUnit: 4 } ] });           // 1250 × 6 = 7,500.00 (qty changed)
  assert.equal(r.ok, true);
  const t = r.estimate.totals;
  assert.equal(t.manualSubtotal, 22935); assert.equal(t.overhead, 2293.5); assert.equal(t.profit, 3784.28); assert.equal(t.total, 29012.78);
  assert.equal(r.estimate.lines[1].source.adjusted, true); assert.equal(r.estimate.lines[0].source.adjusted, false);
  assert.match(updateEstimate(w.store, w.sub, w.user, e.id, { lines: [{ description: 'x', qty: 0, unit: 'SF' }] }).error, /quantity/);
  assert.match(updateEstimate(w.store, w.sub, w.user, e.id, { profitPct: 15 }).error, /fraction/);
  assert.match(updateEstimate(w.store, w.sub, w.user, e.id, { lines: [{ description: 'x', qty: 5, unit: 'BOX' }] }).error, /unit must be/);
});

test('rate-card lines price from approved cleaning rates; unapproved cards cannot price', () => {
  const w = world();
  const rc = draftRateCard(w.store, w.sub.id, RATE, 'o').rateCard;
  const e = startManual(w.store, w.sub, w.user, { invitationId: w.inv.id }).estimate;
  updateEstimate(w.store, w.sub, w.user, e.id, { lines: [{ kind: 'ratecard', description: 'Final clean', qty: 42000, rateCardId: rc.id }] });
  assert.equal(computeEstimate(w.store, w.sub.id, w.store.tget('estimates', w.sub.id, e.id)).lines[0].error, 'rate card not approved');
  approveRateCard(w.store, w.sub.id, rc.id, 'o', 'owner');
  assert.equal(computeEstimate(w.store, w.sub.id, w.store.tget('estimates', w.sub.id, e.id)).totals.total, 3823.38); // same as the hand-checked rate card test
});

test('submit as bid: amount = estimate total, bid lists quantities with sources; locked after submission', () => {
  const w = world(); w.analysis.status = 'verified'; w.store.tput('analyses', w.sub.id, w.analysis);
  const e = startFromAnalysis(w.store, w.sub, w.user, { analysisId: w.analysis.id, invitationId: w.inv.id }).estimate;
  assert.match(submitEstimateAsBid(w.store, w.sub, w.user, e.id).error, /\$0/);
  updateEstimate(w.store, w.sub, w.user, e.id, { overheadPct: 0, profitPct: 0, lines: e.lines.map(l => ({ ...l, laborUnit: 3, materialUnit: 5 })) });
  const r = submitEstimateAsBid(w.store, w.sub, w.user, e.id, { exclusions: 'Excludes moisture mitigation' });
  assert.equal(r.ok, true); assert.equal(r.total, 29200); // (2450 + 1200) × 8
  const sub = w.store.list('submissions')[0];
  assert.equal(sub.total, 29200);
  assert.match(sub.proposalHtml, /101 LOBBY: 2,450 SF \[sheet A2\.1, room 101\]/);
  assert.match(sub.proposalHtml, /confirmed against the drawings/);
  assert.equal(updateEstimate(w.store, w.sub, w.user, e.id, { profitPct: 0.2 }).code, 409);
});
