// Checks task budgets and task cost (audit G6): budgets, assignment, no double counting, and the reconciliation to project cost.
// Run: node tests/task-costs-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const TC = require('../task-costs');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE project_tasks(id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, phase TEXT, status TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE project_costs(id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT, amount REAL, cost_date TEXT, created_at TEXT);
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER, labor_rate REAL);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
`);
TC.ensureSchema(db);
db.prepare("INSERT INTO projects VALUES(1,'Waco'),(2,'Other')").run();
db.prepare("INSERT INTO project_tasks(id,project_id,title,phase,status) VALUES(1,1,'Stairs','Final','Open'),(2,1,'Windows','Final','Open'),(3,2,'Elsewhere','Final','Open')").run();
db.prepare("INSERT INTO employees VALUES(1,'Pat',20)").run();
// Approved time: 10 h on stairs at $20 (200, cost 5), 1 h unassigned at $15 (15). Unapproved 1 h on windows (left out).
db.prepare("INSERT INTO time_entries(id,employee_id,project_id,clock_in,minutes,approved_by,cost_id,labor_rate) VALUES(1,1,1,'2026-11-21T08:00:00Z',600,'owner',5,20)").run();
db.prepare("INSERT INTO time_entries(id,employee_id,project_id,clock_in,minutes,approved_by,cost_id,labor_rate) VALUES(2,1,1,'2026-11-22T08:00:00Z',60,'owner',NULL,15)").run();
db.prepare("INSERT INTO time_entries(id,employee_id,project_id,clock_in,minutes,approved_by,cost_id,labor_rate) VALUES(3,1,1,'2026-11-22T10:00:00Z',60,NULL,NULL,NULL)").run();
// Project costs: 5 is the labor made from time 1 (skipped, not counted twice); 6 materials on stairs; 7 equipment, unassigned; 8 manual labour on windows.
db.prepare("INSERT INTO project_costs(id,project_id,category,amount,cost_date,created_at) VALUES(5,1,'Labor',200,'2026-11-21','2026-11-21')").run();
db.prepare("INSERT INTO project_costs(id,project_id,category,amount,cost_date,created_at) VALUES(6,1,'Materials',300,'2026-11-21','2026-11-21')").run();
db.prepare("INSERT INTO project_costs(id,project_id,category,amount,cost_date,created_at) VALUES(7,1,'Equipment rental',150,'2026-11-22','2026-11-22')").run();
db.prepare("INSERT INTO project_costs(id,project_id,category,amount,cost_date,created_at) VALUES(8,1,'Labor',100,'2026-11-22','2026-11-22')").run();

TC.setBudget(db, 1, 1, { hours: 20, cost: 1000 }, 'owner@test');
TC.assignTime(db, 1, 1, 'owner@test');
TC.assignCost(db, 6, 1, 'owner@test');
TC.assignCost(db, 8, 2, 'owner@test');
const r = TC.taskReport(db, 1);
const stairs = r.tasks.find(t => t.task_id === 1), windows = r.tasks.find(t => t.task_id === 2);
assert.strictEqual(stairs.actual_labor, 200, 'labor on stairs from approved time');
assert.strictEqual(stairs.actual_hours, 10);
assert.strictEqual(stairs.actual_other, 300, 'materials on stairs');
assert.strictEqual(stairs.actual_cost, 500);
assert.strictEqual(stairs.remaining_budget, 500);
assert.strictEqual(stairs.over_budget, false);
assert.strictEqual(windows.actual_labor, 0, 'unapproved time is not counted');
assert.strictEqual(windows.actual_other, 100, 'manual labour cost on windows');
assert.strictEqual(windows.budget_cost, null, 'no budget set on windows');
console.log('ok - stairs: labor 200 (10 h), materials 300, actual 500 of a 1,000 budget; windows: 100 manual labour, no budget');

// Nothing is counted twice: project recorded cost = 200 + 15 (time) + 300 + 150 + 100 = 765. Tasks hold 600; 165 is not on a task.
assert.strictEqual(r.project_recorded_cost, 765, 'project recorded cost (labor counted once)');
assert.strictEqual(r.totals.actual_on_tasks, 600);
assert.strictEqual(r.not_on_a_task, 165, 'unassigned time (15) and equipment (150)');
assert.strictEqual(r.reconciles, true, 'tasks plus not-on-task equal the project cost');
console.log('ok - recorded 765 = tasks 600 + not on a task 165; labor counted once');

// Rules: a task must belong to the same project; budgets must be numbers zero or more.
assert.throws(() => TC.assignTime(db, 2, 3, 'owner@test'), /same project/);
assert.throws(() => TC.assignCost(db, 7, 3, 'owner@test'), /same project/);
assert.throws(() => TC.setBudget(db, 1, 3, { hours: 1, cost: 1 }, 'owner@test'), /not on this project/);
assert.throws(() => TC.setBudget(db, 1, 1, { hours: -1, cost: 1 }, 'owner@test'), /zero or more/);
assert.strictEqual(TC.taskReport(db, 999), null, 'unknown project returns nothing');
console.log('ok - tasks must match the project; budgets must be sensible');

console.log('\nAll task cost checks passed.');
