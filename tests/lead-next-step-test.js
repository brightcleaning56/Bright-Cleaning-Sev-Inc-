// Checks lead next steps on the work engine: existing follow-ups carry over once, every follow-up setter keeps the engine in step,
// a finished step stays in history and the next date starts a new step, and waiting and completing follow the rules.
// Run: node tests/lead-next-step-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE leads(id INTEGER PRIMARY KEY, contact_name TEXT, company TEXT, status TEXT, stage TEXT, follow_up_date TEXT, assigned_to TEXT, customer_id INTEGER);`);
db.prepare(`INSERT INTO leads(id,contact_name,company,status,stage,follow_up_date,assigned_to) VALUES
  (1,'Ana','Ridge Dental','New','followup','2026-11-25','ana@bc.test'),
  (2,'Ben','Oak Clinic','Proposal Sent','new',NULL,NULL),
  (3,'Cy','Pine Office','Won','done','2026-11-30',NULL)`).run();

// Carry-over: lead 1 has a follow-up; lead 3 is won, so it is not carried over; lead 2 has nothing.
assert.strictEqual(W.migrateLeadState(db), 1, 'one open lead with a follow-up carried over');
assert.strictEqual(W.migrateLeadState(db), 0, 'running again changes nothing');
const s1 = W.leadState(db, 1);
assert.ok(s1 && s1.item_status === 'open' && s1.due === '2026-11-25', 'the carried-over step keeps its date');
assert.strictEqual(W.leadState(db, 2), null, 'a lead with no follow-up has no step');
assert.strictEqual(W.leadState(db, 3), null, 'a won lead has no step');

// Setting a follow-up creates the step when the lead has none; a new date on an open step changes it
W.leadSchedule(db, 2, '2026-12-01', 'ana@bc.test');
assert.strictEqual(W.leadState(db, 2).due, '2026-12-01');
W.leadSchedule(db, 2, '2026-12-03', 'ana@bc.test');
assert.strictEqual(W.leadState(db, 2).due, '2026-12-03', 'rescheduling moves the same step');
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM work_items WHERE kind='lead' AND ref_id=2").get().n, 1, 'one step, not two');
assert.throws(() => W.leadSchedule(db, 2, '2026-02-31', 'x'), /follow-up date/, 'an impossible date is refused');

// Waiting: needs what it waits on; the date moves with it
assert.throws(() => W.leadWait(db, 2, '', '2026-12-10', 'ana@bc.test'), /what it is waiting on/);
assert.throws(() => W.leadWait(db, 2, 'Access details', 'nope', 'ana@bc.test'), /YYYY-MM-DD|follow-up date/);
W.leadWait(db, 2, 'Customer to confirm the proposal', '2026-12-08', 'ana@bc.test');
assert.strictEqual(W.leadState(db, 2).item_status, 'waiting');
assert.strictEqual(W.leadState(db, 2).due, '2026-12-08');
assert.throws(() => W.leadWait(db, 2, 'Again', '2026-12-09', 'ana@bc.test'), /already waiting/);

// Completing needs an open step; then the lead has no step until a new date is set
assert.throws(() => W.leadComplete(db, 3, 'x', 'ana@bc.test'), /no open next step/);
W.leadComplete(db, 2, 'Proposal confirmed by phone', 'ana@bc.test');
assert.strictEqual(W.leadState(db, 2), null, 'a finished step leaves the open list');
const done = W.get(db, db.prepare("SELECT id FROM work_items WHERE kind='lead' AND ref_id=2 ORDER BY id DESC LIMIT 1").get().id);
assert.strictEqual(done.status, 'completed');
assert.ok(done.history.some(h => h.action === 'completed' && h.detail === 'Proposal confirmed by phone' && h.by === 'ana@bc.test'), 'completion note and who are in history');

// A new date after a finished step starts a new step; the old one is kept
W.leadSchedule(db, 2, '2026-12-15', 'ana@bc.test');
assert.strictEqual(W.leadState(db, 2).due, '2026-12-15');
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM work_items WHERE kind='lead' AND ref_id=2").get().n, 2, 'a new step, with the finished one kept');

// Clearing: cancels the open step quietly; nothing to cancel is fine
assert.ok(W.leadCancel(db, 2, 'Next step cleared', 'ana@bc.test').status === 'cancelled');
assert.strictEqual(W.leadCancel(db, 2, 'again', 'ana@bc.test'), null, 'clearing with nothing open does nothing');

// Owner change moves the open step; a step with no owner is refused
W.leadSchedule(db, 1, '2026-11-26', 'ana@bc.test');
W.leadReassign(db, 1, 'ben@bc.test', 'ana@bc.test');
assert.strictEqual(W.leadState(db, 1).assigned_to, 'ben@bc.test');
assert.throws(() => W.leadReassign(db, 1, null, 'ana@bc.test'), /assigned to|who it is assigned to/i, 'a step cannot be left without an owner');

console.log('All lead next-step checks passed.');
