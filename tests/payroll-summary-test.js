// Checks payroll totals: regular hours up to 40 in a Monday-to-Sunday week, overtime above it.
// Run: node tests/payroll-summary-test.js
const assert = require('assert');
const { totals, mondayOf } = require('../payrollsummary');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS  ' + name); };
const shift = (day, hours, extra = {}) => ({ employee_id: 1, name: 'Ana', payroll_id: '1042', rate: 24, day, minutes: hours * 60, ...extra });

check('a Sunday belongs to the week that started the Monday before it', () => {
  assert.strictEqual(mondayOf('2026-11-15'), '2026-11-09'); // Sunday -> Monday Nov 9
  assert.strictEqual(mondayOf('2026-11-16'), '2026-11-16'); // Monday -> itself
});
check('40 hours or fewer in a week is all regular', () => {
  const t = totals([shift('2026-11-09', 8), shift('2026-11-10', 8), shift('2026-11-11', 8), shift('2026-11-12', 8), shift('2026-11-13', 8)]);
  assert.strictEqual(t[0].reg, 40); assert.strictEqual(t[0].ot, 0);
});
check('hours above 40 in one week are overtime', () => {
  const t = totals([shift('2026-11-09', 10), shift('2026-11-10', 10), shift('2026-11-11', 10), shift('2026-11-12', 10), shift('2026-11-13', 10)]);
  assert.strictEqual(t[0].reg, 40); assert.strictEqual(t[0].ot, 10);
});
check('a shift on Sunday and one on Monday fall in different weeks, so no overtime is created', () => {
  const t = totals([shift('2026-11-15', 30), shift('2026-11-16', 30)]);
  assert.strictEqual(t[0].reg, 60); assert.strictEqual(t[0].ot, 0);
});
check('each employee gets one row, and a missing file number is kept blank', () => {
  const t = totals([shift('2026-11-09', 8, { employee_id: 2, name: 'Ben', payroll_id: null }), shift('2026-11-09', 4)]);
  assert.strictEqual(t.length, 2);
  assert.strictEqual(t.find(x => x.name === 'Ben').payroll_id, '');
});

console.log(`\n${passed} passed`);
