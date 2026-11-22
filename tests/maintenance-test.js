// Equipment and facility maintenance: the service interval sets the next due date, a service moves it on,
// and only items that are due land in the right queue bucket. Run: node tests/maintenance-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const M = require('../maintenance');

const db = new Database(':memory:');
M.ensureTable(db);

// Rules first: nothing is written for a bad record
assert.throws(() => M.createItem(db, { name: '' }), /Name the equipment/);
assert.throws(() => M.createItem(db, { name: 'Van 1', interval_days: 0 }), /between 1 and 3650/);
assert.throws(() => M.createItem(db, { name: 'Van 1', interval_days: 90, last_service_date: '2026-02-31' }), /valid date/);
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM maintenance_items').get().n, 0, 'refused records leave nothing behind');

// Pure helpers
assert.strictEqual(M.addDays('2026-11-22', 90), '2027-02-20');
assert.strictEqual(M.addDays('2026-12-31', 1), '2027-01-01', 'crosses the year');
assert.strictEqual(M.bucketFor(null, '2026-11-22'), 'new');
assert.strictEqual(M.bucketFor('2026-11-23', '2026-11-22'), 'scheduled');
assert.strictEqual(M.bucketFor('2026-11-22', '2026-11-22'), 'today');
assert.strictEqual(M.bucketFor('2026-11-01', '2026-11-22'), 'overdue');

// A van serviced on 1 Nov every 30 days is due 1 Dec, so on 22 Nov it is still scheduled.
const van = M.createItem(db, { name: 'Van 1', category: 'Van', location: 'Yard', interval_days: 30, last_service_date: '2026-11-01' }, '2026-11-01T10:00:00Z');
assert.strictEqual(van.next_due, '2026-12-01', 'the first due date comes from the last service');
const vac = M.createItem(db, { name: 'Backpack vac', category: 'Vacuum', interval_days: 60 }, '2026-11-02T10:00:00Z');
assert.strictEqual(vac.next_due, null, 'no service yet means no due date');
assert.strictEqual(vac.category, 'Vacuum');
assert.strictEqual(M.createItem(db, { name: 'Floor machine', category: 'Bogus', interval_days: 90 }).category, 'Other', 'unknown types fall back to Other');

// Queue rows: buckets follow the due date
let rows = M.queueRows(db, '2026-11-22');
const byName = Object.fromEntries(rows.map(r => [r.title.split(' · ')[0], r]));
assert.strictEqual(byName['Van 1'].bucket, 'scheduled');
assert.strictEqual(byName['Backpack vac'].bucket, 'new');
assert.strictEqual(byName['Van 1'].dept, 'maintenance');
rows = M.queueRows(db, '2026-12-05');
assert.strictEqual(Object.fromEntries(rows.map(r => [r.title.split(' · ')[0], r])) ['Van 1'].bucket, 'overdue', 'past its due date it is overdue');

// Assign, schedule, then serviced: service records the date and moves the next due date on
M.applyMaintenanceAction(db, van.id, { action: 'assign', assigned_to: 'Ben@bc.test' }, 'owner@bc.test');
assert.strictEqual(M.applyMaintenanceAction(db, van.id, { action: 'assign', assigned_to: 'Ben@bc.test' }, 'x').assigned_to, 'ben@bc.test');
assert.throws(() => M.applyMaintenanceAction(db, van.id, { action: 'schedule', date: 'soon' }, 'x'), /real due date/);
M.applyMaintenanceAction(db, van.id, { action: 'schedule', date: '2026-11-25' }, 'x');
assert.strictEqual(M.applyMaintenanceAction(db, van.id, { action: 'serviced', date: '2026-11-24' }, 'x').next_due, '2026-12-24');
const after = M.applyMaintenanceAction(db, van.id, { action: 'serviced', date: '2026-11-24' }, 'x');
assert.strictEqual(after.last_service_date, '2026-11-24', 'the service date is kept');
assert.throws(() => M.applyMaintenanceAction(db, van.id, { action: 'delete' }, 'x'), /Unknown maintenance action/);
assert.throws(() => M.applyMaintenanceAction(db, 9999, { action: 'serviced' }, 'x'), /not on the list/);

// Inactive records leave the queue
db.prepare('UPDATE maintenance_items SET active=0 WHERE id=?').run(vac.id);
assert.strictEqual(M.queueRows(db, '2026-11-22').some(r => r.title.startsWith('Backpack vac')), false, 'retired equipment leaves the queue');

console.log('All maintenance checks passed.');
