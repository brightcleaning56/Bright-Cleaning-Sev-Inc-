// Checks Bright Clean's own ledger: balanced entries, reversals, immutability, trial balance.
// Run: node tests/ledger-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');

const db = new Database(':memory:');
L.seedChart(db);

// Worked example from the audit: $50,000 job, $19,000 direct costs, $25,000 collected.
const id1 = L.postEntry(db, { date: '2026-11-20', memo: 'Invoice 1 issued', source: 'invoice', sourceRef: 'INV-1',
  lines: [{ account: '1100', debit: 50000 }, { account: '4000', credit: 50000 }] });
const id2 = L.postEntry(db, { date: '2026-11-21', memo: 'Payment received', source: 'payment', sourceRef: 'PAY-1',
  lines: [{ account: '1000', debit: 25000 }, { account: '1100', credit: 25000 }] });
const id3 = L.postEntry(db, { date: '2026-11-22', memo: 'Job costs recorded', source: 'job-cost', sourceRef: 'JOB-1',
  lines: [{ account: '5000', debit: 12000 }, { account: '5100', debit: 2000 }, { account: '5200', debit: 1000 }, { account: '5300', debit: 3000 }, { account: '5400', debit: 1000 }, { account: '1000', credit: 19000 }] });
console.log('ok - three balanced entries posted');

const tb = L.trialBalance(db);
const bal = code => tb.accounts.find(a => a.code === code).balance;
assert.strictEqual(tb.balanced, true, 'trial balance balances');
assert.strictEqual(bal('4000'), 50000, 'revenue recognised on invoice');
assert.strictEqual(bal('1100'), 25000, 'receivable is the unpaid balance');
assert.strictEqual(bal('1000'), 6000, 'cash = 25,000 received - 19,000 paid out');
assert.strictEqual(bal('5000') + bal('5100') + bal('5200') + bal('5300') + bal('5400'), 19000, 'direct costs total 19,000');
const profit = bal('4000') - (bal('5000') + bal('5100') + bal('5200') + bal('5300') + bal('5400'));
assert.strictEqual(profit, 31000, 'gross profit 31,000 (62%)');
console.log('ok - worked example reconciles: gross profit', profit, 'receivable', bal('1100'), 'cash', bal('1000'));

// Unbalanced, one-sided, unknown account, bad date, and zero entries are refused and write nothing.
const before = db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n;
const bad = [
  [{ date: '2026-11-20', memo: 'x', source: 's', lines: [{ account: '1000', debit: 10 }, { account: '4000', credit: 9 }] }, /does not balance/],
  [{ date: '2026-11-20', memo: 'x', source: 's', lines: [{ account: '1000', debit: 10, credit: 10 }, { account: '4000', credit: 10 }] }, /exactly one side/],
  [{ date: '2026-11-20', memo: 'x', source: 's', lines: [{ account: '9999', debit: 10 }, { account: '4000', credit: 10 }] }, /unknown account/],
  [{ date: '2026-02-30', memo: 'x', source: 's', lines: [{ account: '1000', debit: 10 }, { account: '4000', credit: 10 }] }, /real date/],
  [{ date: '2026-11-20', memo: '', source: 's', lines: [{ account: '1000', debit: 10 }, { account: '4000', credit: 10 }] }, /memo/],
  [{ date: '2026-11-20', memo: 'x', source: 's', lines: [{ account: '1000', debit: 0 }, { account: '4000', credit: 0 }] }, /exactly one side|move money/],
];
for (const [args, re] of bad) assert.throws(() => L.postEntry(db, args), re, 'refused: ' + re);
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, before, 'refused entries wrote nothing');
console.log('ok - invalid entries are refused and write nothing');

// Posted entries cannot be edited or deleted.
assert.throws(() => db.prepare('UPDATE ledger_lines SET debit_cents = 1 WHERE entry_id = ?').run(id1), /cannot be changed/);
assert.throws(() => db.prepare('DELETE FROM ledger_lines WHERE entry_id = ?').run(id1), /cannot be deleted/);
assert.throws(() => db.prepare('UPDATE ledger_entries SET memo = ? WHERE id = ?').run('changed', id1), /cannot be changed/);
assert.throws(() => db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(id1), /cannot be deleted/);
console.log('ok - posted entries and lines cannot be edited or deleted');

// A mistake is fixed by a reversal, which nets the balances back out. A second reversal is refused.
const rev = L.reverseEntry(db, id2, { reason: 'Payment keyed to the wrong invoice', by: 'owner@test' });
const tb2 = L.trialBalance(db);
assert.strictEqual(tb2.balanced, true);
assert.strictEqual(tb2.accounts.find(a => a.code === '1100').balance, 50000, 'reversal puts the receivable back');
assert.strictEqual(tb2.accounts.find(a => a.code === '1000').balance, -19000, 'reversal removes the 25,000 receipt');
assert.throws(() => L.reverseEntry(db, id2, { reason: 'again' }), /already been reversed/);
assert.throws(() => L.reverseEntry(db, rev, { reason: 'undo the undo' }), /cannot itself be reversed/);
assert.throws(() => L.reverseEntry(db, id3, { reason: '' }), /Give a reason/);
console.log('ok - reversal nets out; double reversal and reversal-of-reversal refused');

// Trial balance as of a date only includes entries up to that date.
const asOf = L.trialBalance(db, { asOf: '2026-11-21' });
assert.strictEqual(asOf.accounts.find(a => a.code === '4000').balance, 50000);
assert.strictEqual(asOf.accounts.find(a => a.code === '5000').balance, 0, 'costs posted after the date are excluded');
assert.strictEqual(asOf.balanced, true);
console.log('ok - trial balance as of a date');

// Closed accounts cannot be posted to.
db.prepare("UPDATE ledger_accounts SET active=0 WHERE code='6000'").run();
assert.throws(() => L.postEntry(db, { date: '2026-11-23', memo: 'x', source: 's', lines: [{ account: '6000', debit: 5 }, { account: '1000', credit: 5 }] }), /closed/);
console.log('ok - closed accounts refuse postings');

console.log('\nAll ledger checks passed.');
