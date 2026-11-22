// Checks client conversations on the work engine: queue actions follow the rules and keep the conversation record in step,
// a closed conversation needs a note and leaves the queue, reopening needs a reason, and changes made on the conversation
// screen reach its work item (syncConversation).
// Run: node tests/conversation-queue-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE conversation_state(key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Open', owner TEXT, follow_up_date TEXT, last_read_at TEXT, updated_at TEXT NOT NULL);`);
const K = 'cust:5';
const stateOf = () => db.prepare('SELECT * FROM conversation_state WHERE key=?').get(K);

// Rules first: nothing is written when a detail is missing
assert.throws(() => W.applyConversationAction(db, K, { action: 'schedule', date: '2026-02-31' }, 'ana@bc.test'), /follow-up date/);
assert.strictEqual(stateOf(), undefined, 'a refused follow-up writes nothing');
assert.throws(() => W.applyConversationAction(db, K, { action: 'wait', waiting_on: '', date: '2026-11-25' }, 'ana@bc.test'), /say what they owe/);
assert.throws(() => W.applyConversationAction(db, K, { action: 'close' }, 'ana@bc.test'), /note saying how it ended/);
assert.throws(() => W.applyConversationAction(db, K, { action: 'reopen' }, 'ana@bc.test'), /not closed|reason/);
assert.throws(() => W.applyConversationAction(db, K, { action: 'delete' }, 'ana@bc.test'), /Unknown conversation action/);
assert.strictEqual(W.convState(db, K), null, 'refused actions leave no work item');

// Assign, follow-up date, waiting on the customer
W.applyConversationAction(db, K, { action: 'assign', assigned_to: 'Ana@bc.test' }, 'owner@bc.test');
assert.strictEqual(stateOf().owner, 'ana@bc.test');
assert.strictEqual(W.convState(db, K).assigned_to, 'ana@bc.test');
W.applyConversationAction(db, K, { action: 'schedule', date: '2026-11-25' }, 'owner@bc.test');
assert.strictEqual(W.convState(db, K).due, '2026-11-25');
assert.strictEqual(stateOf().follow_up_date, '2026-11-25');
W.applyConversationAction(db, K, { action: 'wait', waiting_on: 'Photos of the hallway', date: '2026-11-28' }, 'owner@bc.test');
assert.strictEqual(stateOf().status, 'Waiting on customer');
assert.strictEqual(W.convState(db, K).item_status, 'waiting');
assert.throws(() => W.applyConversationAction(db, K, { action: 'wait', waiting_on: 'again', date: '2026-11-29' }, 'owner@bc.test'), /already waiting/);

// Closing needs a note; the item is finished with that note in its history
const closed = W.applyConversationAction(db, K, { action: 'close', note: 'Booked and paid' }, 'ana@bc.test');
assert.strictEqual(stateOf().status, 'Closed');
assert.strictEqual(W.convState(db, K), null, 'a closed conversation leaves the queue');
assert.strictEqual(closed.status, 'completed');
assert.ok(closed.history.some(h => h.action === 'completed' && h.detail === 'Booked and paid' && h.by === 'ana@bc.test'), 'the close note and who closed it are in the history');
assert.throws(() => W.applyConversationAction(db, K, { action: 'schedule', date: '2026-12-01' }, 'owner@bc.test'), /Reopen it first/, 'a closed conversation takes no new dates until reopened');

// Reopen needs a reason; the item is open again and the record says Open
assert.throws(() => W.applyConversationAction(db, K, { action: 'reopen' }, 'ana@bc.test'), /reason/);
W.applyConversationAction(db, K, { action: 'reopen', reason: 'Customer wrote again' }, 'ana@bc.test');
assert.strictEqual(stateOf().status, 'Open');
assert.strictEqual(W.convState(db, K).item_status, 'open');

// The conversation screen's changes reach the item
db.prepare("UPDATE conversation_state SET owner='ben@bc.test', follow_up_date='2026-12-02' WHERE key=?").run(K);
W.syncConversation(db, K, 'owner@bc.test');
assert.strictEqual(W.convState(db, K).assigned_to, 'ben@bc.test', 'an owner change on the screen moves the item');
assert.strictEqual(W.convState(db, K).due, '2026-12-02', 'a date change on the screen moves the item');
db.prepare("UPDATE conversation_state SET status='Closed' WHERE key=?").run(K);
W.syncConversation(db, K, 'owner@bc.test');
assert.strictEqual(W.convState(db, K), null, 'closing on the screen closes the item');
db.prepare("UPDATE conversation_state SET status='Open' WHERE key=?").run(K);
W.syncConversation(db, K, 'owner@bc.test');
assert.ok(W.convState(db, K) && W.convState(db, K).item_status === 'open', 'reopening on the screen reopens the item');

console.log('All conversation queue checks passed.');
