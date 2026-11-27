// Checks monthly bills: a template makes one Open bill on its day each month, never the same month twice,
// never before its day, and never approves anything. Run: node tests/recurring-bills-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');

const db = new Database(':memory:');
db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);`);
L.seedChart(db);
E.ensureSchema(db);
E.ensureRecurring(db);

// The AmTrust workers' comp bill: $322.00 on the 28th, starting in December (November is already billed).
db.prepare("INSERT INTO recurring_bills(vendor,description,category,amount,day_of_month,project_id,active,last_month,created_at) VALUES(?,?,?,?,?,?,1,?,?)")
  .run('AmTrust Financial Services', 'Workers comp premium', 'Insurance', 322, 28, null, '2026-11', '2026-11-27T00:00:00Z');

const bills = () => db.prepare("SELECT id, vendor, amount, category, status, project_id, bill_date FROM expense_bills WHERE vendor='AmTrust Financial Services' ORDER BY id").all();

// Before the 28th: nothing.
assert.deepStrictEqual(E.createDueRecurring(db, '2026-12-27'), [], 'made a bill before the 28th');
assert.strictEqual(bills().length, 0);

// On the 28th: one bill, dated the 28th, Insurance, Open, not approved.
const made = E.createDueRecurring(db, '2026-12-28');
assert.strictEqual(made.length, 1, 'expected one bill on the 28th');
let [b] = bills();
assert.strictEqual(b.bill_date, '2026-12-28');
assert.strictEqual(b.amount, 322);
assert.strictEqual(b.category, 'Insurance');
assert.strictEqual(b.status, 'Open');
assert.strictEqual(b.project_id, null, 'a company bill has no job');
assert.strictEqual(db.prepare('SELECT approved_by FROM expense_bills WHERE id=?').get(b.id).approved_by, null, 'a monthly bill was approved');

// Same month again (a second check later that day): no second bill.
assert.deepStrictEqual(E.createDueRecurring(db, '2026-12-28'), [], 'made the same month twice');
assert.strictEqual(bills().length, 1);

// The next month's 28th: one more bill.
assert.strictEqual(E.createDueRecurring(db, '2027-01-28').length, 1);
assert.deepStrictEqual(bills().map(x => x.bill_date), ['2026-12-28', '2027-01-28']);

// A stopped template makes nothing more.
db.prepare('UPDATE recurring_bills SET active=0').run();
assert.deepStrictEqual(E.createDueRecurring(db, '2027-02-28'), [], 'a stopped template still made a bill');
console.log('PASS  monthly bills: one per month on the 28th, none early or twice, none approved, stops when stopped');
