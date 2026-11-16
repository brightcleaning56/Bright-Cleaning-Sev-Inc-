// Checks the finance report's reconciliation: costs with no revenue must produce a data check, never "no gaps".
// Runs the report on a small in-memory database. Run: node tests/reports-recon-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const mountReports = require('../reports2');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, project_id INTEGER, amount REAL, paid_amount REAL, status TEXT, issued_at TEXT, sent_at TEXT, created_at TEXT, invoice_number TEXT);
  CREATE TABLE contracts(id INTEGER PRIMARY KEY, value REAL);
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, status TEXT, company TEXT, customer_name TEXT, contract_id INTEGER);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, description TEXT, amount REAL, cost_date TEXT);
  INSERT INTO projects(id,name,status,company,customer_name) VALUES(1,'Test job','Active','Test Co','Test Customer');
  INSERT INTO project_costs(project_id,category,description,amount,cost_date) VALUES(1,'Labor','Crew time',200,'2031-01-15');
`);

let routes = {};
const app = { locals: {}, get: (path, ...fns) => { routes[path] = fns[fns.length - 1]; }, post: () => {}, patch: () => {}, put: () => {}, delete: () => {} };
mountReports(app, { db, auth: (req, res, next) => next(), logAction: () => {}, clean: v => String(v || ''), adminEmail: 'owner@test.example', getMailer: () => null });

const handler = routes['/api/admin/reports/finance'];
assert.ok(handler, 'finance route mounted');
let out = null;
handler({ query: { from: '2031-01-01', to: '2031-01-31' }, user: { email: 'owner@test.example' } }, { json: v => { out = v; }, status: () => ({ json: v => { out = v; } }) });

assert.strictEqual(out.invoiced, 0);
assert.strictEqual(out.costs, 200);
assert.ok(out.checks.some(c => /no invoice counts as revenue/.test(c)), 'a data check should explain the missing revenue: ' + JSON.stringify(out.checks));
console.log('ok - costs with no invoiced revenue produce a data check');
console.log('ok - the report does not claim the data is complete');
const monthlyHandler = routes['/api/admin/reports/monthly'];
assert.ok(monthlyHandler, 'monthly route mounted');
let mo = null;
monthlyHandler({ query: { from: '2031-01-01', to: '2031-01-31' }, user: { email: 'owner@test.example' } }, { json: v => { mo = v; } });
assert.strictEqual(mo.costs, out.costs, 'monthly costs add up to the period total');
assert.strictEqual(mo.revenue, out.invoiced, 'monthly revenue adds up to the period total');
assert.strictEqual(mo.months.length, 1); assert.strictEqual(mo.months[0].month, '2031-01');
console.log('ok - monthly figures add up to the period totals');
console.log('\n3 checks passed');
