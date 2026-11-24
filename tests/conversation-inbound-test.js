// Checks that a new customer text or email, or an undelivered text, brings its conversation back to the queue now:
// a closed or waiting conversation reopens and its item is due today, and a reply is never left hidden by an old date.
// Run: node tests/conversation-inbound-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE conversation_state(key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Open', owner TEXT, follow_up_date TEXT, last_read_at TEXT, updated_at TEXT NOT NULL);`);
const K = 'cust:9';
const stateOf = () => db.prepare('SELECT * FROM conversation_state WHERE key=?').get(K);
const itemOf = () => W.convState(db, K);

// A conversation waiting on the customer until 2099 is hidden from today's queue...
W.applyConversationAction(db, K, { action: 'wait', waiting_on: 'Photos', date: '2099-12-01' }, 'ana@bc.test');
assert.strictEqual(itemOf().item_status, 'waiting');
assert.strictEqual(itemOf().due, '2099-12-01');

// ...until the customer replies: it reopens and is due now.
W.conversationNeedsAttention(db, K, 'Customer text');
assert.strictEqual(stateOf().status, 'Open', 'a reply reopens a waiting conversation');
assert.strictEqual(stateOf().follow_up_date, null);
assert.strictEqual(itemOf().item_status, 'in_progress', 'the waiting item is picked back up');
assert.strictEqual(itemOf().due, null, 'the reply is not left on the old date');

// A closed conversation reopens when a new message arrives, with a fresh item that needs attention.
W.applyConversationAction(db, K, { action: 'close', note: 'Booked' }, 'ana@bc.test');
assert.strictEqual(itemOf(), null, 'a closed conversation leaves the queue');
W.conversationNeedsAttention(db, K, 'Outlook inbox');
assert.strictEqual(stateOf().status, 'Open', 'a new message reopens a closed conversation');
assert.ok(itemOf() && ['open', 'in_progress'].includes(itemOf().item_status), 'the reopened conversation is back in the queue');
assert.strictEqual(itemOf().due, null);

// A repeated message on an open conversation changes nothing else.
const before = W.convState(db, K).item_id;
W.conversationNeedsAttention(db, K, 'Customer text');
assert.strictEqual(W.convState(db, K).item_id, before, 'no second item for the same conversation');

// A new conversation with no record gets one item.
const K2 = 'phone:5155550123';
W.conversationNeedsAttention(db, K2, 'Customer text');
assert.ok(W.convState(db, K2), 'a first message creates the conversation item');

console.log('All conversation inbound checks passed.');
