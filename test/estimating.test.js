'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimate, selectRateCard } = require('../src/domain/estimating');

const BASE = {
  squareFeet: 10000,
  productionRate: 2000,
  laborRate: 40,
  burdenPct: 0.2,
  supervisionPct: 0.1,
  overheadPct: 0.1,
  marginPct: 0.25,
  materialsPerSqFt: 0.05,
  equipmentPerDay: 100,
  days: 2,
};

test('hand-calculated estimate matches exactly', () => {
  // labor 5h*40=200; burden 40; supervision (240)*0.1=24; materials 500; equipment 200
  // direct 964; overhead 96.40; cost 1060.40; price 1060.40/0.75 = 1413.87 (cents)
  const r = estimate(BASE);
  assert.equal(r.laborHours, 5);
  assert.equal(r.cost, 1060.4);
  assert.equal(r.total, 1413.87);
  assert.equal(r.minimumApplied, false);
  assert.equal(r.basis, 'estimated');
});

test('line items add up to the direct cost plus overhead', () => {
  const r = estimate(BASE);
  const sum = r.lineItems.reduce((n, li) => n + li.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, r.cost);
});

test('minimum bid is applied when the calculated price is lower', () => {
  const r = estimate({ ...BASE, minimumBid: 5000 });
  assert.equal(r.minimumApplied, true);
  assert.equal(r.total, 5000);
});

test('identical inputs always give identical output (deterministic)', () => {
  assert.deepEqual(estimate(BASE), estimate(BASE));
});

test('invalid inputs are rejected with every problem listed', () => {
  assert.throws(
    () => estimate({ ...BASE, squareFeet: 0, marginPct: 0.95, days: 1.5 }),
    (err) => err.name === 'ValidationError'
      && err.details.some((d) => /squareFeet/.test(d))
      && err.details.some((d) => /marginPct/.test(d))
      && err.details.some((d) => /days/.test(d)),
  );
});

test('a missing rate is refused rather than assumed', () => {
  assert.throws(
    () => estimate({ ...BASE, laborRate: undefined }),
    (err) => err.name === 'ValidationError' && err.details.some((d) => /laborRate/.test(d)),
  );
});

test('rate card selection respects project types and falls back to a general card', () => {
  const cards = [
    { service: 'office_clean', projectTypes: ['office'], productionRate: 1 },
    { service: 'general', projectTypes: [], productionRate: 2 },
  ];
  assert.equal(selectRateCard(cards, 'office').service, 'office_clean');
  assert.equal(selectRateCard(cards, 'warehouse').service, 'general');
  assert.equal(selectRateCard([{ service: 'office', projectTypes: ['office'] }], 'retail'), null);
  assert.equal(selectRateCard(undefined, 'office'), null);
});
