// Checks pay totals: regular hours up to 40 in a Monday-to-Sunday week, overtime above it at 1.5 times, approved shifts only.
// Run: node tests/payroll-summary-test.js
const assert = require('assert');
const { totals, mondayOf } = require('../payrollsummary');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS  ' + name); };
const shift = (day, hours, extra = {}) => ({ employee_id: 1, name: 'Ana', payroll_id: '1042', rate: 24, day, minutes: hours * 60, approved: true, ...extra });

check('a Sunday belongs to the week that started the Monday before it', () => {
  assert.strictEqual(mondayOf('2026-11-15'), '2026-11-09');
  assert.strictEqual(mondayOf('2026-11-16'), '2026-11-16');
});
check('40 hours or fewer in a week is all regular', () => {
  const t = totals([shift('2026-11-09', 8), shift('2026-11-10', 8), shift('2026-11-11', 8), shift('2026-11-12', 8), shift('2026-11-13', 8)]);
  assert.strictEqual(t[0].reg, 40); assert.strictEqual(t[0].ot, 0);
  assert.strictEqual(t[0].gross, 960); // 40 x $24
});
check('hours above 40 in one week are overtime, paid at 1.5 times', () => {
  const t = totals([shift('2026-11-09', 10), shift('2026-11-10', 10), shift('2026-11-11', 10), shift('2026-11-12', 10), shift('2026-11-13', 10)]);
  assert.strictEqual(t[0].reg, 40); assert.strictEqual(t[0].ot, 10);
  assert.strictEqual(t[0].gross, 40 * 24 + 10 * 24 * 1.5); // 960 + 360
});
check('a Sunday and a Monday shift fall in different weeks, so no overtime is created', () => {
  const t = totals([shift('2026-11-15', 30), shift('2026-11-16', 30)]);
  assert.strictEqual(t[0].reg, 60); assert.strictEqual(t[0].ot, 0);
});
check('unapproved shifts are not paid, and they are counted', () => {
  const t = totals([shift('2026-11-09', 8), shift('2026-11-10', 8, { approved: false })]);
  assert.strictEqual(t[0].reg, 8);
  assert.strictEqual(t[0].unapproved, 1);
});
check('someone with only unapproved shifts still appears, with zero pay and the count', () => {
  const t = totals([shift('2026-11-09', 8, { employee_id: 2, name: 'Ben', approved: false })]);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].gross, 0);
  assert.strictEqual(t[0].unapproved, 1);
});
check('a missing file number is kept blank', () => {
  const t = totals([shift('2026-11-09', 8, { employee_id: 3, name: 'Cy', payroll_id: null })]);
  assert.strictEqual(t[0].payroll_id, '');
});

console.log(`\n${passed} passed`);
