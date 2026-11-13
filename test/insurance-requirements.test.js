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
