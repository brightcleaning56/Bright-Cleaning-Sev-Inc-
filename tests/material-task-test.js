// Checks a materials purchase allocated to a task (QA item 10): the purchase lands on the chosen task and its cost to date,
// a task from another project is refused, and no task means the whole project.
// Run: node tests/material-task-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const mountPM = require('../pm');
const TC = require('../task-costs');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, status TEXT, number TEXT, created_at TEXT);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, clock_out TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER, labor_rate REAL, labor_cost REAL, task_id INTEGER);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  INSERT INTO projects(id,name,status,number,created_at) VALUES(1,'Job A','Planning','P-1','2026-11-18'),(2,'Job B','Planning','P-2','2026-11-18');
`);
// project_tasks is created when pm.js mounts, so the task rows are inserted after that.
const routes = {};
const app = { locals: {}, get: (p, ...f) => { routes['GET ' + p] = f[f.length - 1]; }, post: (p, ...f) => { routes['POST ' + p] = f[f.length - 1]; }, patch: () => {}, put: () => {}, delete: () => {} };
mountPM(app, { db, auth: (req, res, next) => next(), logAction: () => {}, clean: (v, n) => String(v || '').slice(0, n || 500), adminEmail: 'owner@test.example' });
TC.ensureSchema(db);
db.prepare("INSERT INTO project_tasks(id,project_id,title,status,created_at) VALUES(10,1,'Strip floors','Open','2026-11-18'),(11,1,'Final clean','Open','2026-11-18'),(20,2,'Other job task','Open','2026-11-18')").run();

const post = routes['POST /api/admin/pm/projects/:id/costs'];
assert.ok(post, 'cost route mounted');
const call = (pid, body) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  post({ params: { id: String(pid) }, body, user: { email: 'owner@test.example' } }, res);
  return res;
};

const onTask = call(1, { category: 'Supplies', amount: '84.50', vendor: 'Glass Supply', description: 'Stripper, 2 jugs', task_id: 10, cost_date: '2026-11-20' });
assert.strictEqual(onTask.code, 201, "purchase recorded: " + JSON.stringify(onTask.body));
const row = db.prepare('SELECT * FROM project_costs WHERE id=?').get(onTask.body.id);
assert.strictEqual(row.task_id, 10, 'the purchase is on the chosen task');
assert.strictEqual(row.description, 'Glass Supply — Stripper, 2 jugs', 'the vendor is kept with the description');
const report = TC.taskReport(db, 1);
const strip = report.tasks.find(t => t.task_id === 10);
assert.ok(Math.abs(strip.actual_other - 84.5) < 0.001 && Math.abs(strip.actual_cost - 84.5) < 0.001, 'the task shows the purchase in its cost: ' + JSON.stringify(strip));
console.log('ok - a materials purchase is recorded against its task and shows in the task cost');

const wrong = call(1, { category: 'Supplies', amount: 20, task_id: 20 });
assert.strictEqual(wrong.code, 400, 'a task from another project is refused');
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM project_costs WHERE amount=20").get().n, 0, 'the refused purchase is not saved');
console.log('ok - a task from another project is refused and nothing is saved');

const whole = call(1, { category: 'Supplies', amount: 60 });
assert.strictEqual(whole.code, 201, 'a purchase with no task is still allowed');
assert.strictEqual(db.prepare('SELECT task_id FROM project_costs WHERE id=?').get(whole.body.id).task_id, null, 'no task means the whole project');
console.log('ok - a purchase with no task is recorded against the project');

console.log('\nAll materials-to-task checks passed.');
