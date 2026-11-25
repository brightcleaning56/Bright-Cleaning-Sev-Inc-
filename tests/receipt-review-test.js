// Checks the review help on bills (Phase 3, no AI): a suggested category and job from the vendor's history, and flags for a
// possible duplicate, an unusual amount, a missing receipt, a crew receipt with no job, and a job over its budget.
// Run: node tests/receipt-review-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');
const R = require('../expense-review');

const db = new Database(':memory:');
db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, budget REAL);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, category TEXT NOT NULL, description TEXT, amount REAL NOT NULL, cost_date TEXT, entered_by TEXT, created_at TEXT NOT NULL, source_bill_id INTEGER);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  INSERT INTO projects(id,name,budget) VALUES(1,'Bricktowne',1000),(2,'Prairie Office',0);`);
L.seedChart(db);
const flagCodes = b => R.flagsFor(db, b).map(f => f.code).sort();
const billOf = id => db.prepare('SELECT * FROM expense_bills WHERE id=?').get(id);

// History: three approved Home Depot bills, materials on job 1, amounts 50, 55, 60.
for (const [amount, day] of [[50, '2026-11-01'], [55, '2026-11-08'], [60, '2026-11-15']]) {
  const id = E.createBill(db, { vendor: 'Home Depot', category: 'materials', amount, bill_date: day, project_id: 1, receipt_ref: 'hd-' + day }, 'crew@test');
  E.approveBill(db, id, 'owner@test');
}

// 1. A new bill from the same vendor gets the usual category and job.
const next = E.createBill(db, { vendor: 'home depot ', category: 'equipment', amount: 58, bill_date: '2026-11-22', receipt_ref: 'hd-new', receipt_file: null }, 'crew@test');
const sug = R.suggestFor(db, billOf(next));
assert.strictEqual(sug.category, 'materials', 'the usual category for the vendor is suggested');
assert.strictEqual(sug.project_id, 1, 'the usual job for the vendor is suggested');
assert.strictEqual(sug.project_name, 'Bricktowne', 'the suggested job is named');
assert.strictEqual(sug.basis, 3, 'the suggestion says how many bills it is based on');
console.log('ok - a suggestion comes from the vendor\'s approved history');

// 2. A vendor with no history gets no suggestion.
const newVendor = E.createBill(db, { vendor: 'Brand New Vendor', amount: 20, bill_date: '2026-11-22' }, 'crew@test');
assert.strictEqual(R.suggestFor(db, billOf(newVendor)), null, 'no history means no suggestion');
console.log('ok - no history, no suggestion');

// 3. An amount well above the vendor's usual is flagged; a normal one is not.
assert.ok(flagCodes(billOf(next)).indexOf('unusual_amount') < 0, 'a usual amount is not flagged');
const big = E.createBill(db, { vendor: 'Home Depot', category: 'materials', amount: 200, bill_date: '2026-11-23', project_id: 1, receipt_file: 'x.jpg' }, 'crew@test');
assert.ok(flagCodes(billOf(big)).includes('unusual_amount'), 'an amount over twice the usual is flagged');
console.log('ok - an amount well above the usual is flagged');

// 4. A bill of $75 or more with no receipt is flagged; a small one is not.
const noReceipt = E.createBill(db, { vendor: 'Glass Co', amount: 120, bill_date: '2026-11-24' }, 'crew@test');
assert.ok(flagCodes(billOf(noReceipt)).includes('missing_receipt'), 'a large bill with no receipt is flagged');
const small = E.createBill(db, { vendor: 'Glass Co', amount: 40, bill_date: '2026-11-24' }, 'crew@test');
assert.ok(!flagCodes(billOf(small)).includes('missing_receipt'), 'a small bill does not need a receipt');
console.log('ok - a large bill with no receipt is flagged');

// 5. The same vendor, amount and date as an earlier bill is flagged as a possible duplicate.
const dupe = E.createBill(db, { vendor: 'Home Depot', category: 'materials', amount: 55, bill_date: '2026-11-08', project_id: 1, receipt_file: 'y.jpg' }, 'crew@test');
assert.ok(flagCodes(billOf(dupe)).includes('duplicate'), 'a possible duplicate is flagged');
console.log('ok - a possible duplicate is flagged');

// 6. A crew receipt with no job is flagged until a job is picked.
const crewNoJob = E.createCrewReceipt(db, { employee: { name: 'Sam' }, vendor: 'Gas Station', amount: 40, category: 'travel' }, { filename: 'g.jpg', originalname: 'g.jpg' });
assert.ok(flagCodes(billOf(crewNoJob.id)).includes('no_job'), 'a crew receipt with no job is flagged');
console.log('ok - a crew receipt with no job is flagged');

// 7. A job that would go over its budget is flagged; a bill that fits is not.
db.exec("UPDATE projects SET budget=1100 WHERE id=1"); // history (165) + 900 earlier = 1065 already spent
db.prepare("INSERT INTO project_costs(project_id,category,description,amount,created_at) VALUES(1,'materials','earlier',900,?)").run(new Date().toISOString());
const over = E.createBill(db, { vendor: 'Floor Supply', amount: 150, bill_date: '2026-11-25', project_id: 1, receipt_file: 'f.jpg' }, 'crew@test');
assert.ok(flagCodes(billOf(over)).includes('over_budget'), 'a bill that takes the job over budget is flagged');
const fits = E.createBill(db, { vendor: 'Floor Supply', amount: 30, bill_date: '2026-11-25', project_id: 1, receipt_file: 'f2.jpg' }, 'crew@test');
assert.ok(!flagCodes(billOf(fits)).includes('over_budget'), 'a bill that fits the budget is not flagged');
console.log('ok - a job over its budget is flagged');

// 8. The weekly close carries the review for each bill.
const close = E.closeList(db, { from: '2026-11-20', to: '2026-11-30' });
const row = close.bills.find(b => b.id === big);
assert.ok(row && row.review && row.review.flags.some(f => f.code === 'unusual_amount'), 'the close list carries the flags');
assert.ok(row.review.suggestion && row.review.suggestion.category === 'materials', 'the close list carries the suggestion');
console.log('ok - the weekly close carries the suggestion and flags');

console.log('receipt review: all checks passed');
