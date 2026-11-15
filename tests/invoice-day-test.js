// Checks which business day an invoice counts toward in reports and the QuickBooks export.
// Run: node tests/invoice-day-test.js
const assert = require('assert');
const { invoiceDay } = require('../bizdate');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS  ' + name); };

check('an issue date set by hand wins', () => {
  assert.strictEqual(invoiceDay({ issue_date: '2026-10-05', sent_at: '2026-11-02T15:00:00.000Z', created_at: '2026-09-30T10:00:00.000Z' }), '2026-10-05');
});
check('without an issue date, the day it was sent counts', () => {
  assert.strictEqual(invoiceDay({ sent_at: '2026-11-02T15:00:00.000Z', created_at: '2026-09-30T10:00:00.000Z' }), '2026-11-02');
});
check('a send just after midnight UTC counts on the Central day it happened (Oct 31, 9 pm Central)', () => {
  // 03:00 UTC on Nov 1 is 9:00 pm Central on Oct 31 (daylight time still in effect).
  assert.strictEqual(invoiceDay({ sent_at: '2026-11-01T03:00:00.000Z', created_at: '2026-10-01T10:00:00.000Z' }), '2026-10-31');
});
check('a draft that was never sent counts on the day it was created', () => {
  assert.strictEqual(invoiceDay({ created_at: '2026-10-20T16:00:00.000Z' }), '2026-10-20');
});

console.log(`\n${passed} passed`);
