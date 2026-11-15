// Checks the overtime rule in quotes: hours past 40 in a week cost 1.5x. Run: node tests/overtime-quote-test.js
const assert = require('assert');
const { estimateMath } = require('../estimating');

const rate = 20;
const cases = [
  ['under 40 hours: no overtime', { labor_hours: 30, labor_rate: rate, visits: 1 }, { labor: 600, ot: 0 }],
  ['50 hours in a job, weekly defaults to job: 10 overtime hours at 1.5x', { labor_hours: 50, labor_rate: rate, visits: 1 }, { labor: 1100, ot: 10 }],
  ['same job split over two visits: 50 hours in the week', { labor_hours: 25, labor_rate: rate, visits: 2 }, { labor: 1100, ot: 10 }],
  ['crew only works 30 hours a week on this job: no overtime', { labor_hours: 50, labor_rate: rate, visits: 1, weekly_hours: 30 }, { labor: 1000, ot: 0 }],
];
let passed = 0;
for (const [name, input, want] of cases) {
  const out = estimateMath(input);
  assert.strictEqual(out.labor_cost, want.labor, name + ': labor ' + out.labor_cost);
  assert.strictEqual(out.overtime_hours, want.ot, name + ': overtime hours ' + out.overtime_hours);
  console.log('ok - ' + name);
  passed++;
}
console.log(`\n${passed} checks passed`);
