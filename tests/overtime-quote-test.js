// Checks the overtime rule in quotes: hours past 40 in a week cost 1.5x. Run: node tests/overtime-quote-test.js
const assert = require('assert');
const { estimateMath } = require('../estimating');

const rate = 20;
const cases = [
  ['under 40 hours: no overtime', { labor_hours: 30, labor_rate: rate, visits: 1 }, { labor: 600, ot: 0 }],
  ['50 hours in a job, weekly defaults to job: 10 overtime hours at 1.5x', { labor_hours: 50, labor_rate: rate, visits: 1 }, { labor: 1100, ot: 10 }],
  ['same job split over two visits: 50 hours in the week', { labor_hours: 25, labor_rate: rate, visits: 2 }, { labor: 1100, ot: 10 }],
  ['crew only works 30 hours a week on this job: no overtime', { labor_hours: 50, labor_rate: rate, visits: 1, weekly_hours: 30 }, { labor: 1000, ot: 0 }],
  // Per person: 120 man-hours split across 3 people is 40 hours each, so no overtime (the whole-job count gave 80 hours).
  ['3 people, 120 man-hours in the job: 40 hours each, no overtime', { labor_hours: 24, visits: 5, crew_size: 3, labor_rate: rate }, { labor: 2400, ot: 0 }],
  // 150 man-hours by 3 people in one week: 50 hours each, so 10 overtime hours each = 30 man-hours at 1.5x.
  ['3 people, 150 man-hours in one week: 30 overtime man-hours', { labor_hours: 150, visits: 1, crew_size: 3, labor_rate: rate }, { labor: 3300, ot: 30 }],
  // Six weekly visits of 10 man-hours: each week is 10 hours, so no overtime.
  ['six weekly visits of 10 hours: no overtime', { labor_hours: 10, visits: 6, labor_rate: rate, weekly_hours: 10 }, { labor: 1200, ot: 0 }],
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
