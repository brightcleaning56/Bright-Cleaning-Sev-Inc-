// Checks the job cost report on the audit's worked example, and that labor is never counted twice.
// Run: node tests/job-cost-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const { jobCostReport, accountFor } = require('../job-cost');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, customer_name TEXT, company TEXT, contract_id INTEGER, estimate_id INTEGER);
  CREATE TABLE contracts(id INTEGER PRIMARY KEY, value REAL, kind TEXT, status TEXT);
  CREATE TABLE estimates(id INTEGER PRIMARY KEY, proposal_total REAL, total_cost REAL, labor_hours REAL);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, amount REAL);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, minutes INTEGER, approved_by TEXT, cost_id INTEGER);
`);
db.prepare("INSERT INTO contracts VALUES(1,50000,'Contract','Active')").run();
db.prepare("INSERT INTO estimates VALUES(1,50000,19000,100)").run();
db.prepare("INSERT INTO projects VALUES(1,'Commercial construction cleaning','Test Builder','Test Co',1,1)").run();
// Recorded costs = the audit's 19,000.
[['Labor', 12000], ['Materials', 2000], ['Equipment rental', 1000], ['Subcontractor', 3000], ['Travel and disposal', 1000]]
  .forEach(([c, a], i) => db.prepare('INSERT INTO project_costs VALUES(?,?,?,?)').run(i + 1, 1, c, a));
db.prepare("INSERT INTO employees VALUES(1,20)").run();
// 10 approved hours not yet posted (200), an approved hour already posted (cost_id set: must not be added again), and an unapproved hour (must be left out).
db.prepare("INSERT INTO time_entries VALUES(1,1,1,600,'owner',NULL)").run();
db.prepare("INSERT INTO time_entries VALUES(2,1,1,60,'owner',77)").run();
db.prepare("INSERT INTO time_entries VALUES(3,1,1,60,NULL,NULL)").run();

const r = jobCostReport(db, 1);
assert.strictEqual(r.projected.cost, 19000, 'projected cost from the estimate');
assert.strictEqual(r.projected.gross_profit, 31000, 'projected gross profit 31,000');
assert.strictEqual(r.projected.gross_margin_pct, 62, 'projected margin 62%');
assert.strictEqual(r.actual.cost, 19200, 'actual cost = recorded 19,000 + unposted approved labor 200 (posted and unapproved time excluded)');
assert.strictEqual(r.actual.unposted_labor, 200, 'unposted labor is 10 hours at $20');
assert.strictEqual(r.actual.gross_profit, 30800, 'actual gross profit on the 50,000 contract');
assert.strictEqual(r.actual.revenue_source, 'contract', 'revenue basis is the linked contract');
const labor = r.cost_by_account.find(l => l.code === '5000');
assert.strictEqual(labor.amount, 12200, 'labor = posted 12,000 + unposted 200');
assert.ok(r.gaps.length >= 3, 'known gaps are listed');
console.log('ok - worked example: projected GP', r.projected.gross_profit, '| actual cost', r.actual.cost, '| actual GP', r.actual.gross_profit, '| labor', labor.amount);

// Category words map to the ledger accounts; unknown words go to the unmapped operating line.
assert.strictEqual(accountFor('Crew wages').code, '5000');
assert.strictEqual(accountFor('Window squeegee supplies').code, '5100');
assert.strictEqual(accountFor('Lift rental').code, '5200');
assert.strictEqual(accountFor('Sub - glazing').code, '5300');
assert.strictEqual(accountFor('Dumpster haul').code, '5400');
assert.strictEqual(accountFor('Miscellaneous').code, '6000');
console.log('ok - category words map to ledger accounts');

// No linked contract or estimate: say so, do not invent numbers.
db.prepare('INSERT INTO projects VALUES(2,\'Loose job\',\'X\',\'Y\',NULL,NULL)').run();
const bare = jobCostReport(db, 2);
assert.strictEqual(bare.projected.cost, null);
assert.strictEqual(bare.actual.gross_profit, null);
assert.ok(/No estimate/.test(bare.projected.note));
assert.strictEqual(jobCostReport(db, 999), null, 'unknown project returns nothing');
console.log('ok - no contract or estimate gives no invented figures');

console.log('\nAll job-cost checks passed.');
