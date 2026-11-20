// Checks the reconciliation of the existing Reports figures with the ledger (audit G16) on the worked example.
// Run: node tests/compare-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const C = require('../compare');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, amount REAL, paid_amount REAL DEFAULT 0, status TEXT, issue_date TEXT, created_at TEXT);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, amount REAL, cost_date TEXT, created_at TEXT);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER, labor_rate REAL);
`);
L.seedChart(db);
// The worked example, as the operations records and the ledger would both hold it.
db.prepare("INSERT INTO invoices(id,invoice_number,amount,paid_amount,status,issue_date) VALUES(1,'INV-1',50000,25000,'Sent','2026-11-20')").run();
db.prepare("INSERT INTO project_costs(id,project_id,category,amount,cost_date) VALUES(1,1,'Labor',12000,'2026-11-22'),(2,1,'Materials',7000,'2026-11-22')").run();
L.postEntry(db, { date: '2026-11-20', memo: 'Invoice 1', source: 'invoice', sourceRef: 'invoice:1', lines: [{ account: '1100', debit: 50000 }, { account: '4000', credit: 50000 }] });
L.postEntry(db, { date: '2026-11-21', memo: 'Payment', source: 'payment', sourceRef: 'payment:1', lines: [{ account: '1000', debit: 25000 }, { account: '1100', credit: 25000 }] });
L.postEntry(db, { date: '2026-11-22', memo: 'Job labor', source: 'project-cost', sourceRef: 'project-cost:1', lines: [{ account: '5000', debit: 12000 }, { account: '2300', credit: 12000 }] });
L.postEntry(db, { date: '2026-11-22', memo: 'Job materials', source: 'project-cost', sourceRef: 'project-cost:2', lines: [{ account: '5100', debit: 7000 }, { account: '2000', credit: 7000 }] });

const r = C.compare(db, { from: '2026-11-01', to: '2026-11-30' });
const byName = n => r.rows.find(x => x.metric === n);
assert.strictEqual(byName('Invoiced (revenue)').existing, 50000);
assert.strictEqual(byName('Invoiced (revenue)').ledger, 50000);
assert.strictEqual(byName('Collected').existing, 25000);
assert.strictEqual(byName('Collected').ledger, 25000);
assert.strictEqual(byName('Costs').existing, 19000);
assert.strictEqual(byName('Costs').ledger, 19000);
assert.strictEqual(r.agrees_overall, true, 'the worked example agrees on every line');
console.log('ok - worked example: invoiced 50,000, collected 25,000, costs 19,000 agree on both sides');

// A payment the invoice record does not show is a real difference, and is listed with its reason.
L.postEntry(db, { date: '2026-11-25', memo: 'Payment not recorded on the invoice', source: 'payment', sourceRef: 'payment:2', lines: [{ account: '1000', debit: 3000 }, { account: '1100', credit: 3000 }] });
const r2 = C.compare(db, { from: '2026-11-01', to: '2026-11-30' });
const col = r2.rows.find(x => x.metric === 'Collected');
assert.strictEqual(col.difference, 3000, 'the unrecorded payment shows as a difference');
assert.strictEqual(col.agrees, false);
assert.ok(/payment entries/.test(col.why));
assert.strictEqual(r2.agrees_overall, false);
console.log('ok - a payment missing from the invoice record shows as a 3,000 difference with its reason');

assert.throws(() => C.compare(db, { from: '2026-11-30', to: '2026-11-01' }), /on or before/);
console.log('ok - bad ranges are refused');

console.log('\nAll compare checks passed.');
