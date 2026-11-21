// Checks the call queue on the work engine: existing call follow-ups carry over once, every move follows the same rules as
// emails (note, date or reason required), the calls table stays in step, and each change is kept in the item's history.
// Run: node tests/call-queue-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE calls(id INTEGER PRIMARY KEY, direction TEXT, phone TEXT, contact_name TEXT, company TEXT, outcome TEXT, handling TEXT, summary TEXT,
  follow_up_date TEXT, follow_up_done INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, handled_at TEXT, handled_by TEXT, lead_id INTEGER, customer_id INTEGER, created_at TEXT);`);
db.prepare(`INSERT INTO calls(id,direction,phone,contact_name,outcome,handling,summary,follow_up_date,follow_up_done,assigned_to,handled_at,created_at) VALUES
  (1,'Inbound','+15155550101','Pat','Answered',NULL,'Quote asked',NULL,0,'ana@bc.test','2026-11-20T11:00:00Z','2026-11-20T10:00:00Z'),
  (2,'Inbound','+15155550102','Lee','Answered','Waiting','Wants a date',  '2026-11-25',0,NULL,NULL,'2026-11-19T10:00:00Z'),
  (3,'Outbound','+15155550103','Sam','Answered','Callback','Call back',  '2026-11-27',0,'ben@bc.test',NULL,'2026-11-18T10:00:00Z'),
  (4,'Inbound','+15155550104','Kim','Missed',NULL,'Left no message',NULL,0,NULL,NULL,'2026-11-17T10:00:00Z')`).run();

const n1 = W.migrateCallState(db);
assert.strictEqual(n1, 3, 'three calls with follow-up state carried over; the untouched missed call is not');
assert.strictEqual(W.migrateCallState(db), 0, 'running the carry-over again changes nothing');
const i1 = W.callItemOf(db, 1), i2 = W.callItemOf(db, 2), i3 = W.callItemOf(db, 3);
assert.strictEqual(W.get(db, i1.id).status, 'completed', 'handled call is completed');
assert.strictEqual(W.get(db, i1.id).assigned_to, 'ana@bc.test');
assert.strictEqual(W.get(db, i2.id).status, 'waiting');
assert.strictEqual(W.get(db, i2.id).next_follow_up, '2026-11-25', 'waiting call keeps its follow-up date');
assert.strictEqual(W.get(db, i3.id).status, 'open');
assert.strictEqual(W.get(db, i3.id).due_date, '2026-11-27');
assert.strictEqual(W.callItemOf(db, 4), undefined, 'a call with no state has no item yet');

// The queue's view and the rules
assert.strictEqual(W.callState(db, 4), null, 'no item means the call keeps its own fields');
assert.throws(() => W.applyCallAction(db, 1, { action: 'handle' }, 'ana@bc.test'), /cannot be changed this way/, 'a completed call cannot be completed again');
assert.throws(() => W.applyCallAction(db, 3, { action: 'handle' }, 'ana@bc.test'), /completion note/, 'completing needs a note');
assert.throws(() => W.applyCallAction(db, 3, { action: 'waiting' }, 'ana@bc.test'), /what it is waiting on/, 'waiting needs what for');
assert.throws(() => W.applyCallAction(db, 3, { action: 'schedule', date: '2026-02-31' }, 'ana@bc.test'), /callback date/, 'an impossible callback date is refused');
assert.throws(() => W.applyCallAction(db, 3, { action: 'explode' }, 'ana@bc.test'), /Unknown call action/);
assert.throws(() => W.applyCallAction(db, 4, { action: 'cancel' }, 'ana@bc.test'), /reason/, 'cancelling needs a reason');
assert.throws(() => W.applyCallAction(db, 99, { action: 'assign', assigned_to: 'x' }, 'ana@bc.test'), /Call not found/);

// A new call with no item is seeded when first touched
W.applyCallAction(db, 4, { action: 'assign', assigned_to: 'cy@bc.test' }, 'ana@bc.test');
const s4 = W.callState(db, 4);
assert.ok(s4 && s4.item_status === 'open' && s4.assigned_to === 'cy@bc.test', 'assigned call now has an item on the queue');
assert.strictEqual(db.prepare('SELECT assigned_to FROM calls WHERE id=4').get().assigned_to, 'cy@bc.test', 'calls table mirrors the owner');

// Complete with a note: leaves the queue, mirrors to the calls table, history records who and what
const done = W.applyCallAction(db, 2, { action: 'handle', note: 'Booked a walkthrough' }, 'ana@bc.test');
assert.strictEqual(done.status, 'completed');
assert.strictEqual(done.completion_note, 'Booked a walkthrough');
const c2 = db.prepare('SELECT follow_up_done, handled_at, handled_by, follow_up_date, handling FROM calls WHERE id=2').get();
assert.strictEqual(c2.follow_up_done, 1, 'calls table shows the follow-up as done');
assert.ok(c2.handled_at && c2.handled_by === 'ana@bc.test', 'calls table shows when and by whom');
assert.strictEqual(c2.handling, null, 'the Waiting marker is cleared');
assert.ok(W.get(db, done.id).history.some(h => h.action === 'completed' && h.by === 'ana@bc.test'), 'completion is in the history');

// Reopen needs a reason; afterwards it is back on the queue with its date
assert.throws(() => W.applyCallAction(db, 2, { action: 'reopen' }, 'ana@bc.test'), /reason/, 'reopening needs a reason');
const re = W.applyCallAction(db, 2, { action: 'reopen', reason: 'Customer called back' }, 'ana@bc.test');
assert.strictEqual(re.status, 'open');
assert.strictEqual(db.prepare('SELECT follow_up_done FROM calls WHERE id=2').get().follow_up_done, 0);

// Callback date and waiting
const sch = W.applyCallAction(db, 3, { action: 'schedule', date: '2026-12-01' }, 'ana@bc.test');
assert.strictEqual(sch.due_date, '2026-12-01');
assert.strictEqual(db.prepare('SELECT follow_up_date, handling FROM calls WHERE id=3').get().handling, 'Callback');
const wt = W.applyCallAction(db, 3, { action: 'waiting', waiting_on: 'Customer to confirm access', date: '2026-12-03' }, 'ana@bc.test');
assert.strictEqual(wt.status, 'waiting');
assert.strictEqual(db.prepare('SELECT handling, follow_up_date FROM calls WHERE id=3').get().handling, 'Waiting');
assert.strictEqual(db.prepare('SELECT follow_up_date FROM calls WHERE id=3').get().follow_up_date, '2026-12-03');

// Cancel with reason: closed, kept in history, mirrored as done
const cn = W.applyCallAction(db, 4, { action: 'cancel', reason: 'Wrong number' }, 'ana@bc.test');
assert.strictEqual(cn.status, 'cancelled');
assert.strictEqual(db.prepare('SELECT follow_up_done FROM calls WHERE id=4').get().follow_up_done, 1);
assert.ok(W.get(db, cn.id).history.some(h => h.action === 'cancelled' && /Wrong number/.test(h.detail || '')), 'cancel reason in history');

// A finished call cannot be moved without reopening
assert.throws(() => W.applyCallAction(db, 4, { action: 'schedule', date: '2026-12-05' }, 'ana@bc.test'), /cannot be changed this way/);

// Every item has one item per call (the same item is reused)
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM work_items WHERE kind='call' AND ref_id=2").get().n, 1, 'one item per call');

console.log('All call-queue checks passed.');
