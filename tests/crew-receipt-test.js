// Checks crew receipts (Phase 2): a crew member sends a photo, vendor and amount for a job. It is an open bill,
// shows as pending on the job, and is a job cost and on the books only once the office approves it.
// Run: node tests/crew-receipt-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');
const JC = require('../job-cost');

const db = new Database(':memory:');
db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, category TEXT NOT NULL, description TEXT, amount REAL NOT NULL, cost_date TEXT, entered_by TEXT, created_at TEXT NOT NULL);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  INSERT INTO projects(id,name) VALUES(1,'Bricktowne');
`);
L.seedChart(db);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-receipt-'));
fs.writeFileSync(path.join(dir, 'a1b2.jpg'), 'photo');
const file = { filename: 'a1b2.jpg', originalname: 'Lumber receipt.jpg', size: 5 };
const sam = { name: 'Sam Crew' };
const pendingTotal = () => Number(JC.pendingFor(db, 1).total);
const jobCostRows = () => db.prepare('SELECT COUNT(*) AS n FROM project_costs').get().n;

// 1. A receipt is an open bill with its job, its photo, its vendor and the crew member who sent it.
const r = E.createCrewReceipt(db, { employee: sam, project_id: 1, vendor: 'Home Depot', amount: 84.5, description: 'Drywall screws', category: 'materials' }, file);
const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(r.id);
assert.strictEqual(b.status, 'Open', 'a crew receipt starts open');
assert.strictEqual(b.source, 'crew', 'the bill is marked as a crew receipt');
assert.strictEqual(b.created_by, 'crew: Sam Crew', 'the crew member is recorded');
assert.strictEqual(b.project_id, 1, 'the job is recorded');
assert.strictEqual(b.amount, 84.5, 'the amount is recorded');
assert.strictEqual(b.receipt_file, 'a1b2.jpg', 'the photo is linked');
assert.strictEqual(b.receipt_ref, 'Lumber receipt.jpg', 'the original file name is kept');
console.log('ok - a crew receipt is an open bill with its job, photo and crew member');

// 2. Until the office approves it: not a job cost, not on the books, but shown as pending on the job.
assert.strictEqual(jobCostRows(), 0, 'an unapproved crew receipt is not a job cost');
assert.strictEqual(L.trialBalance(db).accounts.find(a => a.code === '2000').balance, 0, 'an unapproved crew receipt is not on the books');
assert.strictEqual(pendingTotal(), 84.5, 'the receipt shows as pending on its job');
console.log('ok - an unapproved crew receipt is pending, not a job cost');

// 3. Approval by the office posts it once and clears the pending amount.
E.approveBill(db, r.id, 'owner@test');
assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM project_costs WHERE source_bill_id=?').get(r.id).n, 1, 'approval records one job cost');
assert.strictEqual(pendingTotal(), 0, 'approval moves it from pending to the job cost');
assert.strictEqual(L.trialBalance(db).balanced, true, 'the ledger balances');
console.log('ok - approval by the office posts the crew receipt once');

// 4. A receipt sent with no job is overhead, and nothing is pending on any job.
const noJob = E.createCrewReceipt(db, { employee: sam, project_id: null, vendor: 'Gas Station', amount: 40, category: 'travel' }, file);
assert.strictEqual(db.prepare('SELECT project_id FROM expense_bills WHERE id=?').get(noJob.id).project_id, null, 'no job is recorded as no job');
assert.strictEqual(pendingTotal(), 0, 'an overhead receipt is not pending on a job');
console.log('ok - a receipt with no job is overhead');

// 5. Bad input is refused before anything is saved.
const before = db.prepare('SELECT COUNT(*) AS n FROM expense_bills').get().n;
assert.throws(() => E.createCrewReceipt(db, { employee: sam, vendor: '', amount: 10 }, file), /vendor/, 'a receipt needs a vendor');
assert.throws(() => E.createCrewReceipt(db, { employee: sam, vendor: 'Shop', amount: 0 }, file), /above zero/, 'a receipt needs an amount');
assert.throws(() => E.createCrewReceipt(db, { employee: sam, vendor: 'Shop', amount: 10 }, null), /Attach a photo/, 'a receipt needs its photo');
assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM expense_bills').get().n, before, 'nothing is saved when input is refused');
console.log('ok - bad input is refused and saves nothing');

// 6. The office can open the photo, and the audit trail records who sent it.
const found = E.receiptPath(db, r.id, dir);
assert.ok(found && found.path === path.join(dir, 'a1b2.jpg'), 'the receipt photo is found for the office');
assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM accounting_audit_events WHERE action='sent receipt' AND actor='crew: Sam Crew'").get().n >= 1, true, 'the audit trail records the sender');
console.log('ok - the photo can be opened and the sender is on the audit trail');

fs.rmSync(dir, { recursive: true, force: true });
console.log('crew receipt: all checks passed');
