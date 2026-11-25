// Checks that waiting-for-approval bills and time are shown as pending on a job and are not in its cost.
// Run: node tests/pending-cost-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');
const J = require('../job-cost');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, status TEXT, customer_name TEXT, company TEXT, estimate_id INTEGER, contract_id INTEGER);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, category TEXT NOT NULL, description TEXT, amount REAL NOT NULL, cost_date TEXT, entered_by TEXT, created_at TEXT NOT NULL);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, clock_out TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER);
  INSERT INTO projects(id,name,status) VALUES(1,'Bricktowne','Active'),(2,'Prairie Office','Active');
  INSERT INTO employees(id,name,hourly_rate) VALUES(1,'Pat',20);
`);
L.seedChart(db);

// A bill waiting for approval on job 1, and a split bill with 60 for job 1 and 40 for job 2 still waiting.
E.createBill(db, { vendor: 'Floor Supply', amount: 240, bill_date: '2026-11-20', project_id: 1 }, 'staff@test');
const split = E.createBill(db, { vendor: 'Chemical Co', amount: 100, bill_date: '2026-11-21' }, 'staff@test');
E.setSplits(db, split, [{ project_name: 'Bricktowne', amount: 60 }, { project_name: 'Prairie Office', amount: 40 }], 'owner@test');
// Finished time on job 1 that is not approved yet: 3 hours at 20 = 60.
db.prepare("INSERT INTO time_entries(employee_id,project_id,clock_in,clock_out,minutes) VALUES(1,1,'2026-11-20T08:00:00Z','2026-11-20T11:00:00Z',180)").run();

const job1 = J.pendingFor(db, 1), job2 = J.pendingFor(db, 2);
assert.deepStrictEqual({ bills: job1.bills, labor: job1.labor, total: job1.total }, { bills: 300, labor: 60, total: 360 }, 'job 1 pending: 240 bill + 60 split + 60 labor');
assert.deepStrictEqual({ bills: job2.bills, total: job2.total }, { bills: 40, total: 40 }, 'job 2 pending: its 40 split line');
console.log('ok - pending bills and time are counted per job');

// Posted cost is unchanged by pending items: nothing is approved, so job 1 has no recorded cost.
const report = J.jobCostReport(db, 1);
assert.strictEqual(report.actual.cost, 0, 'nothing pending is in the actual cost');
assert.strictEqual(report.actual.pending.total, 360, 'the report shows the pending total beside the cost');
console.log('ok - the report shows pending beside the cost, and the cost excludes it');

// Once approved, the bill moves from pending into the cost, and pending drops by its amount.
E.approveBill(db, 1, 'owner@test');
const after = J.pendingFor(db, 1);
assert.strictEqual(after.bills, 60, 'only the split line for job 1 is still pending');
console.log('ok - approving a bill moves it from pending into the cost');

console.log('pending cost: all checks passed');
