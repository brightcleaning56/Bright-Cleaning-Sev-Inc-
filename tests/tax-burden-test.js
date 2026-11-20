// Checks the optional sales tax on invoices and the optional labor burden. Both are off by default.
// Run: node tests/tax-burden-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const IL = require('../invoice-ledger');
const E = require('../expenses');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, amount REAL, status TEXT, issue_date TEXT, created_at TEXT);
  CREATE TABLE payments(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount REAL, received_at TEXT);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, description TEXT, amount REAL, cost_date TEXT, created_at TEXT);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
`);
L.seedChart(db);

// Sales tax: an invoice of 50,000 plus 4,000 tax. The receivable is 54,000; revenue 50,000; tax payable 4,000.
db.prepare("INSERT INTO invoices VALUES(1,'INV-1',50000,'Sent','2026-11-20',NULL)").run();
db.prepare("INSERT INTO payments VALUES(1,1,25000,'2026-11-21T10:00:00Z')").run();
const { mountRoutes } = (() => {
  const routes = {};
  const app = { post: (p, mw, h) => { routes['POST ' + p] = h; }, get: (p, mw, h) => { routes['GET ' + p] = h; } };
  IL.mount(app, { db, auth: (q, s, n) => n() });
  return { mountRoutes: routes };
})();
const setTax = (id, tax) => {
  let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  mountRoutes['POST /api/admin/invoices/:id/tax']({ params: { id: String(id) }, body: { tax_amount: tax } }, res);
  return out;
};
assert.strictEqual(setTax(1, 4000).code, 200, 'tax can be set before posting');
IL.syncAll(db);
let tb = L.trialBalance(db);
const bal = c => tb.accounts.find(a => a.code === c).balance;
assert.strictEqual(bal('1100'), 29000, 'receivable = 54,000 less 25,000 paid');
assert.strictEqual(bal('4000'), 50000, 'revenue is the invoice amount, not the tax');
assert.strictEqual(bal('2100'), 4000, 'tax is payable');
assert.strictEqual(tb.balanced, true);
assert.strictEqual(IL.tieOut(db).tied_out, true, 'receivables tie out with tax included');
db.prepare("INSERT INTO invoices(id,invoice_number,amount,status,issue_date,created_at) VALUES(2,'INV-2',1000,'Sent','2026-11-24',NULL)").run();
const open = IL.tieOut(db).unposted;
assert.deepStrictEqual(open.map(i => i.id), [2], 'only the invoice not yet on the ledger is listed');
assert.strictEqual(open[0].amount, 1000);
console.log('ok - sales tax posts to tax payable; revenue excludes it; receivables tie out; unposted invoices are listed');

// Once posted, tax cannot be changed in place.
assert.strictEqual(setTax(1, 9999).code, 409, 'tax refused after the invoice is on the ledger');
console.log('ok - tax is refused once the invoice is on the ledger');

// Labor burden: off by default, then 10% of the labor posted.
db.prepare("INSERT INTO project_costs VALUES(1,1,'Labor','Crew',12000,'2026-11-22',NULL)").run();
db.prepare("INSERT INTO project_costs VALUES(2,1,'Materials','Supplies',2000,'2026-11-22',NULL)").run();
db.prepare("INSERT INTO employees VALUES(1,'Pat',20)").run();
db.prepare("INSERT INTO time_entries VALUES(1,1,NULL,'2026-11-23T08:00:00Z',600,'owner',NULL)").run();
const off = E.syncRecorded(db);
assert.strictEqual(off.burden_posted, 0, 'no burden while the setting is absent');
db.prepare("INSERT INTO settings VALUES('ledger_burden_pct','10',NULL)").run();
const on = E.syncRecorded(db);
assert.strictEqual(on.burden_posted, 2, 'burden posts for job labor and unassigned time');
tb = L.trialBalance(db);
assert.strictEqual(bal('5000'), 13200, 'job labor 12,000 + burden 1,200');
assert.strictEqual(bal('6100'), 220, 'unassigned payroll 200 + burden 20');
assert.strictEqual(tb.balanced, true);
assert.strictEqual(E.syncRecorded(db).burden_posted, 0, 'burden posts once');
console.log('ok - labor burden is off by default, then posts 10% once, and the books balance');

// Iowa state rate: 6% suggested on the invoice amount; an exemption reason (for example construction) forces tax to zero and is kept.
let sug; { const res = { json(b) { sug = b; return this; }, status() { return this; } }; mountRoutes['GET /api/admin/invoices/:id/tax-suggestion']({ params: { id: '2' } }, res); }
assert.strictEqual(sug.rate_pct, 6, 'Iowa state rate 6%');
assert.strictEqual(sug.suggested, 60, '6% of the 1,000 invoice');
console.log('ok - Iowa 6% state rate is suggested on the invoice amount');
const exempt = (() => { let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } }; mountRoutes['POST /api/admin/invoices/:id/tax']({ params: { id: '2' }, body: { tax_amount: 60, tax_exempt_reason: 'New construction cleaning (exempt)' } }, res); return out; })();
assert.strictEqual(exempt.code, 200);
assert.strictEqual(db.prepare('SELECT tax_amount, tax_exempt_reason FROM invoices WHERE id=2').get().tax_amount, 0, 'an exemption sets the tax to zero');
assert.strictEqual(db.prepare('SELECT tax_exempt_reason FROM invoices WHERE id=2').get().tax_exempt_reason, 'New construction cleaning (exempt)', 'the reason is kept');
console.log('ok - an exemption reason sets tax to zero and is kept with the invoice');

console.log('\nAll tax and burden checks passed.');
