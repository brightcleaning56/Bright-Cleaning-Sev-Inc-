// Checks accounting periods (closed books refuse posting) and bank reconciliation.
// Run: node tests/periods-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const P = require('../periods');

const db = new Database(':memory:');
L.seedChart(db);
L.postEntry(db, { date: '2026-11-20', memo: 'Invoice 1', source: 'invoice', sourceRef: 'invoice:1', lines: [{ account: '1100', debit: 50000 }, { account: '4000', credit: 50000 }] });
L.postEntry(db, { date: '2026-11-21', memo: 'Payment', source: 'payment', sourceRef: 'payment:1', lines: [{ account: '1000', debit: 25000 }, { account: '1100', credit: 25000 }] });

// Close the books through 21 November.
const c1 = P.closePeriod(db, '2026-11-21', 'owner@test');
assert.strictEqual(c1.closed_through, '2026-11-21');
assert.throws(() => L.postEntry(db, { date: '2026-11-20', memo: 'late invoice', source: 'invoice', sourceRef: 'invoice:late', lines: [{ account: '1100', debit: 100 }, { account: '4000', credit: 100 }] }), /closed through 2026-11-21/);
assert.throws(() => L.postEntry(db, { date: '2026-11-21', memo: 'same day', source: 'x', sourceRef: 'x', lines: [{ account: '1100', debit: 100 }, { account: '4000', credit: 100 }] }), /closed through/);
L.postEntry(db, { date: '2026-11-22', memo: 'after the close', source: 'invoice', sourceRef: 'invoice:2', lines: [{ account: '1100', debit: 100 }, { account: '4000', credit: 100 }] });
console.log('ok - entries on or before the close are refused; later entries post');

// A close can only move forward.
assert.throws(() => P.closePeriod(db, '2026-11-10', 'owner@test'), /can only move forward/);
assert.throws(() => P.closePeriod(db, '2026-11-21', 'owner@test'), /can only move forward/);
assert.throws(() => P.closePeriod(db, 'not-a-date', 'owner@test'), /real date/);
P.closePeriod(db, '2026-11-30', 'owner@test');
assert.strictEqual(P.closedThrough(db), '2026-11-30');
assert.strictEqual(P.listPeriods(db).periods.length, 2);
console.log('ok - closes move forward only and are recorded');

// Bank reconciliation: matches at 25,000, shows the difference otherwise.
const ok = P.reconcileCash(db, { asOf: '2026-11-21', statementBalance: 25000, by: 'owner@test' });
assert.strictEqual(ok.ledger_balance, 25000);
assert.strictEqual(ok.difference, 0);
assert.strictEqual(ok.matched, true);
const off = P.reconcileCash(db, { asOf: '2026-11-21', statementBalance: 24800, note: 'bank fee not yet posted', by: 'owner@test' });
assert.strictEqual(off.difference, -200);
assert.strictEqual(off.matched, false);
assert.strictEqual(P.listReconciliations(db).reconciliations.length, 2);
assert.throws(() => P.reconcileCash(db, { asOf: '2026-11-21', statementBalance: 'abc' }), /number/);
console.log('ok - reconciliation matches at 25,000 and shows a -200 difference otherwise');

console.log('\nAll period and reconciliation checks passed.');
