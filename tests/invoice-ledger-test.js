// Checks invoice and payment posting to the ledger: once only, voids reversed, and the receivables tie-out.
// Run: node tests/invoice-ledger-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const IL = require('../invoice-ledger');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, amount REAL, status TEXT, issue_date TEXT, created_at TEXT);
  CREATE TABLE payments(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount REAL, received_at TEXT);
`);
L.seedChart(db);
db.prepare("INSERT INTO invoices VALUES(1,'INV-1',50000,'Sent','2026-11-20',NULL)").run();
db.prepare("INSERT INTO invoices VALUES(2,'INV-2',7000,'Draft',NULL,'2026-11-20T00:00:00Z')").run();
db.prepare("INSERT INTO invoices VALUES(3,'INV-3',3000,'Void','2026-11-20',NULL)").run();
db.prepare("INSERT INTO payments VALUES(1,1,25000,'2026-11-21T10:00:00Z')").run();

// Before the sync: owed 25,000 is not on the ledger yet.
const before = IL.tieOut(db);
assert.strictEqual(before.invoices_owed, 25000, 'owed = 50,000 issued less 25,000 paid (draft and void excluded)');
assert.strictEqual(before.tied_out, false, 'not tied out before posting');
console.log('ok - before posting: owed', before.invoices_owed, 'ledger receivable', before.ledger_receivable, 'unposted invoices', before.unposted_invoices);

// The sync posts the issued invoice and the payment, and nothing for the draft or the void.
const first = IL.syncAll(db);
assert.strictEqual(first.invoices_posted, 1);
assert.strictEqual(first.payments_posted, 1);
const after = IL.tieOut(db);
assert.strictEqual(after.ledger_receivable, 25000);
assert.strictEqual(after.difference, 0);
assert.strictEqual(after.tied_out, true, 'tied out after posting');
const tb = L.trialBalance(db);
assert.strictEqual(tb.accounts.find(a => a.code === '4000').balance, 50000, 'revenue = invoice amount');
assert.strictEqual(tb.accounts.find(a => a.code === '1000').balance, 25000, 'cash = payment');
assert.strictEqual(tb.balanced, true);
console.log('ok - after posting: receivable', after.ledger_receivable, 'cash 25000, revenue 50000, tied out');

// Running it again posts nothing new (each invoice and payment posts once).
const again = IL.syncAll(db);
assert.deepStrictEqual([again.invoices_posted, again.payments_posted], [0, 0], 'second run posts nothing');
assert.strictEqual(IL.tieOut(db).ledger_receivable, 25000);
console.log('ok - running the sync again posts nothing new');

// Voiding a posted invoice reverses it; the receivable and revenue come back out.
db.prepare("UPDATE invoices SET status='Void' WHERE id=1").run();
const voided = IL.syncAll(db);
assert.strictEqual(voided.invoices_reversed, 1);
const vt = IL.tieOut(db);
assert.strictEqual(vt.invoices_owed, 0, 'voided invoice is no longer owed');
// The 25,000 payment stays on the books, so the receivable is -25,000 and the tie-out flags it.
assert.strictEqual(vt.ledger_receivable, -25000, 'payment left on a voided invoice shows as a credit balance');
assert.strictEqual(vt.tied_out, false, 'tie-out flags the mismatch');
assert.strictEqual(L.trialBalance(db).accounts.find(a => a.code === '4000').balance, 0, 'revenue reversed with the void');
console.log('ok - void reverses the posted invoice (revenue back to 0)');

// A payment against an invoice with no posted entry still posts once it exists; a zero or negative amount posts nothing.
db.prepare("INSERT INTO payments VALUES(2,1,0,'2026-11-22T00:00:00Z')").run();
assert.deepStrictEqual([IL.syncAll(db).payments_posted], [0], 'a zero payment posts nothing');
console.log('ok - zero payments post nothing');

console.log('\nAll invoice-ledger checks passed.');
