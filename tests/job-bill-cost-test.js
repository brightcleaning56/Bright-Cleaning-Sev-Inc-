// Checks that an approved bill on a job is also a job cost: the job's cost includes it, the ledger posts it once,
// an edit or void takes it out of the job cost, and approving again puts it back.
// Run: node tests/job-bill-cost-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, category TEXT NOT NULL, description TEXT, amount REAL NOT NULL, cost_date TEXT, entered_by TEXT, created_at TEXT NOT NULL);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER);
  INSERT INTO projects(id,name) VALUES(1,'Bricktowne');
`);
L.seedChart(db);
const bal = c => L.trialBalance(db).accounts.find(a => a.code === c).balance;
const jobCosts = () => db.prepare('SELECT * FROM project_costs WHERE project_id=? ORDER BY id').all(1);
const jobTotal = () => jobCosts().reduce((t, c) => t + Number(c.amount), 0);

// 1. Entered: not in the job cost and not on the books.
const id = E.createBill(db, { vendor: 'Floor Supply', description: 'Stripper', category: 'materials', amount: 240, bill_date: '2026-11-20', project_id: 1 }, 'crew@test');
assert.strictEqual(jobCosts().length, 0, 'an unapproved bill is not a job cost yet');
assert.strictEqual(bal('2000'), 0, 'an unapproved bill is not on the books');

// 2. Approved: one job cost for the job, and the ledger posts it once.
E.approveBill(db, id, 'owner@test');
assert.strictEqual(jobCosts().length, 1, 'approval records one job cost');
assert.strictEqual(jobCosts()[0].amount, 240, 'the job cost is the bill amount');
assert.strictEqual(jobCosts()[0].source_bill_id, id, 'the job cost is linked to its bill');
assert.strictEqual(bal('2000'), 240, 'the payable is posted once');
// Syncing again does not add a second job cost or a second posting.
E.syncRecorded(db);
assert.strictEqual(jobCosts().length, 1, 'a sync does not duplicate the job cost');
assert.strictEqual(bal('2000'), 240, 'a sync does not post the bill again');
assert.strictEqual(L.trialBalance(db).balanced, true, 'the ledger balances');
console.log('ok - an approved job bill is a job cost once, posted once');

// 3. Edit: the job cost follows the new amount after approval again; a cost change takes it off until approved.
E.updateBill(db, id, { amount: 260 }, 'owner@test');
assert.strictEqual(jobCosts().length, 0, 'an edited bill comes out of the job cost until approved again');
E.approveBill(db, id, 'owner@test');
assert.strictEqual(jobTotal(), 260, 'approving the edit sets the job cost to the new amount');
assert.strictEqual(bal('2000'), 260, 'the ledger shows the new amount once');
console.log('ok - an edit moves the job cost with the bill, through approval');

// 4. Void: the job cost is removed and the ledger reverses.
E.voidBill(db, id, { reason: 'Entered twice', by: 'owner@test' });
assert.strictEqual(jobCosts().length, 0, 'a voided bill is not a job cost');
assert.strictEqual(bal('2000'), 0, 'a voided bill leaves the books');
console.log('ok - a voided bill comes out of the job cost and the ledger');

// 5. A bill with no job is not a job cost.
const office = E.createBill(db, { vendor: 'Phone Co', amount: 80, bill_date: '2026-11-21' }, 'owner@test');
E.approveBill(db, office, 'owner@test');
assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM project_costs WHERE source_bill_id=?').get(office).n, 0, 'an overhead bill is not a job cost');
console.log('ok - overhead bills are not job costs');

console.log('job bill cost: all checks passed');
