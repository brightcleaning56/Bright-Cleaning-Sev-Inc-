// Checks inspections on the work engine: open inspections carry over once, the work item follows the inspection's status
// (signing, corrective work, reinspection, acceptance and cancellation), the queue can only assign and date an item,
// and finished inspections leave the open queue with their history kept.
// Run: node tests/inspection-queue-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE inspections(id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT, status TEXT NOT NULL, inspector TEXT, itype TEXT, customer_id INTEGER, date TEXT);`);
db.prepare(`INSERT INTO inspections(id,area,status,itype,date) VALUES
  (1,'Lobby level 1','In progress','Internal','2026-11-20'),
  (2,'Suite 210','Corrective action','Customer walkthrough','2026-11-18'),
  (3,'Garage','Completed','Internal','2026-11-10'),
  (4,'Gym','Awaiting customer','Customer walkthrough','2026-11-19')`).run();

// Carry-over: the open ones get items, the completed one does not; running again changes nothing
assert.strictEqual(W.migrateInspectionState(db), 3, 'three open inspections carried over');
assert.strictEqual(W.migrateInspectionState(db), 0, 'running again changes nothing');
assert.ok(W.inspState(db, 1) && W.inspState(db, 1).item_status === 'open', 'an in-progress inspection has an open item');
assert.strictEqual(W.inspState(db, 3), null, 'a completed inspection has no open item');
assert.ok(W.inspState(db, 2) && W.inspState(db, 4), 'corrective and awaiting-customer inspections are on the queue');

// The queue can assign and date; it cannot sign, accept or finish
W.applyInspectionAction(db, 1, { action: 'assign', assigned_to: 'Ana@bc.test' }, 'owner@bc.test');
assert.strictEqual(W.inspState(db, 1).assigned_to, 'ana@bc.test', 'assigning the item lowercases the owner');
W.applyInspectionAction(db, 1, { action: 'schedule', date: '2026-12-02' }, 'owner@bc.test');
assert.strictEqual(W.inspState(db, 1).due, '2026-12-02');
assert.throws(() => W.applyInspectionAction(db, 1, { action: 'complete', note: 'x' }, 'owner@bc.test'), /Unknown inspection action/, 'the queue cannot finish an inspection');
assert.throws(() => W.applyInspectionAction(db, 1, { action: 'schedule', date: '2026-02-31' }, 'owner@bc.test'), /valid date/);
assert.throws(() => W.applyInspectionAction(db, 3, { action: 'assign', assigned_to: 'x@bc.test' }, 'owner@bc.test'), /work is finished/, 'a completed inspection takes no queue actions');

// Signing the inspection (status Completed) finishes its item and keeps the history
db.prepare("UPDATE inspections SET status='Completed' WHERE id=1").run();
W.syncInspection(db, 1, 'inspector@bc.test');
assert.strictEqual(W.inspState(db, 1), null, 'a signed inspection leaves the open queue');
const done = W.get(db, db.prepare("SELECT id FROM work_items WHERE kind='inspection' AND ref_id=1 ORDER BY id DESC LIMIT 1").get().id);
assert.strictEqual(done.status, 'completed');
assert.ok(done.history.some(h => h.action === 'completed' && h.by === 'inspector@bc.test'), 'the completion is in the history');

// A reinspection reopens the finished item when the inspection is open again
db.prepare("UPDATE inspections SET status='Reinspection due' WHERE id=1").run();
W.syncInspection(db, 1, 'owner@bc.test');
assert.ok(W.inspState(db, 1) && W.inspState(db, 1).item_status === 'open', 'open again after a reinspection is due');
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM work_items WHERE kind='inspection' AND ref_id=1").get().n, 1, 'the same item is reopened, not duplicated');

// Cancelling the inspection cancels its item with a reason
db.prepare("UPDATE inspections SET status='Cancelled' WHERE id=1").run();
W.syncInspection(db, 1, 'owner@bc.test');
const cancelled = W.get(db, db.prepare("SELECT id FROM work_items WHERE kind='inspection' AND ref_id=1 ORDER BY id DESC LIMIT 1").get().id);
assert.strictEqual(cancelled.status, 'cancelled');
assert.ok(cancelled.history.some(h => h.action === 'cancelled' && /cancelled/i.test(h.detail || '')), 'the cancel reason is in the history');

// A brand new open inspection gets a new item on its first sync
db.prepare("INSERT INTO inspections(id,area,status,itype,date) VALUES(5,'Hallway','In progress','Internal','2026-11-21')").run();
assert.strictEqual(W.syncInspection(db, 5, 'owner@bc.test').status, 'open', 'a new inspection gets an open item');

console.log('All inspection queue checks passed.');
