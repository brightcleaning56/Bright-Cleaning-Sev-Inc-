// Checks the document trace on a linked example: estimate -> contract -> project -> invoices -> payments, and a subscription.
// Run: node tests/trace-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const IL = require('../invoice-ledger');
const T = require('../trace');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE estimates(id INTEGER PRIMARY KEY, project_name TEXT, customer_name TEXT, status TEXT, proposal_total REAL, total_cost REAL, labor_hours REAL);
  CREATE TABLE contracts(id INTEGER PRIMARY KEY, estimate_id INTEGER, kind TEXT, status TEXT, signature_status TEXT, value REAL, renewed_from INTEGER, parent_id INTEGER, customer_name TEXT);
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, contract_id INTEGER, estimate_id INTEGER, status TEXT);
  CREATE TABLE subscriptions(id INTEGER PRIMARY KEY, project_id INTEGER, customer_name TEXT, service TEXT, monthly_amount REAL, status TEXT, start_date TEXT, end_date TEXT);
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, project_id INTEGER, subscription_id INTEGER, billing_period TEXT, amount REAL, status TEXT, due_date TEXT, issue_date TEXT, created_at TEXT);
  CREATE TABLE payments(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount REAL, received_at TEXT);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, amount REAL, cost_date TEXT, created_at TEXT);
`);
L.seedChart(db);
// The chain: estimate 17 -> contract 1 (63,060, signed) -> project 1 -> project invoice 1 (63,060, 25,000 paid),
// and subscription 1 on project 1, billed monthly with invoice 2 (500).
db.prepare("INSERT INTO estimates VALUES(17,'Waco Place final clean','Jensen Group','Accepted',63060,19000,100)").run();
db.prepare("INSERT INTO contracts VALUES(1,17,'Contract','Active','Executed',63060,NULL,NULL,'Jensen Group')").run();
db.prepare("INSERT INTO projects VALUES(1,'Waco Place',1,17,'Active')").run();
db.prepare("INSERT INTO subscriptions VALUES(1,1,'Jensen Group','Window cleaning',500,'Active','2026-11-01',NULL)").run();
db.prepare("INSERT INTO invoices VALUES(1,'INV-1',1,NULL,NULL,63060,'Sent',NULL,'2026-11-20','2026-11-20')").run();
db.prepare("INSERT INTO invoices VALUES(2,'SUB-1',1,1,'2026-11',500,'Sent',NULL,'2026-11-30','2026-11-30')").run();
db.prepare("INSERT INTO payments VALUES(1,1,25000,'2026-11-21T10:00:00Z')").run();
db.prepare("INSERT INTO project_costs VALUES(1,1,'Labor',12000,'2026-11-22','2026-11-22')").run();
IL.syncAll(db);
require('../expenses').syncRecorded(db);

const fromEst = T.traceDocument(db, 'estimate', 17);
assert.deepStrictEqual(fromEst.contracts.map(c => c.id), [1], 'estimate reaches its contract');
assert.deepStrictEqual(fromEst.projects.map(p => p.id), [1], 'and its project');
assert.deepStrictEqual(fromEst.invoices.map(i => i.id).sort(), [1, 2], 'and both invoices (project and subscription)');
assert.deepStrictEqual(fromEst.subscriptions.map(s => s.id), [1], 'and the subscription');
assert.strictEqual(fromEst.payments.length, 1, 'and the payment');
console.log('ok - estimate reaches contract, project, both invoices, subscription and payment');

// Starting from a subscription or an invoice gives the same chain.
const fromSub = T.traceDocument(db, 'subscription', 1);
assert.deepStrictEqual(fromSub.estimates.map(e => e.id), [17], 'subscription reaches the estimate');
assert.deepStrictEqual(fromSub.invoices.map(i => i.id).sort(), [1, 2]);
const fromInv = T.traceDocument(db, 'invoice', 2);
assert.deepStrictEqual(fromInv.estimates.map(e => e.id), [17], 'a subscription invoice reaches the estimate');
assert.deepStrictEqual(fromInv.contracts.map(c => c.id), [1]);
console.log('ok - starting from a subscription or a subscription invoice reaches the same chain');

// Figures and the differences an accountant needs.
const f = fromEst.figures;
assert.strictEqual(f.estimate_proposal_total, 63060);
assert.strictEqual(f.contract_value, 63060, 'contract value follows the reports rule');
assert.strictEqual(f.project_invoiced, 63060, 'project invoices');
assert.strictEqual(f.subscription_invoiced, 500, 'subscription invoices shown separately');
assert.strictEqual(f.paid, 25000);
assert.strictEqual(f.owed, 38560, 'owed = 63,060 + 500 - 25,000');
assert.ok(fromEst.invoices.find(i => i.id === 1).on_ledger, 'invoice shows it is on the ledger');
assert.ok(fromEst.ledger_entries.some(e => e.source_ref === 'project-cost:1'), 'project labor cost is on the ledger');
console.log('ok - figures: contract 63,060; invoiced 63,060 + 500 subscription; paid 25,000; owed 38,560');

// A missing document is reported, not invented.
assert.strictEqual(T.traceDocument(db, 'estimate', 999), null, 'unknown estimate returns nothing');
assert.strictEqual(T.traceDocument(db, 'invoice', 999), null, 'unknown invoice returns nothing');
console.log('ok - unknown documents return nothing');

console.log('\nAll trace checks passed.');
