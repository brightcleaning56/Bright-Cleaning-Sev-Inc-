// Checks the accounting rates screen's backend: defaults, range checks, that a change is read by the code that uses it,
// and that every change is in the audit trail. Run: node tests/rates-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const R = require('../accounting-rates');
const LB = require('../labor');
const EX = require('../expenses');

const db = new Database(':memory:');
db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
`);
require("../audit").ensureSchema(db);

// Defaults before anything is set: burden off, tax 6%, overtime after 40 hours.
const before = Object.fromEntries(R.listRates(db).map(r => [r.key, r.value]));
assert.deepStrictEqual(before, { ledger_burden_pct: 0, sales_tax_rate_pct: 6, overtime_after_hours: 40 });
console.log('ok - defaults: burden 0%, sales tax 6%, overtime after 40 hours');

// Values outside the range, or not numbers, are refused and nothing changes.
for (const bad of ['abc', '', null, -1, 101]) {
  assert.throws(() => R.setRate(db, 'ledger_burden_pct', bad, 'owner@test'), /must be between|must be between/, 'refused: ' + bad);
}
assert.throws(() => R.setRate(db, 'overtime_after_hours', 0, 'owner@test'), /must be between/);
assert.throws(() => R.setRate(db, 'not_a_rate', 5, 'owner@test'), /Unknown rate/);
assert.strictEqual(R.currentValue(db, 'ledger_burden_pct'), 0, 'refused changes leave the value alone');
console.log('ok - out-of-range, blank and unknown values are refused');

// A burden rate set here is the rate the expense code reads.
const r = R.setRate(db, 'ledger_burden_pct', '18.5', 'owner@test');
assert.strictEqual(r.value, 18.5); assert.strictEqual(r.previous, 0);
assert.strictEqual(EX.burdenPct(db), 18.5, "expenses reads the new burden rate");
console.log('ok - a burden rate of 18.5% is saved and read back');

// The overtime threshold changes the split for time approved from now on (labor.js reads the same setting).
R.setRate(db, 'overtime_after_hours', 45, 'owner@test');
assert.strictEqual(LB.thresholdHours(db), 45, 'labor reads the new threshold');
console.log('ok - the overtime threshold is read by labor cost');

// Each change is in the audit trail with the old and new value.
const trail = db.prepare('SELECT action, detail FROM accounting_audit_events').all();
assert.strictEqual(trail.length, 2, 'one audit entry per change');
assert.ok(trail.every(t => t.action === 'changed rate'));
assert.ok(/Labor burden %: 0 to 18.5/.test(trail[0].detail), trail[0].detail);
console.log('ok - each change is in the audit trail with the old and new value');

console.log('\nAll rates checks passed.');
