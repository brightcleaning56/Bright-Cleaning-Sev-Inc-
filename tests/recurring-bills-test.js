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

// The routes themselves: mount the expense routes on a stub app and call the handlers with request-like objects.
const os = require('os');
const path = require('path');
const routes = {};
const stubApp = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) stubApp[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h[h.length - 1]; };
E.mount(stubApp, { db, auth: (q, s, n) => n(), upload: null, uploadDir: os.tmpdir(), logAction: () => {}, clean: x => x, path, getMailer: () => null, isEmail: () => true });
const call = (key, body = {}, params = {}) => new Promise(resolve => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code, body: b }); } };
  routes[key]({ body, params, query: {}, user: { email: 'owner@test' } }, res);
});
(async () => {
  const url = '/api/admin/recurring-bills';
  assert.strictEqual((await call('POST ' + url, { vendor: 'X', amount: 10, day_of_month: 29 })).status, 400, 'day 29 must be refused');
  assert.strictEqual((await call('POST ' + url, { vendor: 'X', amount: 0, day_of_month: 5 })).status, 400, 'a zero amount must be refused');
  assert.strictEqual((await call('POST ' + url, { vendor: '', amount: 10, day_of_month: 5 })).status, 400, 'a vendor is required');
  const ok = await call('POST ' + url, { vendor: 'Route Test Co', amount: 75, day_of_month: 3, category: 'Software' });
  assert.strictEqual(ok.status, 201, 'a valid monthly bill is saved');
  const list = await call('GET ' + url, {});
  assert.ok(list.body.bills.some(b => b.vendor === 'Route Test Co' && b.active === 1), 'the saved template is listed');
  console.log('PASS  monthly bill routes: day 29, zero amount and missing vendor refused; a valid one is saved and listed');
})().catch(e => { console.error('FAIL  monthly bill routes:', e.message); process.exit(1); });
