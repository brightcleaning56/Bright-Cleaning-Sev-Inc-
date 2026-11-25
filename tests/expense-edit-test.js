// Checks bill correction and voiding: an open bill can be edited (the ledger shows the new figures once), a paid bill cannot
// be edited, voiding reverses the bill and its payment, nothing is deleted, and the ledger still balances.
// Run: node tests/expense-edit-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, description TEXT, amount REAL, cost_date TEXT, created_at TEXT);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER);
`);
L.seedChart(db);
const bal = c => L.trialBalance(db).accounts.find(a => a.code === c).balance;

// 1. Edit an open bill: the old entry is reversed and the new figures are posted once.
const id = E.createBill(db, { vendor: 'Glass Supply', description: 'Mops', category: 'supplies', amount: 150, bill_date: '2026-11-20' }, 'owner@test');
E.approveBill(db, id, 'owner@test');
assert.strictEqual(bal('6000'), 150, 'bill posted as operating expense');
E.updateBill(db, id, { amount: 175.5, description: 'Mops and buckets' }, 'owner@test');
assert.strictEqual(bal('6000'), 0, 'an edited bill comes off the books until it is approved again');
E.approveBill(db, id, 'owner@test');
assert.strictEqual(bal('6000'), 175.5, 'approving the edit posts the new amount once, no double count');
assert.strictEqual(bal('2000'), 175.5, 'payable follows the edit');
let b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(id);
assert.ok(b.approved_by, 'the bill is approved again after the edit');
// The note-only change does not touch the ledger.
E.updateBill(db, id, { description: 'Mops, buckets and wipes' }, 'owner@test');
assert.strictEqual(bal('6000'), 175.5, 'description-only change leaves the ledger alone');
b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(id);
assert.ok(b.approved_by, 'description-only change keeps the approval');

// 2. The sync never posts the bill twice, even after edits.
const synced = E.syncRecorded(db);
assert.strictEqual(synced.bills_posted, 0, 'sync posts nothing new after an edit');
assert.strictEqual(bal('6000'), 175.5, 'still one bill of 175.50');

// 3. A paid bill cannot be edited; voiding it reverses the payment and the bill.
E.payBill(db, id, { date: '2026-11-25', by: 'owner@test' });
assert.throws(() => E.updateBill(db, id, { amount: 10 }, 'owner@test'), /paid bill cannot be edited/);
assert.strictEqual(bal('1000'), -175.5, 'cash paid out');
assert.throws(() => E.voidBill(db, id, { reason: '' }), /reason/);
E.voidBill(db, id, { reason: 'Entered twice', by: 'owner@test' });
assert.strictEqual(bal('6000'), 0, 'void removes the expense');
assert.strictEqual(bal('2000'), 0, 'void leaves no payable');
assert.strictEqual(bal('1000'), 0, 'void returns the cash');
b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(id);
assert.strictEqual(b.status, 'Void');
assert.strictEqual(b.void_reason, 'Entered twice');
assert.strictEqual(b.void_by, 'owner@test');
assert.ok(b.void_at, 'void time recorded');
assert.strictEqual(b.amount, 175.5, 'the bill keeps its figures for the record');

// 4. A void bill cannot be edited, paid, approved or voided again.
assert.throws(() => E.updateBill(db, id, { amount: 5 }, 'owner@test'), /void bill cannot be edited/);
assert.throws(() => E.payBill(db, id, {}), /void bill cannot be paid/);
assert.throws(() => E.voidBill(db, id, { reason: 'again' }), /already void/);
assert.throws(() => E.approveBill(db, id, 'owner@test'), /void bill cannot be approved/);
E.syncRecorded(db);
assert.strictEqual(bal('6000'), 0, 'sync does not bring a void bill back');

// 5. The ledger balances, and each edit and void is on the accounting audit trail.
assert.strictEqual(L.trialBalance(db).balanced, true, 'ledger balances');
const trail = db.prepare('SELECT action, detail FROM accounting_audit_events ORDER BY id').all().map(x => x.action);
assert.ok(trail.includes('edited bill') && trail.includes('voided bill'), 'edit and void are audited: ' + trail.join(', '));

// 6. An open bill can be voided without a payment.
const id2 = E.createBill(db, { vendor: 'Vendor B', amount: 40, bill_date: '2026-11-21' }, 'owner@test');
E.voidBill(db, id2, { reason: 'Wrong vendor', by: 'owner@test' });
assert.strictEqual(bal('6000'), 0, 'open bill voided, expense back to zero');
assert.strictEqual(bal('2000'), 0, 'open bill voided, payable back to zero');

// 7. Validation on edit.
const id3 = E.createBill(db, { vendor: 'Vendor C', amount: 20, bill_date: '2026-11-21' }, 'owner@test');
assert.throws(() => E.updateBill(db, id3, { amount: 0 }, 'owner@test'), /amount above zero/);
assert.throws(() => E.updateBill(db, id3, { bill_date: '21/11/2026' }, 'owner@test'), /real date/);
assert.throws(() => E.updateBill(db, id3, { vendor: '  ' }, 'owner@test'), /vendor/);
assert.strictEqual(db.prepare('SELECT amount FROM expense_bills WHERE id=?').get(id3).amount, 20, 'failed edits change nothing');

// 8. Labor posts on the business date. A shift at 7:30 p.m. Central on Nov 21 is Nov 21, even though it is Nov 22 in UTC.
db.prepare("INSERT INTO employees VALUES(1,'Pat',20)").run();
db.prepare("INSERT INTO time_entries(id,employee_id,project_id,clock_in,minutes,approved_by,cost_id) VALUES(1,1,NULL,'2026-11-22T01:30:00.000Z',60,'owner@test',NULL)").run();
E.syncRecorded(db);
const payrollEntry = db.prepare("SELECT entry_date FROM ledger_entries WHERE source='payroll' AND reverses_id IS NULL").get();
assert.strictEqual(payrollEntry.entry_date, '2026-11-21', 'evening shift posts on the business day, not the UTC day');

console.log('expense edit and void: all checks passed');
