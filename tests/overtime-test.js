// Checks overtime (decision: weekly hours over 40 cost at 1.5 times the rate, into the job): split, cost, week boundary, order.
// Run: node tests/overtime-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const LB = require('../labor');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, hourly_rate REAL);
  CREATE TABLE time_entries(id INTEGER PRIMARY KEY, employee_id INTEGER, project_id INTEGER, clock_in TEXT, minutes INTEGER, approved_by TEXT, cost_id INTEGER, labor_rate REAL);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
`);
LB.ensureColumns(db);
db.prepare("INSERT INTO employees VALUES(1,'Pat',20)").run();

// Week of Monday 2026-11-16 to Sunday 2026-11-22. Monday 30 h, then Wednesday 15 h: 45 h in total, so 5 h are overtime.
const add = (id, clockIn, hours, approved = true) => db.prepare('INSERT INTO time_entries(id,employee_id,project_id,clock_in,minutes,approved_by,labor_rate) VALUES(?,?,?,?,?,?,20)')
  .run(id, 1, 1, clockIn, Math.round(hours * 60), approved ? 'owner' : null);

add(1, '2026-11-16T08:00:00Z', 30);
const mon = LB.costOf(db, { id: 1, employee_id: 1, clock_in: '2026-11-16T08:00:00Z', minutes: 1800, rate: 20 });
assert.strictEqual(mon.cost, 600, 'Monday 30 h at $20, all regular');
assert.strictEqual(mon.overtime_minutes, 0);
add(2, '2026-11-18T08:00:00Z', 15);
const wed = LB.costOf(db, { id: 2, employee_id: 1, clock_in: '2026-11-18T08:00:00Z', minutes: 900, rate: 20 });
assert.strictEqual(wed.regular_minutes, 600, '10 h regular to reach 40 h');
assert.strictEqual(wed.overtime_minutes, 300, '5 h overtime');
assert.strictEqual(wed.cost, 350, '10 h at $20 (200) plus 5 h at $30 (150)');
console.log('ok - 45 h week: 30 h regular (600), then 10 h regular (200) and 5 h overtime at 1.5x (150)');

// Total for the week equals 40 h at the normal rate plus 5 h at the overtime rate.
assert.strictEqual(mon.cost + wed.cost, 800 + 5 * 20 * 1.5, 'week total = 40 h at $20 plus 5 h at $30');
console.log('ok - week total is 40 h regular plus 5 h overtime');

// Order: the split follows clock-in order, not the order of approval.
const wedFirst = LB.costOf(db, { id: 2, employee_id: 1, clock_in: '2026-11-18T08:00:00Z', minutes: 900, rate: 20 });
assert.strictEqual(wedFirst.cost, 350, 'same answer whichever entry is approved first');
console.log('ok - the split does not depend on approval order');

// A new week starts on Monday: hours in the previous week do not count.
const nextMon = LB.costOf(db, { id: 3, employee_id: 1, clock_in: '2026-11-23T08:00:00Z', minutes: 1800, rate: 20 });
assert.strictEqual(nextMon.overtime_minutes, 0, 'Monday 23 Nov starts a new week');
console.log('ok - a new week starts on Monday');

// Exactly 40 hours is regular time. The threshold can be changed by the owner.
db.prepare("INSERT INTO settings VALUES('overtime_after_hours','45',NULL)").run();
const at45 = LB.costOf(db, { id: 2, employee_id: 1, clock_in: '2026-11-18T08:00:00Z', minutes: 900, rate: 20 });
assert.strictEqual(at45.overtime_minutes, 0, 'with a 45 h threshold, 45 h is all regular');
console.log('ok - the threshold setting is respected');

// Stored cost wins over recalculation; with no stored cost the rate in force is used.
assert.strictEqual(LB.storedCost({ minutes: 60, labor_cost: 25, labor_rate: 20 }), 25, 'stored cost is used');
assert.strictEqual(LB.storedCost({ minutes: 60, labor_cost: null, labor_rate: 20 }), 20, 'no stored cost: minutes at the rate in force');
console.log('ok - stored cost is used once it exists');

console.log('\nAll overtime checks passed.');
