// Checks revenue timing (decision: work done = revenue on issue; paid ahead = deposit until earned).
// Run: node tests/advance-billing-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const IL = require('../invoice-ledger');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, amount REAL, tax_amount REAL DEFAULT 0, status TEXT, issue_date TEXT, due_date TEXT, created_at TEXT, paid_amount REAL DEFAULT 0);
  CREATE TABLE payments(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount REAL, received_at TEXT);
`);
L.seedChart(db);
db.exec("ALTER TABLE invoices ADD COLUMN billing_kind TEXT DEFAULT 'arrears'");
db.prepare("INSERT INTO invoices(id,invoice_number,amount,status,issue_date) VALUES(1,'INV-1',2000,'Sent','2026-11-20')").run();      // work done: revenue on issue
db.prepare("INSERT INTO invoices(id,invoice_number,amount,status,issue_date,billing_kind) VALUES(2,'ADV-1',1000,'Sent','2026-11-20','advance')").run(); // paid ahead
IL.runSync(db, 'owner@test');

let tb = L.trialBalance(db);
const bal = c => tb.accounts.find(a => a.code === c).balance;
assert.strictEqual(bal('4000'), 2000, 'arrears invoice is revenue on issue');
assert.strictEqual(bal('2200'), 1000, 'advance invoice is a customer deposit');
assert.strictEqual(bal('1100'), 3000, 'both are receivable until paid');
assert.strictEqual(tb.balanced, true);
console.log('ok - work done goes to revenue on issue; paid-ahead goes to a customer deposit');

// Earning moves money from the deposit to revenue as the work is done, never more than the deposit.
assert.strictEqual(IL.depositOf(db, 2).remaining, 1000);
IL.earnDeposit(db, { invoiceId: 2, amount: 600, date: '2026-11-25', note: 'Week 1 done', by: 'owner@test' });
assert.strictEqual(IL.depositOf(db, 2).remaining, 400);
tb = L.trialBalance(db);
assert.strictEqual(bal('2200'), 400, 'deposit left after earning 600');
assert.strictEqual(bal('4000'), 2600, 'revenue up by the earned 600');
assert.throws(() => IL.earnDeposit(db, { invoiceId: 2, amount: 500, date: '2026-11-26', by: 'owner@test' }), /Only 400.00 of the deposit/);
assert.throws(() => IL.earnDeposit(db, { invoiceId: 1, amount: 100, date: '2026-11-26', by: 'owner@test' }), /Only an advance invoice/);
assert.strictEqual(L.trialBalance(db).balanced, true);
console.log('ok - earning moves the deposit to revenue; over-earning and earning on arrears invoices are refused');

// The tie-out still agrees: earning does not change what the customer owes.
assert.strictEqual(IL.tieOut(db).tied_out, true);
console.log('ok - the receivables tie-out is unchanged by earning');

console.log('\nAll advance-billing checks passed.');
