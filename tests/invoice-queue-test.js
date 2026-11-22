// Checks invoice follow-up on the work engine: an unpaid invoice can be assigned, given a follow-up date, or given a promise
// to pay; each needs its details before anything is written; a paid or void invoice needs no work and its item is closed.
// Run: node tests/invoice-queue-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT, customer_name TEXT, company TEXT, amount REAL DEFAULT 0, tax_amount REAL DEFAULT 0, status TEXT, due_date TEXT, issue_date TEXT, created_at TEXT);
  CREATE TABLE payments(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, amount REAL);`);
db.prepare(`INSERT INTO invoices(id,invoice_number,customer_name,amount,tax_amount,status,due_date,created_at) VALUES
  (1,'INV-1001','Pat Hallway',100,0,'Sent','2026-11-01','2026-10-30T10:00:00Z'),
  (2,'INV-1002','Lee Office',250,0,'Sent','2026-12-01','2026-11-01T10:00:00Z'),
  (3,'INV-1003','Sam Quote',80,0,'Draft','2026-12-01','2026-11-01T10:00:00Z'),
  (4,'INV-1004','Kim Gym',60,0,'Void','2026-11-10','2026-11-01T10:00:00Z')`).run();

// Rules first: details are checked before anything is written
assert.throws(() => W.applyInvoiceAction(db, 1, { action: 'schedule', date: '2026-02-31' }, 'owner@bc.test'), /follow-up date/);
assert.strictEqual(W.invoiceState(db, 1), null, 'a refused follow-up leaves no item');
assert.throws(() => W.applyInvoiceAction(db, 1, { action: 'wait', waiting_on: '', date: '2026-11-25' }, 'owner@bc.test'), /who promised/);
assert.throws(() => W.applyInvoiceAction(db, 1, { action: 'wait', waiting_on: 'Pat', date: 'soon' }, 'owner@bc.test'), /promised for/);
assert.throws(() => W.applyInvoiceAction(db, 1, { action: 'record_payment', amount: 100 }, 'owner@bc.test'), /Unknown invoice action/, 'the queue cannot take money');
assert.throws(() => W.applyInvoiceAction(db, 3, { action: 'assign', assigned_to: 'x@bc.test' }, 'owner@bc.test'), /nothing left to collect/, 'a draft is not followed up');
assert.throws(() => W.applyInvoiceAction(db, 4, { action: 'assign', assigned_to: 'x@bc.test' }, 'owner@bc.test'), /nothing left to collect/, 'a void invoice is not followed up');
assert.throws(() => W.applyInvoiceAction(db, 99, { action: 'assign', assigned_to: 'x@bc.test' }, 'owner@bc.test'), /not found/);

// Assign, follow-up date, promise to pay
W.applyInvoiceAction(db, 1, { action: 'assign', assigned_to: 'Ana@bc.test' }, 'owner@bc.test');
assert.strictEqual(W.invoiceState(db, 1).assigned_to, 'ana@bc.test', 'the owner is kept in lower case');
W.applyInvoiceAction(db, 1, { action: 'schedule', date: '2026-11-25' }, 'owner@bc.test');
assert.strictEqual(W.invoiceState(db, 1).due, '2026-11-25');
W.applyInvoiceAction(db, 2, { action: 'wait', waiting_on: 'Office manager, Tuesday check', date: '2026-11-28' }, 'owner@bc.test');
assert.strictEqual(W.invoiceState(db, 2).item_status, 'waiting');
assert.strictEqual(W.invoiceState(db, 2).due, '2026-11-28');

// The invoice's money is unchanged by the queue
assert.strictEqual(db.prepare('SELECT amount, status FROM invoices WHERE id=2').get().status, 'Sent');
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0, 'no payment is written from the queue');

// Paid in full: the balance is zero, the work is closed with the history kept
db.prepare('INSERT INTO payments(invoice_id,amount) VALUES(1,100)').run();
const closed = W.closeInvoiceWork(db, 1, 'Paid in full', 'system');
assert.strictEqual(closed.status, 'completed');
assert.strictEqual(W.invoiceState(db, 1), null, 'a paid invoice leaves the open follow-up');
assert.ok(closed.history.some(h => h.action === 'completed' && h.detail === 'Paid in full'), 'why it was closed is in the history');
assert.throws(() => W.applyInvoiceAction(db, 1, { action: 'assign', assigned_to: 'x@bc.test' }, 'owner@bc.test'), /nothing left to collect/);

console.log('All invoice queue checks passed.');
