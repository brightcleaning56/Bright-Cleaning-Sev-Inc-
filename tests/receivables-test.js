// Checks refunds and credit notes (audit G3): they post, cannot exceed what is paid or owed, and flow into the tie-out.
// Run: node tests/receivables-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const IL = require('../invoice-ledger');
const R = require('../receivables');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, amount REAL, tax_amount REAL DEFAULT 0, status TEXT, issue_date TEXT, created_at TEXT);
  CREATE TABLE payments(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount REAL, received_at TEXT);
`);
L.seedChart(db);
db.prepare("INSERT INTO invoices(id,invoice_number,amount,tax_amount,status,issue_date) VALUES(1,'INV-1',10000,800,'Sent','2026-11-20')").run();
db.prepare("INSERT INTO payments VALUES(1,1,6000,'2026-11-21T10:00:00Z')").run();
IL.syncAll(db);

let b = R.invoiceBalance(db, 1);
assert.strictEqual(b.billed, 10800);
assert.strictEqual(b.owed, 4800, 'billed 10,800 less paid 6,000');
console.log('ok - balance: billed 10,800, paid 6,000, owed 4,800');

// Refund: cannot exceed what was paid; posts receivable up and cash down.
assert.throws(() => R.recordRefund(db, { invoiceId: 1, amount: 7000, date: '2026-11-22', reason: 'too much' }), /more than the payments/);
const refundId = R.recordRefund(db, { invoiceId: 1, amount: 1000, date: '2026-11-22', reason: 'Scope not done', by: 'owner@test' });
b = R.invoiceBalance(db, 1);
assert.strictEqual(b.owed, 5800, 'refund puts 1,000 back as owed');
let tb = L.trialBalance(db);
assert.strictEqual(tb.accounts.find(a => a.code === '1000').balance, 5000, 'cash after payment and refund');
assert.strictEqual(tb.accounts.find(a => a.code === '1100').balance, 5800, 'receivable matches the owed amount');
assert.strictEqual(tb.balanced, true);
assert.ok(refundId > 0);
console.log('ok - refund posts (receivable up, cash down); refunds beyond payments are refused');

// Credit note: cannot exceed what is still owed; reduces discounts and receivable.
assert.throws(() => R.recordCredit(db, { invoiceId: 1, amount: 9000, date: '2026-11-23', reason: 'too much' }), /still owes/);
R.recordCredit(db, { invoiceId: 1, amount: 800, date: '2026-11-23', reason: 'Missed windows', by: 'owner@test' });
b = R.invoiceBalance(db, 1);
assert.strictEqual(b.owed, 5000, 'credit reduces the owed amount');
tb = L.trialBalance(db);
assert.strictEqual(tb.accounts.find(a => a.code === '4900').balance, -800, 'credit is contra revenue (shows as a debit balance)');
assert.strictEqual(tb.accounts.find(a => a.code === '1100').balance, 5000);
assert.strictEqual(tb.balanced, true);
console.log('ok - credit note reduces the balance and posts to discounts; over-credits are refused');

// The tie-out agrees with the ledger receivable after refunds and credits.
const t = IL.tieOut(db);
assert.strictEqual(t.invoices_owed, 5000);
assert.strictEqual(t.ledger_receivable, 5000);
assert.strictEqual(t.difference, 0);
assert.strictEqual(t.tied_out, true, 'tie-out holds with refunds and credits');
console.log('ok - tie-out agrees with the ledger after refunds and credits');

console.log('\nAll receivables checks passed.');
