// Checks expenses and payroll posting: bills, payments, recorded job costs, unassigned payroll, once-only posting and drift.
// Run: node tests/expenses-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, description TEXT, amount REAL, cost_date TEXT, created_at TEXT);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER);
`);
L.seedChart(db);
db.prepare("INSERT INTO project_costs VALUES(1,1,'Labor','Crew hours',12000,'2026-11-22',NULL)").run();
db.prepare("INSERT INTO project_costs VALUES(2,1,'Materials','Window supplies',2000,'2026-11-22',NULL)").run();
db.prepare("INSERT INTO employees VALUES(1,'Pat',20)").run();
db.prepare("INSERT INTO time_entries VALUES(1,1,NULL,'2026-11-23T08:00:00Z',600,'owner',NULL)").run(); // approved, not on a job: 200
db.prepare("INSERT INTO time_entries VALUES(2,1,NULL,'2026-11-23T08:00:00Z',600,NULL,NULL)").run();    // not approved: left out

// A bill is recognised when entered, and paid later.
const billId = E.createBill(db, { vendor: 'Insurance Co', description: 'Liability premium', category: 'insurance', amount: 500, bill_date: '2026-11-20' }, 'owner@test');
let tb = L.trialBalance(db);
const bal = c => tb.accounts.find(a => a.code === c).balance;
assert.strictEqual(bal('2000'), 500, 'bill creates a payable');
assert.strictEqual(bal('6000'), 500, 'bill is an operating expense');
E.payBill(db, billId, { date: '2026-11-25', by: 'owner@test' });
tb = L.trialBalance(db);
assert.strictEqual(bal('2000'), 0, 'paying the bill clears the payable');
assert.throws(() => E.payBill(db, billId, {}), /already paid/);
console.log('ok - a bill posts when entered and clears when paid; paying twice refused');

// Recorded job costs and unassigned approved time post once.
const first = E.syncRecorded(db);
assert.deepStrictEqual([first.project_costs_posted, first.payroll_posted], [2, 1]);
tb = L.trialBalance(db);
assert.strictEqual(bal('5000'), 12000, 'job labor');
assert.strictEqual(bal('5100'), 2000, 'job materials');
assert.strictEqual(bal('6100'), 200, 'approved time not on a job: 10 hours at $20');
assert.strictEqual(bal('2300'), 12200, 'accrued payroll = job labor + unassigned time');
assert.strictEqual(tb.balanced, true);
assert.strictEqual(E.syncRecorded(db).project_costs_posted, 0, 'second run posts nothing');
console.log('ok - job costs and unassigned payroll post once and balance');

// The unapproved time did not post; the cost drift check shows changes after posting.
assert.deepStrictEqual(E.costDrift(db), [], 'nothing has drifted yet');
db.prepare('UPDATE project_costs SET amount=12500 WHERE id=1').run();
db.prepare('DELETE FROM project_costs WHERE id=2').run();
const drift = E.costDrift(db);
assert.strictEqual(drift.length, 2, 'two drift items');
assert.ok(drift.some(d => /changed/.test(d.issue)) && drift.some(d => /deleted/.test(d.issue)));
console.log('ok - costs changed or deleted after posting are flagged, not re-posted');

// Pay-rate snapshot: an entry approved at $15 keeps $15 after the employee's rate changes to $40.
E.syncRecorded(db); // makes sure the labor_rate column exists
db.prepare("INSERT INTO time_entries(id,employee_id,project_id,clock_in,minutes,approved_by,cost_id,labor_rate) VALUES(4,1,NULL,'2026-11-25T08:00:00Z',60,'owner',NULL,15)").run();
db.prepare("UPDATE employees SET hourly_rate=40 WHERE id=1").run();
const before = L.trialBalance(db).accounts.find(a => a.code === '6100').balance;
E.syncRecorded(db);
const after = L.trialBalance(db).accounts.find(a => a.code === '6100').balance;
assert.strictEqual(Math.round((after - before) * 100) / 100, 15, 'posted at the snapshot rate, not the new 40 rate');
console.log('ok - a later pay-rate change does not change an approved entry');

// Payroll payments: net pay clears accrued payroll; payroll taxes clear their own payable; both need a description.
E.recordPayrollPayment(db, { kind: 'net', amount: 1000, date: '2026-11-26', memo: 'Pay period 11/16 to 11/29', by: 'owner@test' });
E.recordPayrollPayment(db, { kind: 'taxes', amount: 150, date: '2026-11-26', memo: 'Q4 941 deposit', by: 'owner@test' });
const tp = L.trialBalance(db);
assert.strictEqual(tp.accounts.find(a => a.code === '1000').balance, -1650, 'cash: 500 bill paid earlier, 1,000 net pay and 150 taxes');
assert.strictEqual(tp.balanced, true);
assert.throws(() => E.recordPayrollPayment(db, { kind: 'net', amount: 0, date: '2026-11-26', memo: 'x' }), /above zero/);
assert.throws(() => E.recordPayrollPayment(db, { kind: 'bonus', amount: 5, date: '2026-11-26', memo: 'x' }), /net pay or payroll taxes/);
console.log('ok - payroll payments clear accrued payroll and payroll taxes, and bad input is refused');

console.log('\nAll expense checks passed.');
