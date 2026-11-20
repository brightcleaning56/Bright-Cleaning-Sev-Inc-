// Checks bank statement import and matching (audit G14): safe re-import, automatic and manual matching, outstanding items.
// Run: node tests/bank-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const B = require('../bank');

const db = new Database(':memory:');
L.seedChart(db);
// Ledger cash: a customer payment in (25,000), a bill paid out (500), and a deposit in transit (1,000) not yet on the statement.
L.postEntry(db, { date: '2026-11-21', memo: 'Payment on INV-1', source: 'payment', sourceRef: 'payment:1', lines: [{ account: '1000', debit: 25000 }, { account: '1100', credit: 25000 }] });
L.postEntry(db, { date: '2026-11-24', memo: 'Paid bill 1', source: 'bill-payment', sourceRef: 'bill-payment:1', lines: [{ account: '2000', debit: 500 }, { account: '1000', credit: 500 }] });
L.postEntry(db, { date: '2026-11-26', memo: 'Deposit in transit', source: 'payment', sourceRef: 'payment:2', lines: [{ account: '1000', debit: 1000 }, { account: '1100', credit: 1000 }] });

const statement = [
  'Date,Description,Amount',
  '2026-11-21,"ACH from Jensen, Group",25000',
  '2026-11-24,Check to Insurance Co,-500',
  '2026-11-25,Monthly service fee,-15',
].join('\n');

// Import, then import the same statement again: nothing is added twice.
const first = B.importStatement(db, statement, 'owner@test');
assert.strictEqual(first.added, 3, 'three lines added (header skipped)');
const again = B.importStatement(db, statement, 'owner@test');
assert.strictEqual(again.added, 0, 're-import adds nothing');
assert.strictEqual(again.skipped, 3, 're-import skips the three lines');
assert.strictEqual(db.prepare("SELECT description FROM bank_statement_lines WHERE amount=25000").get().description, 'ACH from Jensen, Group', 'quoted comma kept in the description');
console.log('ok - statement imports once; re-import is safe; quoted commas are kept');

// Bad rows are reported, not guessed.
const bad = B.parseStatement('2026-02-30,Bad date,10\n2026-11-20,No amount,');
assert.strictEqual(bad.rows.length, 0);
assert.strictEqual(bad.problems.length, 2, 'bad date and missing amount are both reported');
assert.throws(() => B.importStatement(db, 'nothing useful here', 'owner@test'), /No statement lines/);
console.log('ok - bad rows are reported, not guessed');

// Automatic matching: the two lines that have a ledger entry match; the fee does not.
const auto = B.autoMatch(db);
assert.strictEqual(auto.matched, 2);
const s = B.summary(db);
assert.strictEqual(s.matched, 2);
assert.strictEqual(s.unmatched_statement.length, 1, 'the service fee has no ledger entry');
assert.strictEqual(s.unmatched_statement_total, -15);
assert.strictEqual(s.outstanding_ledger.length, 1, 'the deposit in transit is outstanding');
assert.strictEqual(s.outstanding_ledger_total, 1000);
assert.strictEqual(s.ledger_cash, 25000 - 500 + 1000, 'ledger cash 25,500');
console.log('ok - matched 2; fee unmatched (-15); deposit in transit outstanding (1,000)');

// A manual match must agree on the amount and must not reuse an entry.
const feeLine = s.unmatched_statement[0];
const deposit = B.cashEntries(db).find(c => c.amount === 1000);
assert.throws(() => B.manualMatch(db, feeLine.id, deposit.id, 'owner@test'), /amounts differ/);
const paid = B.cashEntries(db).find(c => c.amount === -500);
assert.throws(() => B.manualMatch(db, feeLine.id, paid.id, 'owner@test'), /amounts differ/);
console.log('ok - manual matches must agree on the amount');

console.log('\nAll bank checks passed.');
