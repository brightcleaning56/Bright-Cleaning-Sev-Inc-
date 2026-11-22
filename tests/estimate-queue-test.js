// Checks estimate (proposal) follow-up on the work engine: open proposals can be assigned, given a follow-up date or a wait;
// details are checked before anything is written; a proposal that is no longer open needs no work and its item is closed.
// Run: node tests/estimate-queue-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE estimates(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT, company TEXT, project_name TEXT, status TEXT NOT NULL, created_at TEXT);`);
db.prepare(`INSERT INTO estimates(id,customer_name,company,project_name,status,created_at) VALUES
  (1,'Pat Hallway','Apt Group','Hallway cleaning','Draft','2026-11-01T10:00:00Z'),
  (2,'Lee Office','Lee LLC','Office nightly','Sent','2026-11-02T10:00:00Z'),
  (3,'Sam Quote','Quote Co','Window washing','Approved','2026-11-03T10:00:00Z')`).run();

// Rules first: nothing is written when a detail is missing or the proposal is not open
assert.throws(() => W.applyEstimateAction(db, 2, { action: 'schedule', date: '2026-02-31' }, 'ana@bc.test'), /follow-up date/);
assert.strictEqual(W.estState(db, 2), null, 'a refused follow-up leaves no item');
assert.throws(() => W.applyEstimateAction(db, 2, { action: 'wait', waiting_on: '', date: '2026-11-25' }, 'ana@bc.test'), /deciding/);
assert.throws(() => W.applyEstimateAction(db, 2, { action: 'wait', waiting_on: 'Budget', date: 'later' }, 'ana@bc.test'), /follow-up date/);
assert.throws(() => W.applyEstimateAction(db, 2, { action: 'approve' }, 'ana@bc.test'), /Unknown estimate action/, 'the queue cannot approve a proposal');
assert.throws(() => W.applyEstimateAction(db, 3, { action: 'assign', assigned_to: 'x@bc.test' }, 'ana@bc.test'), /nothing to follow up/, 'an approved proposal is not followed up here');
assert.throws(() => W.applyEstimateAction(db, 99, { action: 'assign', assigned_to: 'x@bc.test' }, 'ana@bc.test'), /not found/);

// Assign, follow-up date, wait on the customer
W.applyEstimateAction(db, 1, { action: 'assign', assigned_to: 'Ben@bc.test' }, 'owner@bc.test');
assert.strictEqual(W.estState(db, 1).assigned_to, 'ben@bc.test');
W.applyEstimateAction(db, 2, { action: 'schedule', date: '2026-11-25' }, 'owner@bc.test');
assert.strictEqual(W.estState(db, 2).due, '2026-11-25');
W.applyEstimateAction(db, 2, { action: 'wait', waiting_on: 'Board approval', date: '2026-11-30' }, 'owner@bc.test');
assert.strictEqual(W.estState(db, 2).item_status, 'waiting');
assert.strictEqual(W.estState(db, 2).due, '2026-11-30');
assert.throws(() => W.applyEstimateAction(db, 2, { action: 'wait', waiting_on: 'again', date: '2026-12-01' }, 'owner@bc.test'), /already waiting/);

// The proposal itself is unchanged by the queue
assert.strictEqual(db.prepare('SELECT status FROM estimates WHERE id=2').get().status, 'Sent');

// When the proposal is no longer open, its item is closed with the history kept
db.prepare("UPDATE estimates SET status='Declined' WHERE id=2").run();
const closed = W.closeEstimateWork(db, 2, 'Customer declined', 'system');
assert.strictEqual(closed.status, 'completed');
assert.strictEqual(W.estState(db, 2), null, 'a declined proposal leaves the open follow-up');
assert.ok(closed.history.some(h => h.action === 'completed' && h.detail === 'Customer declined'), 'why it closed is in the history');

console.log('All estimate queue checks passed.');
