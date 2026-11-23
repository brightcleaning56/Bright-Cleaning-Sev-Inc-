// Money rules shared by invoices, contracts, reports and the customer page. Runs against an in-memory database.
const path = require('path');
const root = path.join(__dirname, "..");
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-money-rules-0123456789';
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT, customer_name TEXT, company TEXT, email TEXT, project_id INTEGER,
  amount REAL, tax_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, due_date TEXT, status TEXT, sent_at TEXT, line_items TEXT, notes TEXT, created_at TEXT);
CREATE TABLE payments(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, amount REAL, note TEXT, received_at TEXT, recorded_by TEXT, created_at TEXT);
CREATE TABLE contracts(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, value REAL, signature_status TEXT, status TEXT, customer_name TEXT, company TEXT, email TEXT);
CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, contract_id INTEGER, status TEXT, customer_name TEXT, company TEXT, email TEXT, billing_invoice_id INTEGER, created_at TEXT, updated_at TEXT);
`);
const routes = {};
const app = { get: (p, ...f) => { routes['GET ' + p] = f[f.length - 1]; }, post: (p, ...f) => { routes['POST ' + p] = f[f.length - 1]; }, patch() {}, put() {}, delete() {}, use() {} };
const ownerEmail = 'owner@example.com';
const ctx = { db, auth: (req, res, next) => next(), logAction: () => {}, clean: v => v, adminEmail: ownerEmail, getMailer: () => null, bumpTv() {} };
require(path.join(root, 'invoices2.js'))(app, ctx);
require(path.join(root, 'receivables.js')).ensureSchema(db);
const R = require(path.join(root, 'receivables.js'));

function call(key, params = {}, body = {}) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  return Promise.resolve(routes[key]({ params, body, headers: {}, user: { email: ownerEmail } }, res)).then(() => ({ code: res.code, body: res.body }));
}
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); } }

(async () => {
  // Credit notes and sales tax reduce what is owed, the same way everywhere.
  db.prepare("INSERT INTO invoices(id,invoice_number,amount,tax_amount,paid_amount,status,due_date,created_at) VALUES(1,'T-1',100,10,0,'Sent','2026-01-01','2026-01-01')").run();
  db.prepare("INSERT INTO credit_notes(invoice_id,amount,credit_date,reason,created_at) VALUES(1,30,'2026-01-02','adjustment','2026-01-02')").run();
  const b1 = R.invoiceBalance(db, 1);
  check('balance: tax is owed and a credit note reduces it', b1.billed === 110 && b1.owed === 80, b1);

  // Contract cap at send time: drafts do not block each other, sent invoices do.
  db.prepare("INSERT INTO contracts(id,title,value,signature_status,status) VALUES(1,'Contract',100,'Signed','Active')").run();
  db.prepare("INSERT INTO projects(id,name,contract_id,status) VALUES(1,'P1',1,'Completed'),(2,'P2',1,'In Progress')").run();
  db.prepare("INSERT INTO invoices(id,invoice_number,project_id,amount,status,created_at) VALUES(2,'D-1',1,80,'Draft','x'),(3,'D-2',2,80,'Draft','x')").run();
  const c2 = await call('GET /api/admin/invoices/:id/check', { id: '2' });
  const c3 = await call('GET /api/admin/invoices/:id/check', { id: '3' });
  check('cap: a draft is not blocked by another draft on the same contract', c2.body.ok === true && c3.body.ok === true, { c2: c2.body, c3: c3.body });
  db.prepare("UPDATE invoices SET status='Sent', sent_at='x' WHERE id=2").run();
  const c3b = await call('GET /api/admin/invoices/:id/check', { id: '3' });
  check('cap: once one is sent, the other draft cannot push the contract over its value', c3b.body.ok === false, c3b.body);

  // Billing draft for a second project on the same contract gets only what is left.
  const pmRoutes = {};
  const pmApp = { locals: {}, get: (p, ...f) => { pmRoutes['GET ' + p] = f[f.length - 1]; }, post: (p, ...f) => { pmRoutes['POST ' + p] = f[f.length - 1]; }, patch() {}, put() {}, delete() {}, use() {} };
  try {
    require(path.join(root, 'pm.js'))(pmApp, ctx);
    const hand = pmRoutes['POST /api/admin/pm/projects/:id/billing-handoff'];
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    // Project 1 is completed and has an invoice already, so the remaining value is 100 - 80 - 80 = -60 (no new draft).
    db.prepare("UPDATE projects SET status='Completed' WHERE id=2").run();
    await hand({ params: { id: '2' }, body: {}, headers: {}, user: { email: ownerEmail } }, res);
    const draftsOnP2 = db.prepare('SELECT COUNT(*) n FROM invoices WHERE project_id=2').get().n;
    check('handoff: no second full-value draft when the contract is already fully invoiced', res.code !== 200 && draftsOnP2 === 1, { code: res.code, body: res.body, draftsOnP2 });
  } catch (e) { check('handoff: pm route loads and refuses the second draft', false, String(e.message)); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
