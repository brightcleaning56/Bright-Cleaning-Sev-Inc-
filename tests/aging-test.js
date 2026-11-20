// Checks aging (audit G4, G12): receivables by days past due, payables by bill age, and the vendor list.
// Run: node tests/aging-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const A = require('../aging');
const E = require('../expenses');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, customer_name TEXT, amount REAL, tax_amount REAL DEFAULT 0, status TEXT, issue_date TEXT, due_date TEXT, created_at TEXT);
  CREATE TABLE payments(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount REAL, received_at TEXT);
`);
L.seedChart(db);
db.prepare("INSERT INTO invoices VALUES(1,'INV-1','Jensen',1000,0,'Sent','2026-09-01','2026-09-30',NULL)").run(); // 51 days past due on 11-20
db.prepare("INSERT INTO invoices VALUES(2,'INV-2','Robins',2000,0,'Sent','2026-11-10','2026-12-10',NULL)").run(); // not yet due
db.prepare("INSERT INTO invoices VALUES(3,'INV-3','Roers',500,0,'Sent','2026-10-01','2026-10-31',NULL)").run(); // 20 days past due
db.prepare("INSERT INTO invoices VALUES(4,'INV-4','Draft Co',700,0,'Draft','2026-10-01','2026-10-31',NULL)").run(); // draft: excluded
db.prepare("INSERT INTO payments VALUES(1,3,500,'2026-11-01')").run(); // invoice 3 fully paid
const ar = A.arAging(db, { asOf: '2026-11-20' });
assert.strictEqual(ar.rows.length, 2, 'paid and draft invoices are left out');
assert.strictEqual(ar.totals['31-60'], 1000, 'invoice 1 is 51 days past due');
assert.strictEqual(ar.totals['current'], 2000, 'invoice 2 is not yet due');
assert.strictEqual(ar.total, 3000);
assert.strictEqual(ar.rows[0].invoice_number, 'INV-1', 'oldest first');
console.log('ok - receivables aging: 1,000 at 31-60 days, 2,000 current; paid and draft excluded');

// Payables: bills by age, grouped by vendor, and the vendor list.
E.createBill(db, { vendor: 'Insurance Co', description: 'Premium', amount: 500, bill_date: '2026-09-15' }, 'owner@test'); // ~66 days
E.createBill(db, { vendor: 'insurance co', description: 'Endorsement', amount: 100, bill_date: '2026-11-10' }, 'owner@test'); // 10 days
E.createBill(db, { vendor: 'Supply House', description: 'Rags', amount: 250, bill_date: '2026-11-19' }, 'owner@test'); // 1 day
const ap = A.apAging(db, { asOf: '2026-11-20' });
assert.strictEqual(ap.vendors.length, 2, 'vendor names match regardless of case');
const ins = ap.vendors.find(v => v.vendor === 'Insurance Co');
assert.strictEqual(ins.buckets['61-90'], 500, 'premium 66 days old');
assert.strictEqual(ins.buckets['1-30'], 100, 'endorsement 10 days old');
assert.strictEqual(ap.total, 850);
const vendors = A.listVendors(db).vendors.map(v => v.name).sort();
assert.deepStrictEqual(vendors, ['Insurance Co', 'Supply House'], 'one vendor record per name');
console.log('ok - payables aging by bill age, vendors kept once per name');

assert.throws(() => A.arAging(db, { asOf: 'soon' }), /as_of must be a date/);
console.log('ok - bad dates refused');

console.log('\nAll aging checks passed.');
