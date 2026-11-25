// Checks the weekly close: it lists only the unapproved bills in the date range, and a batch approval
// posts each chosen bill once and reports the ones it could not approve.
// Run: node tests/expense-close-test.js
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
`);
L.seedChart(db);
const bal = c => L.trialBalance(db).accounts.find(a => a.code === c).balance;

const inWeek1 = E.createBill(db, { vendor: 'Glass Co', amount: 80, bill_date: '2026-11-18' }, 'staff@test');
const inWeek2 = E.createBill(db, { vendor: 'Mop Co', amount: 40, bill_date: '2026-11-20' }, 'staff@test');
const voided = E.createBill(db, { vendor: 'Dup Co', amount: 10, bill_date: '2026-11-19' }, 'staff@test');
E.voidBill(db, voided, { reason: 'entered twice', by: 'owner@test' });
const outside = E.createBill(db, { vendor: 'Old Co', amount: 500, bill_date: '2026-10-01' }, 'staff@test');
const approvedAlready = E.createBill(db, { vendor: 'Paid Co', amount: 25, bill_date: '2026-11-19' }, 'staff@test');
E.approveBill(db, approvedAlready, 'owner@test');

// 1. The close lists only the unapproved, not-void bills inside the range.
const week = E.closeList(db, { from: '2026-11-16', to: '2026-11-22' });
assert.deepStrictEqual(week.bills.map(b => b.id), [inWeek1, inWeek2], 'only the two unapproved bills in the week are listed');
assert.strictEqual(week.count, 2, 'count');
assert.strictEqual(week.total, 120, 'total is the two bills');
console.log('ok - the close lists the unapproved bills in the week, and no others');

// 2. Nothing is posted until a batch approval.
assert.strictEqual(bal('2000'), 25, 'only the bill approved on its own is on the books before the batch');

// 3. A batch approval posts each chosen bill once and reports failures without stopping the rest.
const out = E.approveBatch(db, [inWeek1, voided, 99999, inWeek1], 'owner@test');
assert.deepStrictEqual(out.approved, [inWeek1], 'the unapproved bill is approved; a repeat id is not approved twice');
assert.strictEqual(out.failed.length, 2, 'the void bill and the unknown id are reported');
assert.strictEqual(bal('2000'), 25 + 80, 'the approved bill is posted once');
assert.strictEqual(L.trialBalance(db).balanced, true, 'the ledger balances');
console.log('ok - a batch approval posts each chosen bill once and reports what it could not approve');

// 4. The approved bill leaves the close; the one not chosen stays.
const after = E.closeList(db, { from: '2026-11-16', to: '2026-11-22' });
assert.deepStrictEqual(after.bills.map(b => b.id), [inWeek2], 'the chosen bill leaves the close; the other stays');
console.log('ok - approved bills leave the close');

console.log('expense close: all checks passed');
