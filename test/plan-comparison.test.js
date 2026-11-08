import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { planSummary, planComparison, PRICE_STATUS } from '../src/entitlements.js';

test('each subscriber plan is described in plain terms that match its real limits', () => {
  const local = planSummary('local');
  assert.equal(local.price, '$99/month');
  assert.equal(local.priceNote, PRICE_STATUS, 'prices are labelled as proposed until the owner confirms them');
  assert.ok(local.lines.includes('Projects in 1 state'));
  assert.ok(local.lines.includes('Up to 2 users'));
  assert.ok(local.lines.includes('10 saved searches with daily email alerts'));
  assert.ok(local.lines.includes('Export up to 500 rows a month'));
  const growth = planSummary('growth');
  assert.ok(growth.lines.includes('Projects in every state'));
});

test('the free trial and the custom enterprise plan are described honestly', () => {
  assert.equal(planSummary('trial').price, 'Free for 14 days, no card');
  assert.equal(planSummary('trial').priceNote, null, 'no price note on a free trial');
  assert.equal(planSummary('enterprise').price, 'Custom price, talk to us');
});

test('internal and free-tier plans never appear in the public comparison', () => {
  const keys = planComparison().map(p => p.key);
  assert.deepEqual(keys, ['trial', 'local', 'professional', 'growth', 'enterprise']);
  assert.equal(planSummary('internal'), null);
  assert.equal(planSummary('free'), null);
  assert.equal(planSummary('publisher_pro'), null, 'publisher plans are not sold on the subscriber sign-up');
});

test('over HTTP the comparison is public and needs no sign-in', async t => {
  const srv = createServer(new Store(null)).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/plan-comparison`);
  assert.equal(res.status, 200);
  const plans = await res.json();
  assert.equal(plans.length, 5);
  assert.ok(plans.every(p => p.name && p.price && Array.isArray(p.lines) && p.lines.length >= 5));
});
