// Checks the business-day window used by the time report: a clock-in is counted on the Central-time day it happens.
// Run: node tests/bizdate-window-test.js
const assert = require('assert');
const b = require('../bizdate');

// 2026-11-13 is Central standard time (UTC-6): the day runs 06:00Z to 06:00Z the next day.
const [start, end] = b.window('2026-11-13', '2026-11-13');
assert.strictEqual(start, '2026-11-13T06:00:00.000Z');
assert.strictEqual(end, '2026-11-14T06:00:00.000Z');

const inside = (iso) => iso >= start && iso < end;
// 7:00 pm Central on the 13th is 01:00Z on the 14th: still the 13th's shift.
assert.ok(inside('2026-11-14T01:00:00.000Z'), 'an evening clock-in stays on its own day');
// 1:00 am Central on the 14th is 07:00Z: the next day.
assert.ok(!inside('2026-11-14T07:00:00.000Z'), 'the next morning is a different day');
assert.ok(!inside('2026-11-13T05:59:59.999Z'), 'just before local midnight is the previous day');

console.log('PASS  a clock-in is counted on the Central-time day it happens');
console.log('\n1 passed');
