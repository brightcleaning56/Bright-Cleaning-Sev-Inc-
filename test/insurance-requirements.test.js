import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { insuranceCheck } from '../src/prequal.js';
import { normalizeInsurance } from '../src/marketplace.js';

const cov = (over = {}) => ({ onFile: true, current: true, limit: 2000000, ...over });
test('a package with no requirement asks for nothing', () => {
  assert.equal(normalizeInsurance({}), null);
  assert.deepEqual(insuranceCheck({ generalLiability: { onFile: false }, workersComp: { onFile: false } }, null), { required: false, met: true, shortfalls: [] });
});
test('general liability and workers comp minimums are checked, and each shortfall is said plainly', () => {
  const req = normalizeInsurance({ generalLiabilityMin: '1000000', workersComp: true });
  assert.deepEqual(req, { generalLiabilityMin: 1000000, workersComp: true });
  assert.deepEqual(insuranceCheck({ generalLiability: cov(), workersComp: cov() }, req), { required: true, met: true, shortfalls: [] });
  const low = insuranceCheck({ generalLiability: cov({ limit: 500000 }), workersComp: { onFile: false } }, req);
  assert.equal(low.met, false);
  assert.match(low.shortfalls[0], /below the \$1,000,000 required/);
  assert.match(low.shortfalls[1], /no workers comp certificate on file/);
  assert.equal(insuranceCheck({ generalLiability: cov({ current: false }), workersComp: cov() }, req).shortfalls[0], 'general liability certificate expired');
});

test('a package stores its insurance minimum so invited companies can see it before they bid', async () => {
  const { createRequest } = await import('../src/marketplace.js');
  const { Store } = await import('../src/store.js');
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'ABC', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const user = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: gc.id });
  const base = { title: 'Electrical', address: '1 Main', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['electrical'], dueDate: '2030-01-01', description: 'Electrical rough-in and trim for the building per drawings.' };
  const r = createRequest(store, gc, user, { ...base, insuranceRequirements: { generalLiabilityMin: '2000000', workersComp: true } });
  assert.deepEqual(r.request.insuranceRequirements, { generalLiabilityMin: 2000000, workersComp: true });
  const none = createRequest(store, gc, user, { ...base, insuranceRequirements: {} });
  assert.equal(none.request.insuranceRequirements, null);
});
